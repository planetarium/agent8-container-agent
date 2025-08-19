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
   * 초기 스캔 간격 (밀리초)
   * @default 2000
   */
  scanIntervalMs?: number;

  /**
   * 특정 포트나 포트 범위만 모니터링
   */
  portFilter?: number[] | { min: number; max: number };

  /**
   * 특정 프로세스만 모니터링 (정규식 패턴)
   */
  processFilter?: string | RegExp;

  /**
   * 제외할 프로세스 (정규식 패턴)
   */
  excludeProcesses?: string[] | RegExp[];

  /**
   * 로깅 활성화
   * @default false
   */
  enableLogging?: boolean;
}

export interface PortMonitorEvents {
  /**
   * 초기 포트 스캔 완료 시 발생
   */
  portsInitialized: (ports: CandidatePort[]) => void;

  /**
   * 포트 변경 감지 시 발생
   */
  portsChanged: (changes: PortChange) => void;

  /**
   * 새 포트 감지 시 발생
   */
  portAdded: (port: CandidatePort) => void;

  /**
   * 포트 종료 시 발생
   */
  portRemoved: (port: CandidatePort) => void;

  /**
   * 스캔 중 에러 발생 시
   */
  error: (error: Error) => void;

  /**
   * 스캐너 시작 시
   */
  started: () => void;

  /**
   * 스캐너 종료 시
   */
  stopped: () => void;
}
