/**
 * Types for the PTY service
 */

export interface PtyOptions {
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface ResizeOptions {
  cols: number;
  rows: number;
}

export interface ExitStatus {
  exitCode: number;
}
