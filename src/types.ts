import type { Buffer } from "node:buffer";
import type { FSWatcher as NodeFileSystemWatcher } from "node:fs";
import type { Stats } from "node:fs";
import type { Readable } from "node:stream";
import { z } from "zod";

// Event listener types
export type Unsubscribe = () => void;
export type PortListener = (port: number) => void;
export type ServerReadyListener = () => void;
export type PreviewMessageListener = (message: PreviewMessage) => void;
export type ErrorListener = (error: Error) => void;

// Preview message interface
export interface PreviewMessage {
  type: string;
  message?: string;
  stack?: string;
  pathname?: string;
  search?: string;
  hash?: string;
  port?: number;
}

// File system interface
export interface FileSystem {
  readFile(path: string, options?: { encoding?: string }): Promise<string | Buffer>;
  writeFile(path: string, content: string, options?: { encoding?: string }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  stat(path: string): Promise<Stats>;
  watch(pattern: string, options?: { persistent?: boolean }): NodeFileSystemWatcher;
}

// Container process interface
export interface ContainerProcess {
  input: {
    getWriter(): WritableStreamDefaultWriter<string>;
  };
  output: ReadableStream<string>;
  exit: Promise<number>;
  resize(dimensions: { cols: number; rows: number }): void;
}

// Response types
export interface ContainerResponse<T = void> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

export interface ProcessResponse {
  success: boolean;
  pid?: number;
  process?: ContainerProcess;
  stdout?: Readable;
  stderr?: Readable;
  error?: {
    code: string;
    message: string;
  };
}

// Container process options
export interface SpawnOptions {
  env?: Record<string, string>;
}

// Container interface
export interface Container {
  fs: FileSystem;
  workdir: string;
  on(event: "port", listener: PortListener): Unsubscribe;
  on(event: "server-ready", listener: ServerReadyListener): Unsubscribe;
  on(event: "preview-message", listener: PreviewMessageListener): Unsubscribe;
  on(event: "error", listener: ErrorListener): Unsubscribe;
  mount(data: FileSystemTree): Promise<void>;
  spawn(command: string, args?: string[], options?: SpawnOptions): Promise<ContainerProcess>;
  internal: {
    watchPaths(options: WatchOptions, callback: WatchCallback): void;
  };
}

// File system types
export type FileSystemTree = {
  [key: string]: string | FileSystemTree;
};
export type FileSystemResult = string | Buffer | NodeFileSystemWatcher | Stats;

// Watch types
export interface PathWatcherEvent {
  type: "add_file" | "change" | "remove_file" | "add_dir" | "remove_dir" | "update_directory";
  path: string;
  buffer?: Uint8Array;
}

export interface WatchOptions {
  pattern: string;
  persistent?: boolean;
}

export type WatchCallback = (event: PathWatcherEvent) => void;

// Config schema
export const ContainerConfigSchema = z.object({
  port: z.number(),
  workdirName: z.string(),
  coep: z.string(),
  forwardPreviewErrors: z.boolean(),
});

export type ContainerConfigType = z.infer<typeof ContainerConfigSchema>;

// Message types for client-server communication
export interface ClientMessage {
  type: "filesystem" | "terminal" | "preview" | "watch" | "auth";
  messageId: string;
  operation: ContainerRequest;
}

export interface ServerMessage {
  type: string;
  messageId: string;
  response: ContainerResponse<unknown>;
}

// Operation types
export type FileSystemOperation = {
  type:
    | "readFile"
    | "writeFile"
    | "read"
    | "write"
    | "delete"
    | "list"
    | "mkdir"
    | "stat"
    | "watch";
  path: string;
  content?: string;
  options?: {
    recursive?: boolean;
    encoding?: string;
    watchOptions?: {
      persistent?: boolean;
      recursive?: boolean;
      encoding?: string;
    };
  };
};

export type ProcessOperation = {
  type: "spawn" | "input" | "kill" | "resize";
  command?: string;
  args?: string[];
  data?: string;
  input?: string;
  pid?: number;
  cols?: number;
  rows?: number;
};

export type PreviewOperation = {
  type: "server-ready" | "port" | "preview-message";
  data?: {
    port?: number;
    previewId?: string;
    error?: string;
  };
};

export type WatchOperation = {
  type: "watch-paths" | "stop";
  path?: string;
  patterns?: string[];
  options?: {
    recursive?: boolean;
  };
};

export type AuthOperation = {
  type: "auth" | "login" | "logout";
  token?: string;
};

export type ContainerRequest =
  | FileSystemOperation
  | ProcessOperation
  | PreviewOperation
  | WatchOperation
  | AuthOperation;

// Bun's FileSystemWatcher type
export interface FileSystemWatcher {
  close(): void;
}
