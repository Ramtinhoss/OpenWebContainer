/**
 * Process states
 */
export enum ProcessState {
    CREATED = 'created',
    RUNNING = 'running',
    COMPLETED = 'completed',
    FAILED = 'failed',
    TERMINATED = 'terminated'
}

/**
 * Process types
 */
export enum ProcessType {
    JAVASCRIPT = 'javascript',
    SHELL = 'shell'
}

export interface ChildProcessPayload {
    executable: string;     // The executable name or path
    args: string[];        // Arguments to pass to the process
    env?: Record<string, string>;  // Additional environment variables
    cwd?: string;         // Working directory for the process
}

export interface ChildProcessResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

export interface ProcessInfo {
    pid: number;
    ppid?: number;
    type: ProcessType;
    state: ProcessState;
    executablePath: string;
    args: string[];
    startTime?: Date;
    endTime?: Date;
    uptime?: number;
}


/**
 * Process events that can be emitted
 */
export enum ProcessEvent {
    START = 'start',
    EXIT = 'exit',
    ERROR = 'error',
    MESSAGE = 'message',
    SPAWN_CHILD = 'spawn_child'  // Generic event for spawning child processes
}

/**
 * Process event listener type
 */
export type ProcessEventListener = (data: any) => void;


export interface ProcessTree {
    info: ProcessInfo;
    children: ProcessTree[];
}

export interface SpawnChildEventData {
    payload: ChildProcessPayload;
    callback: (result: ChildProcessResult) => void;
}
