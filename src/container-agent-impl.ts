import { type ChildProcess, spawn } from "node:child_process";
import { promises as fs, type FSWatcher as NodeFileSystemWatcher } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import type {
  BufferEncoding,
  Container,
  ContainerConfigType as ContainerConfig,
  ContainerProcess,
  ErrorListener,
  FileSystem,
  FileSystemTree,
  PathWatcherEvent,
  PortListener,
  PreviewMessage,
  PreviewMessageListener,
  ServerReadyListener,
  Unsubscribe,
  WatchCallback,
  WatchOptions,
} from "./types.ts";

export class ContainerAgentImpl implements Container {
  private readonly processes: Map<number, ChildProcess> = new Map();
  private readonly watchers: Map<string, NodeFileSystemWatcher> = new Map();
  private readonly eventListeners: Map<
    string,
    Set<PortListener | ServerReadyListener | PreviewMessageListener | ErrorListener>
  > = new Map();
  public readonly workdir: string;
  public readonly fs: FileSystem;
  private readonly config: ContainerConfig;

  constructor(config: ContainerConfig) {
    this.config = config;
    this.workdir = config.workdirName;
    // Ensure workspace directory exists
    fs.mkdir(this.workdir, { recursive: true }).catch(() => {
      // Ignore directory creation errors
    });

    this.fs = {
      readFile: (path: string, options?: { encoding?: BufferEncoding }) => {
        const fullPath = join(this.workdir, path);
        return fs.readFile(fullPath, options);
      },
      writeFile: async (path: string, content: string, options?: { encoding?: BufferEncoding }) => {
        const fullPath = join(this.workdir, path);
        await fs.writeFile(fullPath, content, options);
      },
      rm: async (path: string, options?: { recursive?: boolean }) => {
        const fullPath = join(this.workdir, path);
        await fs.rm(fullPath, options);
      },
      readdir: (path: string) => {
        const fullPath = join(this.workdir, path);
        return fs.readdir(fullPath);
      },
      mkdir: async (path: string, options?: { recursive?: boolean }) => {
        const fullPath = join(this.workdir, path);
        await fs.mkdir(fullPath, options);
      },
      stat: (path: string) => {
        const fullPath = join(this.workdir, path);
        return fs.stat(fullPath);
      },
      watch: (pattern: string, options?: { persistent?: boolean }) => {
        const fullPath = join(this.workdir, pattern);
        // Ensure directory exists before watching
        fs.mkdir(join(fullPath, ".."), { recursive: true }).catch(() => {
          // Ignore directory creation errors
        });
        const watcher = fs.watch(fullPath, options) as unknown as NodeFileSystemWatcher;
        this.watchers.set(fullPath, watcher);
        return watcher;
      },
    };
  }

  on(event: "port", listener: PortListener): Unsubscribe;
  on(event: "server-ready", listener: ServerReadyListener): Unsubscribe;
  on(event: "preview-message", listener: PreviewMessageListener): Unsubscribe;
  on(event: "error", listener: ErrorListener): Unsubscribe;
  on(
    event: "port" | "server-ready" | "preview-message" | "error",
    listener: PortListener | ServerReadyListener | PreviewMessageListener | ErrorListener,
  ): Unsubscribe {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)?.add(listener);

    return () => {
      this.eventListeners.get(event)?.delete(listener);
    };
  }

  emit(event: string, ...args: unknown[]) {
    const listeners = this.eventListeners.get(event);
    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      try {
        if (event === "port" && typeof args[0] === "number") {
          (listener as PortListener)(args[0]);
        } else if (event === "server-ready") {
          (listener as ServerReadyListener)();
        } else if (event === "preview-message" && typeof args[0] === "object") {
          (listener as PreviewMessageListener)(args[0] as PreviewMessage);
        } else if (event === "error" && args[0] instanceof Error) {
          (listener as ErrorListener)(args[0]);
        }
      } catch (error) {
        process.stderr.write(`Error in event listener: ${error}\n`);
      }
    }
  }

  async mount(data: FileSystemTree): Promise<void> {
    const writeFiles = async (tree: FileSystemTree, basePath = "") => {
      for (const [name, content] of Object.entries(tree)) {
        const path = join(basePath, name);
        if (typeof content === "string") {
          await this.fs.writeFile(path, content);
        } else {
          await this.fs.mkdir(path, { recursive: true });
          await writeFiles(content, path);
        }
      }
    };

    await writeFiles(data);
  }

  async spawn(
    command: string,
    args: string[] = [],
    options: { env?: Record<string, string> } = {},
  ): Promise<ContainerProcess> {
    const childProcess = spawn(command, args, {
      cwd: this.workdir,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...options.env, coep: this.config.coep },
    });

    if (childProcess.pid) {
      this.processes.set(childProcess.pid, childProcess);
    }

    const textDecoder = new TextDecoder();

    const input = {
      getWriter: () => {
        const writer = new WritableStreamDefaultWriter(
          new WritableStream({
            write: (chunk: string) => {
              if (childProcess.stdin) {
                childProcess.stdin.write(chunk);
              }
            },
          }),
        );
        return writer;
      },
    };

    const output = new ReadableStream<string>({
      start(controller) {
        childProcess.stdout?.on("data", (data) => {
          controller.enqueue(textDecoder.decode(data));
        });
        childProcess.stderr?.on("data", (data) => {
          controller.enqueue(textDecoder.decode(data));
        });
        childProcess.on("close", () => {
          controller.close();
        });
      },
    });

    const exit = new Promise<number>((resolve) => {
      childProcess.on("exit", (code) => {
        resolve(code ?? 0);
      });
    });

    const resize = () => {
      // Note: rows and columns are not available on stdout
      return;
    };

    return { input, output, exit, resize };
  }

  private async determineEventType(
    eventType: string,
    path: string,
  ): Promise<PathWatcherEvent["type"]> {
    if (eventType === "rename") {
      try {
        const stats = await this.fs.stat(path);
        return stats.isDirectory() ? "add_dir" : "add_file";
      } catch {
        return "remove_file";
      }
    }
    return "change";
  }

  internal = {
    watchPaths: (options: WatchOptions, callback: WatchCallback): void => {
      try {
        if (options.pattern) {
          const watcher = this.fs.watch(options.pattern, {
            persistent: options.persistent,
          }) as unknown as NodeFileSystemWatcher &
            AsyncIterable<{ eventType: string; filename: string | Buffer }>;
          this.watchers.set(options.pattern, watcher);

          (async () => {
            for await (const { eventType, filename } of watcher) {
              if (filename) {
                const path = filename.toString();
                const type = await this.determineEventType(eventType, path);
                callback({ type, path });
              }
            }
          })().catch((error) => {
            process.stderr.write(`Error in watch event handler: ${error}\n`);
          });
        }
      } catch (error) {
        process.stderr.write(`Error in watchPaths: ${error}\n`);
      }
    },
  };

  public cleanup() {
    for (const [path, watcher] of this.watchers.entries()) {
      const watcherObj = watcher as { close?: () => void; stop?: () => void };
      if (typeof watcherObj.close === "function") {
        watcherObj.close();
      } else if (typeof watcherObj.stop === "function") {
        watcherObj.stop();
      }
      this.watchers.delete(path);
    }
  }
}
