// Export main module
export { PortScanner } from './portScanner';

// Export types
export type {
	CandidatePort,
	ProcessInfo,
	PortChange,
	PortScannerOptions,
	PortMonitorEvents
} from './types';

// Expose utility functions
export { detectListeningPorts } from './utils/platform';
