import * as fs from 'fs/promises';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import { CandidatePort, ProcessInfo } from '../types';
import { parseIpAddress, parseLinuxSocketInfo, parseNetworkTables, parseWindowsNetstat } from './parsing';

const exec = promisify(execCb);

/**
 * 실행 중인 프로세스 정보 수집
 */
export async function collectProcessInfo(): Promise<ProcessInfo[]> {
	const platform = os.platform();

	if (platform === 'win32') {
		return collectWindowsProcessInfo();
	} else if (platform === 'darwin') {
		return collectMacOSProcessInfo();
	} else {
		return collectLinuxProcessInfo();
	}
}

async function collectLinuxProcessInfo(): Promise<ProcessInfo[]> {
	const processes: ProcessInfo[] = [];
	try {
		const procChildren = await fs.readdir('/proc');

		for (const childName of procChildren) {
			try {
				const pid = Number(childName);
				if (isNaN(pid)) continue;

				const stat = await fs.stat(`/proc/${childName}`);
				if (stat.isDirectory()) {
					try {
						const cwd = await fs.readlink(`/proc/${childName}/cwd`);
						const cmd = await fs.readFile(`/proc/${childName}/cmdline`, 'utf8');
						processes.push({ pid, cwd, cmd: cmd.replace(/\0/g, ' ').trim() });
					} catch (e) {
						// 일부 프로세스의 정보를 읽을 수 없음 (권한 등의 문제)
					}
				}
			} catch (e) {
				// 디렉토리 읽기 오류
			}
		}
	} catch (e) {
		// /proc 접근 불가
		console.error('Error accessing /proc:', e);
	}

	return processes;
}

async function collectMacOSProcessInfo(): Promise<ProcessInfo[]> {
	try {
		const { stdout } = await exec('ps -eo pid,command -ww');
		const lines = stdout.split('\n').slice(1); // 헤더 제거
		const processes: ProcessInfo[] = [];

		for (const line of lines) {
			const match = line.trim().match(/^\s*(\d+)\s+(.+)$/);
			if (match) {
				const [, pidStr, cmd] = match;
				const pid = parseInt(pidStr, 10);
				if (!isNaN(pid)) {
					processes.push({
						pid,
						cmd: cmd.trim(),
						cwd: '' // MacOS에서는 간단히 작업 디렉토리를 가져올 수 없음
					});
				}
			}
		}

		return processes;
	} catch (e) {
		console.error('Error getting macOS process info:', e);
		return [];
	}
}

async function collectWindowsProcessInfo(): Promise<ProcessInfo[]> {
	try {
		const { stdout } = await exec('wmic process get processid,commandline,executablepath');
		const lines = stdout.split('\n').slice(1); // 헤더 제거
		const processes: ProcessInfo[] = [];

		for (const line of lines) {
			const match = line.trim().match(/^(.+?)\s+(\d+)$/);
			if (match) {
				const [, cmdLine, pidStr] = match;
				const pid = parseInt(pidStr, 10);
				if (!isNaN(pid)) {
					processes.push({
						pid,
						cmd: cmdLine.trim(),
						cwd: '' // Windows에서는 현재 작업 디렉토리를 쉽게 가져올 수 없음
					});
				}
			}
		}

		return processes;
	} catch (e) {
		console.error('Error getting Windows process info:', e);
		return [];
	}
}

/**
 * 리스닝 중인 포트 감지 (플랫폼별)
 */
export async function detectListeningPorts(): Promise<CandidatePort[]> {
	const platform = os.platform();

	if (platform === 'win32') {
		return detectWindowsPorts();
	} else if (platform === 'darwin') {
		return detectMacOSPorts();
	} else {
		return detectLinuxPorts();
	}
}

async function detectLinuxPorts(): Promise<CandidatePort[]> {
	try {
		// TCP 연결 정보 읽기
		let tcp = '';
		let tcp6 = '';

		try {
			tcp = await fs.readFile('/proc/net/tcp', 'utf8');
			tcp6 = await fs.readFile('/proc/net/tcp6', 'utf8');
		} catch (e) {
			// 파일 읽기 오류
		}

		const connections = parseNetworkTables(tcp, tcp6);

		// 소켓-프로세스 매핑 가져오기
		const { stdout: procSockets } = await exec('ls -l /proc/[0-9]*/fd/[0-9]* | grep socket:');
		const socketMap = parseLinuxSocketInfo(procSockets);

		// 프로세스 정보 수집
		const processes = await collectLinuxProcessInfo();

		// 프로세스별 매핑
		const processMap = processes.reduce((m: Record<string, ProcessInfo>, process) => {
			m[process.pid] = process;
			return m;
		}, {});

		// 필터링된 연결만 사용
		const ports: CandidatePort[] = [];

		for (const { socket, ip, port } of connections) {
			const pidInfo = socketMap[socket];
			if (!pidInfo) continue;

			const pid = pidInfo.pid;
			const processInfo = processMap[pid];

			if (processInfo) {
				ports.push({
					host: ip,
					port,
					detail: processInfo.cmd,
					pid
				});
			}
		}

		return ports;
	} catch (error) {
		console.error('Error detecting Linux ports:', error);
		return [];
	}
}

async function detectMacOSPorts(): Promise<CandidatePort[]> {
	try {
		// 맥OS에서는 lsof로 포트 정보 수집
		const { stdout } = await exec('lsof -iTCP -sTCP:LISTEN -n -P');
		const lines = stdout.split('\n').slice(1); // 헤더 제거
		const ports: CandidatePort[] = [];

		for (const line of lines) {
			if (!line.trim()) continue;

			const parts = line.trim().split(/\s+/);
			if (parts.length < 9) continue;

			// COMMAND  PID     USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
			// node    1234 username   12u  IPv6 0x95312341238      0t0  TCP *:3000 (LISTEN)

			const command = parts[0];
			const pid = parseInt(parts[1], 10);
			const addressInfo = parts[8]; // 예: *:3000, 127.0.0.1:8080 등

			const addressMatch = addressInfo.match(/^(.+?):(\d+)/);
			if (addressMatch) {
				const host = addressMatch[1] === '*' ? 'localhost' : addressMatch[1];
				const port = parseInt(addressMatch[2], 10);

				if (!isNaN(port) && !isNaN(pid)) {
					ports.push({
						host,
						port,
						pid,
						detail: command
					});
				}
			}
		}

		return ports;
	} catch (error) {
		console.error('Error detecting macOS ports:', error);
		return [];
	}
}

async function detectWindowsPorts(): Promise<CandidatePort[]> {
	try {
		const { stdout } = await exec('netstat -ano');
		const rawPorts = parseWindowsNetstat(stdout);

		// 프로세스 정보 수집
		const processes = await collectWindowsProcessInfo();
		const processMap = processes.reduce((m: Record<number, ProcessInfo>, process) => {
			m[process.pid] = process;
			return m;
		}, {});

		// 포트 정보 보강
		return rawPorts.map(port => ({
			...port,
			detail: port.pid ? processMap[port.pid]?.cmd : undefined
		}));
	} catch (error) {
		console.error('Error detecting Windows ports:', error);
		return [];
	}
}

// 이동 평균 계산 유틸리티
export class MovingAverage {
	private values: number[] = [];
	private maxValues = 5;

	update(value: number): void {
		this.values.push(value);
		if (this.values.length > this.maxValues) {
			this.values.shift();
		}
	}


	get value(): number {
		if (this.values.length === 0) return 0;
		return this.values.reduce((sum, val) => sum + val, 0) / this.values.length;
	}
}
