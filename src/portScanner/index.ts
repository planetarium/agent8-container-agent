// 메인 모듈 내보내기
export { PortScanner } from "./portScanner.ts";

// 타입 내보내기
export type {
  CandidatePort,
  ProcessInfo,
  PortChange,
  PortScannerOptions,
  PortMonitorEvents,
} from "./types.ts";

// 유틸리티 함수 노출
export { detectListeningPorts } from "./utils/platform.ts";
