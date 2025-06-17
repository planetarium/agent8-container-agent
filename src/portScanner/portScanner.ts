import { EventEmitter } from 'eventemitter3';
import { CandidatePort, PortMonitorEvents, PortScannerOptions } from './types';
import { detectListeningPorts, MovingAverage } from './utils/platform';

export class PortScanner extends EventEmitter<PortMonitorEvents> {
	private lastFoundPorts: CandidatePort[] = [];
	private isScanning = false;
	private interval: NodeJS.Timeout | null = null;
	private scanDelay: number;
	private movingAverage = new MovingAverage();
	private options: {
		scanIntervalMs: number;
		portFilter: number[] | { min: number; max: number } | undefined;
		processFilter: string | RegExp | undefined;
		excludeProcesses: string[] | RegExp[];
		enableLogging: boolean;
	};

	constructor(options: PortScannerOptions = {}) {
		super();

		// Set default options
		this.options = {
			scanIntervalMs: options.scanIntervalMs ?? 2000,
			portFilter: options.portFilter,
			processFilter: options.processFilter,
			excludeProcesses: options.excludeProcesses ?? [],
			enableLogging: options.enableLogging ?? false
		};

		this.scanDelay = this.options.scanIntervalMs;
	}

	/**
	 * Start port scanning
	 */
	async start(): Promise<void> {
		if (this.isScanning) return;

		this.isScanning = true;

		try {
			// Initial port scan
			this.lastFoundPorts = await this.findAndFilterPorts();
			this.emit('portsInitialized', this.lastFoundPorts);
			this.emit('started');

			let scanCount = 0;

			const scanPorts = async () => {
				if (!this.isScanning) return;

				try {
					const startTime = Date.now();
					const newPorts = await this.findAndFilterPorts();
					const timeTaken = Date.now() - startTime;

					// Exclude the first few scans from the average (initialization takes longer)
					if (scanCount++ > 3) {
						this.movingAverage.update(timeTaken);
					}

					// Detect changes and emit events
					this.detectChanges(newPorts);

					// Calculate next scan time - dynamically adjust based on scan duration
					this.scanDelay = this.calculateDelay(this.movingAverage.value);

					if (this.options.enableLogging) {
						console.log(`[port-monitor] Scan completed in ${timeTaken}ms. Next scan in ${this.scanDelay}ms`);
					}

					this.interval = setTimeout(scanPorts, this.scanDelay);
				} catch (error) {
					this.emit('error', error instanceof Error ? error : new Error(String(error)));
					this.interval = setTimeout(scanPorts, this.scanDelay);
				}
			};

			this.interval = setTimeout(scanPorts, this.scanDelay);
		} catch (error) {
			this.emit('error', error instanceof Error ? error : new Error(String(error)));
			this.isScanning = false;
		}
	}

	/**
	 * Stop port scanning
	 */
	stop(): void {
		if (!this.isScanning) return;

		this.isScanning = false;
		if (this.interval) {
			clearTimeout(this.interval);
			this.interval = null;
		}

		this.emit('stopped');
	}

	/**
	 * Return list of currently monitored ports
	 */
	getCurrentPorts(): CandidatePort[] {
		return [...this.lastFoundPorts];
	}

	/**
	 * Execute immediate port scan (manual)
	 */
	async scanNow(): Promise<CandidatePort[]> {
		const ports = await this.findAndFilterPorts();

		// Process change detection only when scanning
		if (this.isScanning) {
			this.detectChanges(ports);
		}

		return ports;
	}

	/**
	 * Update options
	 */
	updateOptions(newOptions: Partial<PortScannerOptions>): void {
		this.options = {
			...this.options,
			...newOptions
		};

		if (newOptions.scanIntervalMs !== undefined) {
			this.scanDelay = newOptions.scanIntervalMs;
		}
	}

	/**
	 * Return port list with filters applied
	 */
	private async findAndFilterPorts(): Promise<CandidatePort[]> {
		const allPorts = await detectListeningPorts();
		return this.applyFilters(allPorts);
	}

	/**
	 * Apply filters
	 */
	private applyFilters(ports: CandidatePort[]): CandidatePort[] {
		let filtered = [...ports];

		// Apply port filter
		if (this.options.portFilter) {
			filtered = filtered.filter(port => {
				if (Array.isArray(this.options.portFilter)) {
					return (this.options.portFilter as number[]).includes(port.port);
				} else if (this.options.portFilter) {
					const range = this.options.portFilter as { min: number; max: number };
					return port.port >= range.min && port.port <= range.max;
				}
				return true;
			});
		}

		// Apply process filter
		if (this.options.processFilter) {
			const filter = this.options.processFilter;
			const regex = typeof filter === 'string' ? new RegExp(filter) : filter;

			filtered = filtered.filter(port => {
				return port.detail && regex.test(port.detail);
			});
		}

		// Apply exclude process filter
		if (this.options.excludeProcesses && this.options.excludeProcesses.length > 0) {
			filtered = filtered.filter(port => {
				if (!port.detail) return true;

				const exclude = this.options.excludeProcesses as (string[] | RegExp[]);

				// Check regex or string patterns
				return !exclude.some(pattern => {
					if (typeof pattern === 'string') {
						return port.detail?.includes(pattern);
					} else {
						return pattern.test(port.detail || '');
					}
				});
			});
		}

		return filtered;
	}

	/**
	 * Detect changes and emit events
	 */
	private detectChanges(newPorts: CandidatePort[]): void {
		// Compare previous list with new list
		if (JSON.stringify(this.lastFoundPorts) !== JSON.stringify(newPorts)) {
			// Find changed ports
			const added = newPorts.filter(
				newPort => !this.lastFoundPorts.some(
					oldPort => oldPort.port === newPort.port && oldPort.host === newPort.host
				)
			);

			const removed = this.lastFoundPorts.filter(
				oldPort => !newPorts.some(
					newPort => oldPort.port === newPort.port && oldPort.host === newPort.host
				)
			);

			// Individual port events
			for (const port of added) {
				this.emit('portAdded', port);
			}

			for (const port of removed) {
				this.emit('portRemoved', port);
			}

			// Unified change event
			if (added.length > 0 || removed.length > 0) {
				this.emit('portsChanged', { added, removed, all: newPorts });
			}

			// Update port list
			this.lastFoundPorts = newPorts;
		}
	}

	/**
	 * Calculate next scan interval
	 */
	private calculateDelay(movingAverage: number): number {
		// Use the larger value between 20 times the scan time and minimum interval
		return Math.max(movingAverage * 20, this.options.scanIntervalMs);
	}
}
