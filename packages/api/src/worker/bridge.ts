import type {
    WorkerMessage,
    WorkerResponse,
    WorkerInitOptions
} from './types';

export interface MessageHandler {
    (message: Omit<WorkerResponse, "id">): void;
}

interface PendingRequest {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timeout: number;
}
import workerCode from '@open-web-container/core/worker-code';

export class WorkerBridge {
    private worker: Worker|undefined;
    private messageHandlers: Set<MessageHandler> = new Set();
    private pendingRequests: Map<string, PendingRequest> = new Map();
    private nextRequestId: number = 0;
    private initialized: boolean = false;
    private defaultTimeout: number = 30000;

    constructor() {
        if (typeof Worker === 'undefined') {
            throw new Error('Web Workers are not supported in this environment');
        }
    }
    async initialize(options: WorkerInitOptions): Promise<void> {
        if (this.initialized) {
            throw new Error('Worker already initialized');
        }
        await this.boot();

        await this.sendMessage({
            type: 'initialize',
            payload: options
        });

        this.initialized = true;
    }

    async sendMessage(
        message: WorkerMessage,
        timeout: number = this.defaultTimeout
    ): Promise<any> {
        if (!this.worker) {
            throw new Error('Worker not initialized');
        }

        const id = (this.nextRequestId++).toString();

        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Request timeout after ${timeout}ms`));
            }, timeout);

            this.pendingRequests.set(id, {
                resolve,
                reject,
                timeout: timeoutId
            });

            try {

                this.worker?.postMessage({ ...message, id });
            } catch (error) {
                clearTimeout(timeoutId);
                this.pendingRequests.delete(id);
                reject(error);
            }
        });
    }

    onMessage(handler: MessageHandler): () => void {
        this.messageHandlers.add(handler);
        return () => {
            this.messageHandlers.delete(handler);
        };
    }

    async dispose(): Promise<void> {
        for (const [id, request] of this.pendingRequests.entries()) {
            clearTimeout(request.timeout);
            request.reject(new Error('Worker disposed'));
            this.pendingRequests.delete(id);
        }

        this.messageHandlers.clear();

        if (this.worker) {
            try {
                await this.sendMessage({
                    type: 'dispose'
                }).catch(() => { });
            } finally {
                this.worker.terminate();
            }
        }
    }

    isInitialized(): boolean {
        return this.initialized;
    }

    setDefaultTimeout(timeout: number): void {
        this.defaultTimeout = timeout;
    }

    // Helper functions
    private async boot() {
        try {
            // Import the worker code
            

            // Create and initialize worker
            const blob = new Blob([workerCode], { type: 'text/javascript' });
            this.worker = new Worker(URL.createObjectURL(blob));

            // Set up message handling
            this.setupMessageHandler();
        } catch (error) {
            console.error('Failed to initialize worker:', error);
            throw error;
        }
    }

    private setupMessageHandler(): void {
        if (!this.worker) {
            throw new Error('Worker not initialized');
        }
        this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
            const { type, id, payload } = event.data;

            let error = undefined;
            if (type === 'error') {
                error = event.data.payload.error;
            }
            // Handle request responses
            if (id && this.pendingRequests.has(id)) {
                const request = this.pendingRequests.get(id)!;
                clearTimeout(request.timeout);
                this.pendingRequests.delete(id);

                if (error) {
                    request.reject(new Error(error));
                } else {
                    request.resolve(payload);
                }
                return;
            }

            // Handle broadcast messages
            this.messageHandlers.forEach(handler => {
                try {
                    handler(event.data);
                } catch (error) {
                    console.error('Error in message handler:', error);
                }
            });
        };

        this.worker.onerror = (error) => {
            console.error('Worker error:', error);
            this.broadcastError('Worker error: ' + error.message);
        };
    }

    private broadcastError(error: string): void {
        const errorMessage: Omit<WorkerResponse, "id"> = {
            type: 'error',
            payload: { error }
        };

        this.messageHandlers.forEach(handler => {
            try {
                handler(errorMessage);
            } catch (e) {
                console.error('Error in error handler:', e);
            }
        });
    }
}