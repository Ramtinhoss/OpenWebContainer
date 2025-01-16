import { HostRequest } from "process/executors/node/modules/network-module";
import { NodeProcess, Process } from "../process";
import { NetworkStats, ServerStats, ServerType, SocketConnection, VirtualServer } from "./types";


export interface NetworkManagerOptions {
    getProcess: (pid: number) => Process | undefined;
    onServerListen?: (port: number) => void;
    onServerClose?: (port: number) => void;
}

export class NetworkManager {
    private servers: Map<string, VirtualServer> = new Map();
    private serverStats: Map<string, ServerStats> = new Map();
    private connections: Map<string, SocketConnection> = new Map();
    private getProcess: (pid: number) => Process | undefined;
    private onServerListen?: (port: number) => void;
    private onServerClose?: (port: number) => void;
    private requestLog: {
        timestamp: number;
        duration: number;
        serverId: string;
        success: boolean;
        bytesReceived: number;
        bytesSent: number;
    }[] = [];

    // Stats tracking
    private stats = {
        totalRequests: 0,
        failedRequests: 0,
        totalConnections: 0,
        activeConnections: 0,
        totalBytes: { rx: 0, tx: 0 }
    };

    constructor(options: NetworkManagerOptions) {
        this.getProcess = options.getProcess;
        setInterval(() => this.cleanupRequestLog(), 60000); // Every minute
        this.onServerListen = options.onServerListen;
        this.onServerClose = options.onServerClose;
    }

    private cleanupRequestLog(): void {
        const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
        this.requestLog = this.requestLog.filter(log => log.timestamp > fiveMinutesAgo);
    }

    private getServerId(port: number, type: ServerType = 'http'): string {
        return `${type}:${port}`;
    }

    registerServer(pid: number, port: number, type: ServerType, options: VirtualServer['options'] = {}): string {
        const serverId = this.getServerId(port, type);
        if (this.servers.has(serverId)) {
            throw new Error(`${type.toUpperCase()} server on port ${port} is already in use`);
        }

        this.servers.set(serverId, {
            pid,
            port,
            type,
            status: 'running',
            options
        });

        // Initialize stats for this server
        this.serverStats.set(serverId, {
            requestsTotal: 0,
            requestsSuccess: 0,
            requestsFailed: 0,
            bytesReceived: 0,
            bytesSent: 0,
            connections: 0,
            startTime: new Date()
        });
        if(this.onServerListen){
            this.onServerListen(port)
        }
        

        return serverId;
    }

    unregisterServer(port: number, type: ServerType): void {
        const serverId = this.getServerId(port, type);
        this.servers.delete(serverId);
        // Close all connections for this server
        for (const [connId, conn] of this.connections.entries()) {
            if (conn.serverId === serverId) {
                this.connections.delete(connId);
                this.stats.activeConnections--;
                if(this.onServerClose){
                    this.onServerClose(port)
                }
            }
        }
    }

    getServer(port: number, type: ServerType = 'http'): VirtualServer | undefined {
        return this.servers.get(this.getServerId(port, type));
    }
    // Log a request completion
    private logRequest(serverId: string, duration: number, success: boolean, bytesReceived: number, bytesSent: number): void {
        this.requestLog.push({
            timestamp: Date.now(),
            duration,
            serverId,
            success,
            bytesReceived,
            bytesSent
        });

        // Update server stats
        const stats = this.serverStats.get(serverId);
        if (stats) {
            stats.requestsTotal++;
            if (success) {
                stats.requestsSuccess++;
            } else {
                stats.requestsFailed++;
            }
            stats.bytesReceived += bytesReceived;
            stats.bytesSent += bytesSent;
        }
    }

    getNetworkStats(): NetworkStats {
        const now = Date.now();
        const oneMinuteAgo = now - 60000;

        // Calculate requests per minute
        const recentRequests = this.requestLog.filter(log => log.timestamp > oneMinuteAgo);
        const requestsPerMinute = recentRequests.length;

        // Calculate traffic stats
        const traffic = this.requestLog.reduce((acc, log) => ({
            bytesReceived: acc.bytesReceived + log.bytesReceived,
            bytesSent: acc.bytesSent + log.bytesSent,
            requestsTotal: acc.requestsTotal + 1,
            requestsSuccess: acc.requestsSuccess + (log.success ? 1 : 0),
            requestsFailed: acc.requestsFailed + (log.success ? 0 : 1),
            totalDuration: acc.totalDuration + log.duration
        }), {
            bytesReceived: 0,
            bytesSent: 0,
            requestsTotal: 0,
            requestsSuccess: 0,
            requestsFailed: 0,
            totalDuration: 0
        });

        // Count servers by type
        const serversByType = Array.from(this.servers.values()).reduce((acc, server) => {
            acc[server.type] = (acc[server.type] || 0) + 1;
            return acc;
        }, {} as Record<ServerType, number>);

        // Count connections by server
        const connectionsByServer = Array.from(this.serverStats.entries()).reduce((acc, [serverId, stats]) => {
            acc[serverId] = stats.connections;
            return acc;
        }, {} as Record<string, number>);

        return {
            servers: {
                total: this.servers.size,
                active: Array.from(this.servers.values()).filter(s => s.status === 'running').length,
                byType: serversByType
            },
            connections: {
                total: Array.from(this.serverStats.values()).reduce((sum, stats) => sum + stats.connections, 0),
                active: Array.from(this.serverStats.values()).reduce((sum, stats) => sum + stats.connections, 0),
                byServer: connectionsByServer
            },
            traffic: {
                bytesReceived: traffic.bytesReceived,
                bytesSent: traffic.bytesSent,
                requestsTotal: traffic.requestsTotal,
                requestsSuccess: traffic.requestsSuccess,
                requestsFailed: traffic.requestsFailed,
                avgResponseTime: traffic.requestsTotal > 0 ?
                    traffic.totalDuration / traffic.requestsTotal : 0
            },
            requestsPerMinute
        };
    }

    listServers(): VirtualServer[] {
        return Array.from(this.servers.values()).map(server => ({
            ...server,
            stats: this.serverStats.get(this.getServerId(server.port, server.type))
        }));
    }

    async handleRequest(request: HostRequest, port: number): Promise<Response> {
        const server = this.getServer(port, 'http');
        if (!server || server.status !== 'running') {
            return new Response('Service Unavailable', { status: 503 });
        }

        const process = this.getProcess(server.pid);
        if (!process || !(process instanceof NodeProcess)) {
            return new Response('Internal Server Error', { status: 500 });
        }
        if(!request.url){
            request.url=request.path||"/"
        }

        //// network statistics start
        const serverId = this.getServerId(port);
        const startTime = Date.now();
        let bytesReceived = 0;
        let bytesSent = 0;

        // Calculate request size
        bytesReceived += request.url.length;
        Object.entries(request.headers||{}).forEach(([key, value]) => {
            bytesReceived += key.length + value.length;
        });
        if (request.body) {
            const body =request.body; 
            bytesReceived += body.length;
        }

        //// network statistics end

        try {

            // actual request handling
            this.stats.totalRequests++;
            let headers:Record<string,string>={}
            const response = await process.handleHttpRequest({
                port: port,
                path: request.path,
                url: request.url,
                method: request.method,
                headers: request.headers,
                body: request.body
            });


            //// network statistics start
            // Calculate response size
            response.headers.forEach((value, key) => {
                bytesSent += key.length + value.length;
            });
            const responseBody = await response.clone().text();
            bytesSent += responseBody.length;

            // Log successful request
            this.logRequest(
                serverId,
                Date.now() - startTime,
                response.ok,
                bytesReceived,
                bytesSent
            );
            //// network statistics end
            return response;

        } catch (error) {
            this.stats.failedRequests++;
            // Log failed request
            this.logRequest(
                serverId,
                Date.now() - startTime,
                false,
                bytesReceived,
                0
            );
            return new Response(error instanceof Error ? error.message : 'Internal Server Error',
                { status: 500 });
        }
    }

    createConnection(serverId: string, remotePort: number): string {
        const id = Math.random().toString(36).substr(2, 9);
        const server = this.servers.get(serverId);
        if (!server) {
            throw new Error('Server not found');
        }

        this.connections.set(id, {
            id,
            serverId,
            remoteAddress: '127.0.0.1',
            remotePort,
            localAddress: '127.0.0.1',
            localPort: server.port
        });

        this.stats.totalConnections++;
        this.stats.activeConnections++;

        return id;
    }

    closeConnection(connectionId: string): void {
        if (this.connections.delete(connectionId)) {
            this.stats.activeConnections--;
        }
    }

    dispose(): void {
        this.servers.clear();
        this.connections.clear();
    }
}
