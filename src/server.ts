import { type ChildProcess, spawn } from "node:child_process";
import type { Dirent, Stats } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { glob } from "node:fs/promises";
import type { Server, ServerWebSocket } from "bun";
import chokidar, { FSWatcher } from "chokidar";
import { getMachineIpMap } from "./fly.ts";
import type {
  AuthOperation,
  BufferEncoding,
  ContainerRequest,
  ContainerResponse,
  DirectConnectionData,
  FileSystemOperation,
  FileSystemTree,
  PreviewOperation,
  ProcessOperation,
  ProcessResponse,
  ProxyData,
  ServerEvent,
  ServerResponse,
  WatchOperation,
} from "./types.ts";

type WebSocketData = ProxyData | DirectConnectionData;

// Type guards
function isProxyConnection(data: any): data is ProxyData {
  return data && "targetUrl" in data;
}

function isDirectConnection(data: any): data is DirectConnectionData {
  return data && "wsId" in data;
}

declare const Bun: {
  serve(options: {
    port: number;
    fetch: (req: Request, server: Server) => Response | Promise<Response> | undefined;
    websocket: {
      message: (ws: ServerWebSocket<WebSocketData>, message: string | Buffer) => void;
      open?: (ws: ServerWebSocket<WebSocketData>) => void;
      close?: (ws: ServerWebSocket<WebSocketData>) => void;
    };
  }): Server;
};

export class ContainerServer {
  private readonly server: Server;
  private readonly processes: Map<number, ChildProcess>;
  private readonly fileSystemWatchers: Map<string, FSWatcher>;
  private readonly previewPorts: Map<string, number>;
  private readonly fileWatchClients: Map<string, Set<ServerWebSocket<unknown>>>;
  private readonly activeWs: Map<string, ServerWebSocket<WebSocketData>>;
  private readonly config: {
    port: number;
    workdirName: string;
    coep: string;
    forwardPreviewErrors: boolean;
  };
  private authToken: string | undefined;

  constructor(config: {
    port: number;
    workdirName: string;
    coep: string;
    forwardPreviewErrors: boolean;
  }) {
    this.config = config;
    this.processes = new Map();
    this.fileSystemWatchers = new Map();
    this.previewPorts = new Map();
    this.fileWatchClients = new Map();
    this.activeWs = new Map();

    console.info("Starting server on port", config.port);

    this.server = Bun.serve({
      port: config.port,
      fetch: (req, server) => {
        const { pathname } = new URL(req.url);

        if (pathname.startsWith("/proxy/")) {
          const machinemap = getMachineIpMap();
          const [, , target, ...rest] = pathname.split("/");
          const isPreview = rest[0] === "preview";
          const targetUrl = isPreview
            ? `http://[${machinemap[target]}]:5174/${rest.slice(1).join("/")}`
            : `ws://[${machinemap[target]}]:3000/${rest.join("/")}`;

          if (server.upgrade(req, { data: { targetUrl } })) {
            return;
          }
          if (isPreview) {
            const proxiedResponse = fetch(targetUrl, {
              method: req.method,
              headers: req.headers,
              body: req.body,
            });
            return proxiedResponse;
          }
        } else if (
          server.upgrade(req, {
            data: {
              wsId: Math.random().toString(36).substring(7),
            },
          })
        ) {
          return;
        }
        return new Response("Upgrade failed", { status: 400 });
      },
      websocket: {
        message: (ws: ServerWebSocket<WebSocketData>, message) => this.handleMessage(ws, message),
        open: (ws: ServerWebSocket<WebSocketData>) => {
          // WebSocket connection opened
          // Register websocket based on its type
          if (isDirectConnection(ws.data)) {
            this.activeWs.set(ws.data.wsId, ws);
          } else if (isProxyConnection(ws.data)) {
            const targetUrl = ws.data.targetUrl;
            const targetSocket = new WebSocket(targetUrl);
            ws.data.targetSocket = targetSocket;

            targetSocket.onmessage = (ev) => {
              if (typeof ev.data === "string" || ev.data instanceof Uint8Array) {
                ws.send(ev.data);
              }
            };
            targetSocket.onclose = () => {
              ws.close();
            };
            targetSocket.onerror = () => {
              ws.close();
            };
          }
        },
        close: (ws: ServerWebSocket<WebSocketData>) => {
          // Remove client from all watch lists
          const data = ws.data;

          if (isDirectConnection(data)) {
            this.activeWs.delete(data.wsId);

            // Remove from all watch clients
            for (const [path, clients] of this.fileWatchClients.entries()) {
              clients.delete(ws);

              if (clients.size === 0) {
                this.fileWatchClients.delete(path);
              }
            }
          }
        },
      },
    });
  }

  private async handleMessage(
    ws: ServerWebSocket<WebSocketData>,
    message: string | Buffer,
  ): Promise<void> {
    try {
      const { id, operation } = JSON.parse(message.toString()) as {
        id: string;
        operation: ContainerRequest;
      };

      console.debug(message);

      const { type } = operation;

      let response: ContainerResponse<unknown>;

      switch (type) {
        case "readFile":
        case "writeFile":
        case "rm":
        case "readdir":
        case "mkdir":
        case "stat":
        case "mount":
          response = await this.handleFileSystemOperation(operation as FileSystemOperation);
          break;
        case "spawn":
        case "input":
        case "kill":
        case "resize":
          response = await this.handleProcessOperation(operation as ProcessOperation);
          break;
        case "server-ready":
        case "port":
        case "preview-message":
          response = this.handlePreviewOperation(operation as PreviewOperation);
          break;
        case "watch":
        case "watch-paths":
          response = await this.handleWatchOperation(operation as WatchOperation, ws);
          break;
        case "auth":
          response = this.handleAuthOperation(operation as AuthOperation);
          break;
        default:
          response = {
            success: false,
            error: {
              code: "INVALID_OPERATION",
              message: `Invalid operation type: ${type}`,
            },
          };
      }

      const serverResponse: ServerResponse = {
        id,
        ...response,
      };

      ws.send(JSON.stringify(serverResponse));
    } catch (error) {
      console.error('error', error);
      const errorResponse: ServerResponse = {
        id: "",
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : "Unknown error",
        },
      };
      ws.send(JSON.stringify(errorResponse));
    }
  }

  private async handleFileSystemOperation(
    operation: FileSystemOperation,
  ): Promise<ContainerResponse<{ content: string } | { entries: Dirent[] } | Stats | null>> {
    try {
      const fullPath = operation.path.startsWith(this.config.workdirName)
      ? operation.path
      : join(this.config.workdirName, operation.path);

      switch (operation.type) {
        case "readFile": {
          const content = await readFile(fullPath, {
            encoding: (operation.options?.encoding as BufferEncoding) || "utf-8",
          });
          return { success: true, data: { content } };
        }
        case "writeFile": {
          if (!operation.content) {
            throw new Error("Content is required for write operation");
          }
          await writeFile(fullPath, operation.content, {
            encoding: (operation.options?.encoding as BufferEncoding) || "utf-8",
          });
          return { success: true, data: null };
        }
        case "rm": {
          await rm(fullPath, {
            recursive: operation.options?.recursive,
          });
          return { success: true, data: null };
        }
        case "readdir": {
          const files = await readdir(fullPath, { withFileTypes: true });
          return { success: true, data: { entries: files } };
        }
        case "mkdir": {
          await mkdir(fullPath, {
            recursive: operation.options?.recursive,
          });
          return { success: true, data: null };
        }
        case "stat": {
          const stats = await stat(fullPath);
          return { success: true, data: stats };
        }
        case "mount": {
          const tree = JSON.parse(operation.content || "{}") as FileSystemTree;

          await mount(fullPath, tree);
          return { success: true, data: null };
        }
        default:
          throw new Error(`Unsupported file system operation: ${operation.type}`);
      }
    } catch (error) {
      console.error('error', error);
      return {
        success: false,
        error: {
          code: "FILESYSTEM_OPERATION_FAILED",
          message: error instanceof Error ? error.message : "Unknown error occurred",
        },
      };
    }
  }

  private handleProcessOperation(
    operation: ProcessOperation,
  ): Promise<ContainerResponse<ProcessResponse | null>> {
    try {
      switch (operation.type) {
        case "spawn": {
          if (!operation.command) {
            throw new Error("Command is required for spawn operation");
          }
          return Promise.resolve(this.spawnProcess(operation.command, operation.args || []));
        }
        case "input": {
          if (!(operation.pid && operation.data)) {
            throw new Error("PID and data are required for input operation");
          }
          return Promise.resolve(this.sendInput(operation.pid, operation.data));
        }
        case "resize": {
          if (!(operation.pid && operation.cols && operation.rows)) {
            throw new Error("PID, cols, and rows are required for resize operation");
          }
          return Promise.resolve(
            this.resizeTerminal(operation.pid, operation.cols, operation.rows),
          );
        }
        case "kill": {
          if (!operation.pid) {
            throw new Error("PID is required for kill operation");
          }
          return Promise.resolve(this.killProcess(operation.pid));
        }
        default:
          throw new Error(`Unsupported process operation type: ${operation.type}`);
      }
    } catch (error) {
      console.error('error', error);
      return Promise.resolve({
        success: false,
        error: {
          code: "PROCESS_OPERATION_FAILED",
          message: error instanceof Error ? error.message : "Unknown error occurred",
        },
      });
    }
  }

  private handlePreviewOperation(operation: PreviewOperation): ContainerResponse<null> {
    try {
      const { type, data } = operation;

      switch (type) {
        case "server-ready":
          return { success: true, data: null };
        case "port": {
          if (data?.port && data?.previewId) {
            this.previewPorts.set(data.previewId, data.port);
          }
          return { success: true, data: null };
        }
        case "preview-message": {
          if (data?.error && this.config.forwardPreviewErrors) {
            process.stderr.write(`Preview error: ${data.error}\n`);
          }
          return { success: true, data: null };
        }
        default:
          throw new Error(`Unsupported preview operation: ${type}`);
      }
    } catch (error) {
      console.error('error', error);
      return {
        success: false,
        error: {
          code: "preview_error",
          message: error instanceof Error ? error.message : "Unknown error",
        },
      };
    }
  }

  private async handleWatchOperation(
    operation: WatchOperation,
    ws: ServerWebSocket<WebSocketData>,
  ): Promise<ContainerResponse<{ watcher: string }>> {
    try {
      const watcherId = Math.random().toString(36).substring(7);
      const path = operation.path || ".";
      const fullPath = join(this.config.workdirName, path);

      if (operation.options?.patterns && operation.options.patterns.length > 0) {
        // Watch each pattern
        for (const pattern of operation.options.patterns) {
          const fsWatcher = await this.watchFiles(pattern, operation.options || {});
          this.fileSystemWatchers.set(pattern, fsWatcher);
          this.registerWatchClient(pattern, ws);
        }
      } else {
        // Watch a single path
        const fsWatcher = await this.watchFiles(fullPath, operation.options || {});
        this.fileSystemWatchers.set(fullPath, fsWatcher);
        this.registerWatchClient(fullPath, ws);
      }

      return {
        success: true,
        data: { watcher: watcherId },
      };
    } catch (error) {
      console.error('error', error);
      return {
        success: false,
        error: {
          code: "WATCH_OPERATION_FAILED",
          message: error instanceof Error ? error.message : "Unknown error occurred",
        },
      };
    }
  }

  private handleAuthOperation(operation: AuthOperation): ContainerResponse<null> {
    try {
      const { type, token } = operation;

      if (type === "auth" && token) {
        this.authToken = token;
        return { success: true, data: null };
      }

      throw new Error(`Unsupported auth operation: ${type}`);
    } catch (error) {
      return {
        success: false,
        error: {
          code: "auth_error",
          message: error instanceof Error ? error.message : "Unknown error",
        },
      };
    }
  }

  stop(): void {
    // Cleanup all processes
    for (const [pid, process] of this.processes.entries()) {
      process.kill();
      this.processes.delete(pid);
    }

    // Cleanup watchers
    this.cleanup();

    // Close the server
    this.server.stop();
  }

  private spawnProcess(command: string, args: string[]): ContainerResponse<ProcessResponse> {
    const childProcess = spawn(command, args, {
      cwd: this.config.workdirName,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, coep: this.config.coep },
    });

    if (!(childProcess.stdin && childProcess.stdout && childProcess.pid)) {
      throw new Error("Failed to create process streams");
    }

    const textEncoder = new TextEncoder();
    const textDecoder = new TextDecoder();

    const writer = new WritableStream<string>({
      write: (chunk) => {
        return new Promise<void>((resolve, reject) => {
          childProcess.stdin?.write(textEncoder.encode(chunk), (error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        });
      },
    });

    const output = new ReadableStream<string>({
      start: (controller) => {
        childProcess.stdout?.on("data", (chunk) => {
          controller.enqueue(textDecoder.decode(chunk));
        });
        childProcess.stdout?.on("end", () => {
          controller.close();
        });
        childProcess.stdout?.on("error", (error) => {
          controller.error(error);
        });
      },
    });

    this.processes.set(childProcess.pid, childProcess);

    return {
      success: true,
      data: {
        success: true,
        pid: childProcess.pid,
        process: {
          input: {
            getWriter: () => writer.getWriter(),
          },
          output,
          exit: new Promise((resolve) => {
            childProcess.on("exit", (code) => resolve(code ?? 0));
          }),
          resize: () => {
            // No-op as Node.js ChildProcess doesn't support terminal resize
          },
        },
      },
    };
  }

  private sendInput(pid: number, data: string): ContainerResponse<null> {
    const targetProcess = this.processes.get(pid);
    if (!targetProcess) {
      throw new Error(`Process ${pid} not found`);
    }
    if (!targetProcess.stdin) {
      throw new Error(`Process ${pid} has no stdin`);
    }

    targetProcess.stdin.write(data);
    return { success: true, data: null };
  }

  private resizeTerminal(pid: number, _cols: number, _rows: number): ContainerResponse<null> {
    const targetProcess = this.processes.get(pid);
    if (!targetProcess) {
      throw new Error(`Process ${pid} not found`);
    }

    return { success: true, data: null };
  }

  private killProcess(pid: number): ContainerResponse<null> {
    const targetProcess = this.processes.get(pid);
    if (!targetProcess) {
      throw new Error(`Process ${pid} not found`);
    }

    targetProcess.kill();
    this.processes.delete(pid);
    return { success: true, data: null };
  }

  private async watchFiles(
    pattern: string,
    options: { persistent?: boolean },
  ): Promise<FSWatcher> {
    const files = await Array.fromAsync(glob(pattern, { cwd: this.config.workdirName }));
    const watcher = chokidar.watch(files, {
      persistent: options.persistent ?? true,
      ignoreInitial: true,
      cwd: this.config.workdirName,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    watcher.on("all", (eventName, filePath) => {
      const eventType = this.mapChokidarEventToNodeEvent(eventName);
      const filename = filePath.replace(`${this.config.workdirName}/`, "");

      this.notifyFileChange(pattern, eventType, filename);
    });

    return watcher;
  }

  private mapChokidarEventToNodeEvent(chokidarEvent: string): string {
    // Map chokidar events to Node.js fs.watch events
    switch (chokidarEvent) {
      case "add":
      case "change":
        return "change";
      case "unlink":
      case "unlinkDir":
        return "rename";
      default:
        return chokidarEvent;
    }
  }

  private notifyFileChange(watchPath: string, eventType: string, filename: string | null): void {
    const clients = this.fileWatchClients.get(watchPath);

    if (!clients || clients.size === 0) return;

    // Create change notification message
    const changeMessage: ServerEvent = {
      event: "file-change",
      data: {
        path: watchPath,
        eventType,
        filename
      },
      success: true,
    };

    // Send change notification to all clients watching this path
    for (const client of clients) {
      client.send(JSON.stringify(changeMessage));
    }
  }

  private registerWatchClient(pattern: string, ws: ServerWebSocket<unknown>): void {
    const clients = this.fileWatchClients.get(pattern);
    if (clients) {
      clients.add(ws);
    } else {
      this.fileWatchClients.set(pattern, new Set([ws]));
    }
  }

  private cleanup() {
    // Abort all watchers
    for (const fsWatcher of this.fileSystemWatchers.values()) {
      fsWatcher.close();
    }
    this.fileSystemWatchers.clear();
    this.fileWatchClients.clear();
  }
}

async function mount(mountPath: string, tree: FileSystemTree) {
  await mkdir(mountPath, { recursive: true });

  for (const [name, item] of Object.entries(tree)) {
    const fullPath = join(mountPath, name);

    if ('file' in item) {
      await writeFile(fullPath, item.file.contents);
    }
    else if ('directory' in item) {
      await mount(fullPath, item.directory);
    }
  }
}
