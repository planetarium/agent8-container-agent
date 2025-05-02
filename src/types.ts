import type { Buffer } from "node:buffer";
import type { FSWatcher as NodeFileSystemWatcher } from "node:fs";
import type { Stats } from "node:fs";
import { z } from "zod";
import {
  ContainerProcess,
  ContainerRequest,
  ContainerResponse,
  SpawnOptions
} from "../protocol/src";

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
export interface FileNode {
  file: {
    contents: string;
  };
}

export interface DirectoryNode {
  directory: FileSystemTree;
}

export interface FileSystemTree {
  [name: string]: FileNode | DirectoryNode;
}

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
  type:
    | (typeof FileSystemOperationTypes)[number]
    | (typeof ProcessOperationTypes)[number]
    | (typeof PreviewOperationTypes)[number]
    | (typeof WatchOperationTypes)[number]
    | (typeof AuthOperationTypes)[number];
  id: string;
  operation: ContainerRequest;
}

export type ServerMessage = ServerResponse | ServerEvent;

export interface ServerResponse extends ContainerResponse<unknown> {
  id: string;
}

export interface ServerEvent extends ContainerResponse<unknown> {
  event: "file-change" | "server-ready" | "port" | "preview-message" | "error";
}

export const FileSystemOperationTypes = [
  "readFile",
  "writeFile",
  "rm",
  "readdir",
  "mkdir",
  "stat",
  "mount",
] as const;

export const ProcessOperationTypes = ["spawn", "input", "kill", "resize"] as const;

export const PreviewOperationTypes = ["server-ready", "port", "preview-message"] as const;

export const WatchOperationTypes = ["watch", "watch-paths"] as const;

export const AuthOperationTypes = ["auth", "login", "logout"] as const;

// Bun's FileSystemWatcher type
export interface FileSystemWatcher {
  close(): void;
}

export interface ProxyData {
  targetUrl: string;
  targetSocket?: WebSocket;
}

export interface DirectConnectionData {
  wsId: string;
}
