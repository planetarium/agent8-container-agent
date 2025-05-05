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

		// 기본 옵션 설정
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
	 * 포트 스캐닝 시작
	 */
	async start(): Promise<void> {
		if (this.isScanning) return;

		this.isScanning = true;

		try {
			// 초기 포트 스캔
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

					// 처음 몇 번의 스캔은 평균에서 제외 (초기화 시간이 더 오래 걸림)
					if (scanCount++ > 3) {
						this.movingAverage.update(timeTaken);
					}

					// 변경점 감지 및 이벤트 발생
					this.detectChanges(newPorts);

					// 다음 스캔 시간 계산 - 스캔 소요 시간에 따라 동적 조정
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
	 * 포트 스캐닝 중지
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
	 * 현재 모니터링 중인 포트 목록 반환
	 */
	getCurrentPorts(): CandidatePort[] {
		return [...this.lastFoundPorts];
	}

	/**
	 * 즉시 포트 스캔 실행 (수동)
	 */
	async scanNow(): Promise<CandidatePort[]> {
		const ports = await this.findAndFilterPorts();

		// 스캐닝 중인 경우만 변경점 감지 처리
		if (this.isScanning) {
			this.detectChanges(ports);
		}

		return ports;
	}

	/**
	 * 옵션 업데이트
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
	 * 필터 적용하여 포트 목록 반환
	 */
	private async findAndFilterPorts(): Promise<CandidatePort[]> {
		const allPorts = await detectListeningPorts();
		return this.applyFilters(allPorts);
	}

	/**
	 * 필터 적용
	 */
	private applyFilters(ports: CandidatePort[]): CandidatePort[] {
		let filtered = [...ports];

		// 포트 필터 적용
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

		// 프로세스 필터 적용
		if (this.options.processFilter) {
			const filter = this.options.processFilter;
			const regex = typeof filter === 'string' ? new RegExp(filter) : filter;

			filtered = filtered.filter(port => {
				return port.detail && regex.test(port.detail);
			});
		}

		// 제외 프로세스 필터 적용
		if (this.options.excludeProcesses && this.options.excludeProcesses.length > 0) {
			filtered = filtered.filter(port => {
				if (!port.detail) return true;

				const exclude = this.options.excludeProcesses as (string[] | RegExp[]);

				// 정규식 또는 문자열 패턴 확인
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
	 * 변경점 감지 및 이벤트 발생
	 */
	private detectChanges(newPorts: CandidatePort[]): void {
		// 이전 목록과 새 목록 비교
		if (JSON.stringify(this.lastFoundPorts) !== JSON.stringify(newPorts)) {
			// 변경된 포트 찾기
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

			// 개별 포트 이벤트
			for (const port of added) {
				this.emit('portAdded', port);
			}

			for (const port of removed) {
				this.emit('portRemoved', port);
			}

			// 통합 변경 이벤트
			if (added.length > 0 || removed.length > 0) {
				this.emit('portsChanged', { added, removed, all: newPorts });
			}

			// 포트 목록 업데이트
			this.lastFoundPorts = newPorts;
		}
	}

	/**
	 * 다음 스캔 간격 계산
	 */
	private calculateDelay(movingAverage: number): number {
		// 스캔 시간의 20배와 최소 간격 중 큰 값 사용
		return Math.max(movingAverage * 20, this.options.scanIntervalMs);
	}
}
