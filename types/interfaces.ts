export interface Terminal {
  readonly cols?: number;
  readonly rows?: number;

  reset: () => void;
  write: (data: string) => void;
  onData: (cb: (data: string) => void) => void;
  input: (data: string) => void;
}

/**
 * File system related types and interfaces
 */

export type Unsubscribe = () => void;
export type PortListener = (port: number, type: string, url: string) => void;
export type ServerReadyListener = (port: number, url: string) => void;
export type PreviewMessageListener = (message: PreviewMessage) => void;
export type ErrorListener = (error: Error) => void;

export interface FileEntry {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface FileSystemWatcher {
  addEventListener(event: string, listener: (event: PathWatcherEvent) => void): void;
  close(): void;
}

/**
 * File node interfaces for file system tree structure
 */
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

export interface FileSystem {
  readFile(path: string): Promise<Uint8Array>;
  readFile(path: string, encoding?: string): Promise<string>;
  writeFile(
    path: string,
    content: string | Uint8Array,
    options?: { encoding?: string },
  ): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string, options?: { withFileTypes?: boolean }): Promise<FileEntry[]>;
  rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void>;
  watch(pattern: string, options?: { persistent?: boolean }): FileSystemWatcher;
  watchPaths(options: WatchPathsOptions, callback: (events: PathWatcherEvent[]) => void): void;
}

/**
 * Process related interfaces
 */
export interface ContainerProcess {
  input: {
    getWriter(): WritableStreamDefaultWriter<string>;
  };
  output: ReadableStream<string>;
  exit: Promise<number>;
  resize(dimensions: { cols: number; rows: number }): void;
}

/**
 * Process spawn options interface
 */
export interface SpawnOptions {
  terminal?: {
    cols: number;
    rows: number;
  };
}

/**
 * Shell session interface for integrated shell functionality
 */
export interface ShellSession {
  process: ContainerProcess;
  input: WritableStreamDefaultWriter<string>;
  output: ReadableStream<string>;
  internalOutput?: ReadableStream<string>;
  ready: Promise<void>;

  executeCommand?(command: string): Promise<ExecutionResult>;
  waitTillOscCode?(code: string): Promise<{ output: string; exitCode: number }>;
}

/**
 * Shell options interface
 */
export interface ShellOptions {
  args?: string[];
  interactive?: boolean;
  splitOutput?: boolean;
}

/**
 * Shell execution result interface
 */
export interface ExecutionResult {
  output: string;
  exitCode: number;
}

/**
 * Path watcher event interface
 */
export interface PathWatcherEvent {
  type: "add_file" | "change" | "remove_file" | "add_dir" | "remove_dir" | "update_directory";
  path: string;
  buffer?: Uint8Array;
}

/**
 * Path watcher options interface
 */
export interface WatchPathsOptions {
  include?: string[];
  exclude?: string[];
  includeContent?: boolean;
}

/**
 * Container options interface
 */
export interface ContainerOptions {
  coep?: "credentialless";
  workdirName?: string;
  forwardPreviewErrors?: boolean;
}

/**
 * Main container interface
 */
export interface Container {
  fs: FileSystem;
  workdir: string;
  on(event: "port", listener: PortListener): Unsubscribe;
  on(event: "server-ready", listener: ServerReadyListener): Unsubscribe;
  on(event: "preview-message", listener: PreviewMessageListener): Unsubscribe;
  on(event: "error", listener: ErrorListener): Unsubscribe;
  mount(data: FileSystemTree): Promise<void>;
  spawn(command: string, args?: string[], options?: SpawnOptions): Promise<ContainerProcess>;

  /**
   * Spawn a shell process with enhanced functionality
   * @param terminal Terminal interface to connect with the shell
   * @param options Shell specific options
   * @returns Shell session with standard and enhanced shell functionality
   */
  spawnShell(terminal: Terminal, options?: ShellOptions): Promise<ShellSession>;
}

/**
 * Container implementation factory interface
 */
export interface ContainerFactory {
  boot(options: ContainerOptions): Promise<Container>;
}

/**
 * Preview message type
 */
export interface PreviewMessage {
  type: string;
  message?: string;
  stack?: string;
  pathname?: string;
  search?: string;
  hash?: string;
  port?: number;
}

/**
 * Container context interface
 */
export interface ContainerContext {
  loaded: boolean;
}
