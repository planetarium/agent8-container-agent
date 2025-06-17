export interface ProcessInfo {
	pid: number;
	cwd: string;
	cmd: string;
}

export interface CandidatePort {
	host: string;
	port: number;
	detail?: string;
	pid?: number;
}

export interface PortChange {
	added: CandidatePort[];
	removed: CandidatePort[];
	all: CandidatePort[];
}

export interface PortScannerOptions {
	/**
	 * Initial scan interval (milliseconds)
	 * @default 2000
	 */
	scanIntervalMs?: number;

	/**
	 * Monitor only specific ports or port ranges
	 */
	portFilter?: number[] | { min: number; max: number };

	/**
	 * Monitor only specific processes (regex pattern)
	 */
	processFilter?: string | RegExp;

	/**
	 * Processes to exclude (regex pattern)
	 */
	excludeProcesses?: string[] | RegExp[];

	/**
	 * Enable logging
	 * @default false
	 */
	enableLogging?: boolean;
}

export interface PortMonitorEvents {
	/**
	 * Triggered when initial port scan is completed
	 */
	portsInitialized: (ports: CandidatePort[]) => void;

	/**
	 * Triggered when port changes are detected
	 */
	portsChanged: (changes: PortChange) => void;

	/**
	 * Triggered when new port is detected
	 */
	portAdded: (port: CandidatePort) => void;

	/**
	 * Triggered when port is closed
	 */
	portRemoved: (port: CandidatePort) => void;

	/**
	 * Triggered when error occurs during scan
	 */
	error: (error: Error) => void;

	/**
	 * Triggered when scanner starts
	 */
	started: () => void;

	/**
	 * Triggered when scanner stops
	 */
	stopped: () => void;
}
