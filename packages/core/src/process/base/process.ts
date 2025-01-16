// process/base/process.ts
import { BrowserEventEmitter } from "./event-emmiter";
import { ChildProcessResult, ProcessEvent, ProcessState, ProcessType, SpawnChildEventData } from "./types";

export interface ProcessStats {
    pid: number;
    ppid?: number;
    type: ProcessType;
    state: ProcessState;
    exitCode: number | null;
    executablePath: string;
    args: string[];
    startTime?: Date;
    endTime?: Date;
}

/**
 * Base Process class that all process types extend
 */
export abstract class Process extends BrowserEventEmitter {
    readonly pid: number;
    readonly type: ProcessType;
    protected _state: ProcessState;
    protected _exitCode: number | null;
    protected env: Map<string, string> = new Map();
    readonly executablePath: string;
    readonly args: string[];
    readonly parentPid?: number|undefined;
    readonly cwd?: string;

    private inputBuffer: string[] = [];
    private inputCallbacks: ((input: string) => void)[] = [];
    private startTime?: Date;
    private endTime?: Date;
    private terminated: boolean = false;

    constructor(
        pid: number,
        type: ProcessType,
        executablePath: string,
        args: string[] = [],
        parentPid?: number,
        cwd?: string,
        env?: Map<string, string>
    ) {
        super();
        this.pid = pid;
        this.type = type;
        this._state = ProcessState.CREATED;
        this._exitCode = null;
        this.executablePath = executablePath;
        this.args = args;
        this.parentPid = parentPid;
        this.cwd = cwd||'/';
        this.env = env || new Map([
            ['PATH', '/bin:/usr/bin'],
            ['HOME', '/home'],
            ['PWD', cwd||'/'],
        ]);


        // Set max listeners to avoid memory leaks
        this.setMaxListeners(100);
    }

    /**
     * Process state getters
     */
    get state(): ProcessState {
        return this._state;
    }

    get exitCode(): number | null {
        return this._exitCode;
    }

    get uptime(): number | null {
        if (!this.startTime) return null;
        const endTime = this.endTime || new Date();
        return endTime.getTime() - this.startTime.getTime();
    }

    /**
     * Get process statistics
     */
    getStats(): ProcessStats {
        return {
            pid: this.pid,
            ppid: this.parentPid,
            type: this.type,
            state: this._state,
            exitCode: this._exitCode,
            executablePath: this.executablePath,
            args: this.args,
            startTime: this.startTime,
            endTime: this.endTime
        };
    }

    /**
     * Process input handling
     */
    writeInput(input: string): void {
        if (this._state !== ProcessState.RUNNING) {
            throw new Error('Cannot write input to non-running process');
        }

        this.inputBuffer.push(input);
        this.processNextInput();
    }

    protected async readInput(): Promise<string> {
        // If there's input in the buffer, return it immediately
        if (this.inputBuffer.length > 0) {
            return this.inputBuffer.shift()!;
        }

        // Otherwise, wait for input
        return new Promise((resolve) => {
            this.inputCallbacks.push(resolve);
        });
    }

    private processNextInput(): void {
        while (this.inputCallbacks.length > 0 && this.inputBuffer.length > 0) {
            const callback = this.inputCallbacks.shift()!;
            const input = this.inputBuffer.shift()!;
            callback(input);
        }
    }

    /**
     * Process lifecycle methods
     */
    async start(): Promise<void> {
        try {
            if (this.state !== ProcessState.CREATED) {
                throw new Error(`Cannot start process in state: ${this.state}`);
            }

            this._state = ProcessState.RUNNING;
            this.startTime = new Date();
            this.emit(ProcessEvent.START, { pid: this.pid });

            await this.execute();

            if (!this.terminated) {
                this._state = ProcessState.COMPLETED;
                this._exitCode = 0;
            }
        } catch (error: any) {
            this._state = ProcessState.FAILED;
            this._exitCode = 1;
            this.emit(ProcessEvent.ERROR, { pid: this.pid, error });
        } finally {
            this.endTime = new Date();
            this.emit(ProcessEvent.EXIT, {
                pid: this.pid,
                exitCode: this._exitCode,
                uptime: this.uptime
            });
        }
    }

    async terminate(): Promise<void> {
        if (this.state !== ProcessState.RUNNING) {
            return;
        }

        this.terminated = true;
        this._state = ProcessState.TERMINATED;
        this._exitCode = -1;
        this.endTime = new Date();

        await this.onTerminate();

        this.emit(ProcessEvent.EXIT, {
            pid: this.pid,
            exitCode: this._exitCode,
            uptime: this.uptime
        });
    }

    /**
     * Protected methods to be implemented by specific process types
     */
    protected abstract execute(): Promise<void>;

    protected async onTerminate(): Promise<void> {
        // Default implementation, can be overridden by specific process types
    }

    /**
     * Helper methods for child processes
     */
    protected async spawnChild(
        executable: string,
        args: string[] = [],
        env: Record<string, string> = {}
    ): Promise<ChildProcessResult> {
        return new Promise((resolve) => {
            this.emit(ProcessEvent.SPAWN_CHILD, {
                payload: {
                    executable,
                    args,
                    env
                },
                callback: resolve
            });
        });
    }

    /**
     * Helper methods for process output
     */
    protected emitOutput(stdout: string): void {
        this.emit(ProcessEvent.MESSAGE, { stdout });
    }

    protected emitError(stderr: string): void {
        this.emit(ProcessEvent.MESSAGE, { stderr });
    }

    protected emitMessage(message: { stdout?: string; stderr?: string }): void {
        this.emit(ProcessEvent.MESSAGE, message);
    }

    /**
     * Event listener management with type safety
     */
    addEventListener(event: ProcessEvent.START, listener: (data: { pid: number }) => void): void;
    addEventListener(event: ProcessEvent.EXIT, listener: (data: { pid: number; exitCode: number | null; uptime: number | null }) => void): void;
    addEventListener(event: ProcessEvent.ERROR, listener: (data: { pid: number; error: Error }) => void): void;
    addEventListener(event: ProcessEvent.MESSAGE, listener: (data: { stdout?: string; stderr?: string }) => void): void;
    addEventListener(event: ProcessEvent.SPAWN_CHILD, listener: (data: SpawnChildEventData) => void): void;
    
    addEventListener(event: ProcessEvent, listener: (data: any) => void): void {
        this.on(event, listener);
    }

    removeEventListener(event: ProcessEvent, listener: (data: any) => void): void {
        this.off(event, listener);
    }
}
