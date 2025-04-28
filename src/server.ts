import { type ChildProcess, spawn } from "node:child_process";
import type { Dirent, FSWatcher as NodeFileSystemWatcher, Stats } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, watch, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import type {
  AuthOperation,
  BufferEncoding,
  ContainerRequest,
  ContainerResponse,
  FileSystemOperation,
  PreviewOperation,
  ProcessOperation,
  ProcessResponse,
  ProxyData,
  ServerMessage,
  WatchOperation,
} from "./types.ts";
import { getMachineIPMap } from "./fly.ts";

declare const Bun: {
  serve(options: {
    port: number;
    fetch: (req: Request, server: Server) => Response | Promise<Response> | undefined;
    websocket: {
      message: (ws: ServerWebSocket<unknown>, message: string | Buffer) => void;
      open?: (ws: ServerWebSocket<ProxyData>) => void;
      close?: (ws: ServerWebSocket<unknown>) => void;
    };
  }): Server;
};

export class ContainerServer {
  private readonly server: Server;
  private readonly processes: Map<number, ChildProcess>;
  private readonly watchers: Map<string, NodeFileSystemWatcher>;
  private readonly previewPorts: Map<string, number>;
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
    this.watchers = new Map();
    this.previewPorts = new Map();

    console.info("Starting server on port", config.port);

    this.server = Bun.serve({
      port: config.port,
      fetch: (req, server) => {
        const { pathname } = new URL(req.url);

        if (pathname.startsWith("/proxy/")) {
          const machinemap = getMachineIPMap();
          const [, , target, ...rest] = pathname.split("/");
          const isPreview = rest[0] == "preview";
          const targetUrl = isPreview ?
          `http://[${machinemap[target]}]:5174/${rest.slice(1).join("/")}` :
          `ws://[${machinemap[target]}]:3000/${rest.join("/")}`;

          if (server.upgrade(req, { data: { targetUrl } })) return;
          else if (isPreview) {
            const proxiedResponse = fetch(targetUrl, {
              method: req.method,
              headers: req.headers,
              body: req.body,
            });
            return proxiedResponse;
          }
        }
        else if (server.upgrade(req)) {
          return;
        }
        return new Response("Upgrade failed", { status: 400 });
      },
      websocket: {
        message: (ws: ServerWebSocket<unknown>, message) => this.handleMessage(ws, message),
        open: (ws: ServerWebSocket<ProxyData>) => {
          // WebSocket connection opened - no action needed
          const targetUrl = ws.data?.targetUrl;
          if (!targetUrl) {
            return;
          }
    
          const targetSocket = new WebSocket(targetUrl);
          ws.data.targetSocket = targetSocket;
    
          targetSocket.onmessage = (ev) => {
            console.log(ev)
            if (typeof ev.data === "string") ws.send(ev.data);
            else if (ev.data instanceof Uint8Array) ws.send(ev.data);
          };
    
          targetSocket.onclose = (e) => {
            console.log(e)
            ws.close();
          }
          targetSocket.onerror = (e) => {
            console.log(e)
            ws.close();
          }
        },
        close: () => {
          // WebSocket connection closed - no action needed
        },
      },
    });
  }

  private async handleMessage(
    ws: ServerWebSocket<unknown>,
    message: string | Buffer,
  ): Promise<void> {
    try {
      const { id, operation } = JSON.parse(message.toString()) as {
        id: string;
        operation: ContainerRequest;
      };

      console.info(message);

      const { type } = operation;

      let response: ContainerResponse<unknown>;

      switch (type) {
        case "readFile":
        case "writeFile":
        case "rm":
        case "readdir":
        case "mkdir":
        case "stat":
        case "watch":
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
        case "watch-paths":
        case "stop":
          response = await this.handleWatchOperation(operation as WatchOperation);
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

      const serverMessage: ServerMessage = {
        id,
        ...response,
      };

      ws.send(JSON.stringify(serverMessage));
    } catch (error) {
      const errorResponse: ServerMessage = {
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
    const fullPath = operation.path.startsWith(this.config.workdirName)
      ? operation.path
      : join(this.config.workdirName, operation.path);

    try {
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
        case "watch": {
          if (this.watchers.has(fullPath)) {
            this.watchers.get(fullPath)?.close();
          }
          const watcher = watch(fullPath, {
            persistent: operation.options?.watchOptions?.persistent,
            recursive: operation.options?.watchOptions?.recursive,
            encoding: (operation.options?.watchOptions?.encoding as BufferEncoding) || "utf-8",
          });
          this.watchers.set(fullPath, watcher as unknown as NodeFileSystemWatcher);
          return { success: true, data: null };
        }
        default:
          throw new Error(`Unsupported file system operation: ${operation.type}`);
      }
    } catch (error) {
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
      return {
        success: false,
        error: {
          code: "preview_error",
          message: error instanceof Error ? error.message : "Unknown error",
        },
      };
    }
  }

  private handleWatchOperation(
    operation: WatchOperation,
  ): Promise<ContainerResponse<{ watcher: string }>> {
    try {
      const watcherId = Math.random().toString(36).substring(7);
      const path = operation.path || ".";

      if (operation.type === "watch-paths") {
        // Create watcher but don't store it since it's not used
        this.watchFiles(path, operation.options || {});
        return Promise.resolve({
          success: true,
          data: { watcher: watcherId },
        });
      }

      return Promise.resolve({
        success: true,
        data: { watcher: watcherId },
      });
    } catch (error) {
      return Promise.resolve({
        success: false,
        error: {
          code: "WATCH_OPERATION_FAILED",
          message: error instanceof Error ? error.message : "Unknown error occurred",
        },
      });
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
    for (const [path, watcher] of this.watchers.entries()) {
      watcher.close();
      this.watchers.delete(path);
    }

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

  private watchFiles(path: string, options: { recursive?: boolean }): NodeFileSystemWatcher {
    const fullPath = join(this.config.workdirName, path);
    const watcher = watch(fullPath, {
      persistent: true,
      recursive: options.recursive,
      encoding: "utf-8",
    });
    return watcher as unknown as NodeFileSystemWatcher;
  }

  private cleanup() {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
  }
}
