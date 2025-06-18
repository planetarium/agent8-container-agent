import { type ChildProcess, spawn } from "node:child_process";
import type { Dirent, Stats } from "node:fs";
import {
  chown,
  mkdir,
  readFile,
  readdir,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, normalize } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import type { Server, ServerWebSocket } from "bun";
import chokidar, { type FSWatcher } from "chokidar";
import { minimatch } from "minimatch";
import type {
  AuthOperation,
  BufferEncoding,
  ContainerEventMessage,
  ContainerRequest,
  ContainerResponse,
  ContainerResponseWithId,
  FileSystemOperation,
  FileSystemTree,
  ProcessEventMessage,
  ProcessOperation,
  ProcessResponse,
  WatchOperation,
  WatchPathsOperation,
  WatchPathsOptions,
  WatchResponse,
} from "../protocol/src/index.ts";
import { Agent8Client } from "./agent8/agent8Client.ts";
import { Agent8ApiRoutes } from "./agent8/api/agent8ApiRoutes.ts";
import { AuthManager } from "./auth/index.ts";
import { type FlyClient, initializeFlyClient } from "./fly/index.ts";
import { MachinePool } from "./fly/machinePool.ts";
import { GitLabApiRoutes } from "./gitlab/api/gitlabApiRoutes.ts";
import type { CandidatePort } from "./portScanner/index.ts";
import { PortScanner } from "./portScanner/portScanner.ts";
import type { DirectConnectionData, ProxyData } from "./types.ts";

type WebSocketData = ProxyData | DirectConnectionData;

// Type guards
function isProxyConnection(data: WebSocketData): data is ProxyData {
  return data && "targetUrl" in data;
}

function isDirectConnection(data: WebSocketData): data is DirectConnectionData {
  return data && "wsId" in data;
}

// CORS 미들웨어 함수
function corsMiddleware(
  handler: (req: Request, server?: any) => Promise<Response | undefined> | Response | undefined,
) {
  return async (req: Request, server?: any) => {
    // OPTIONS 요청 처리
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // 실제 요청 처리
    const response = await handler(req, server);
    if (!response) {
      return;
    }

    // CORS 헤더 추가
    const headers = new Headers(response.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

const LEADING_SLASH_REGEX = /^\/+/;
const PATH_SEPARATOR_REGEX = /[\/\\]/;

export class ContainerServer {
  private readonly server: Server;
  private readonly processes: Map<number, ChildProcess>;
  private readonly fileSystemWatchers: Map<string, FSWatcher>;
  private readonly fileWatchClients: Map<string, Set<ServerWebSocket<unknown>>>;
  private readonly clientWatchers: Map<ServerWebSocket<unknown>, Set<string>>;
  private readonly activeWs: Map<string, ServerWebSocket<WebSocketData>>;
  private readonly portScanner: PortScanner;
  private readonly processClients: Map<number, Set<ServerWebSocket<unknown>>>;
  private readonly config: {
    port: number;
    workdirName: string;
    coep: string;
    forwardPreviewErrors: boolean;
    routerDomain: string;
    appName: string;
    machineId: string;
    processGroup: string;
    agentUid: number;
  };
  private authToken: string | undefined;
  private routerDomain: string;
  private appName: string;
  private machineId: string;
  private flyClient: FlyClient;
  private readonly authManager: AuthManager;
  private readonly agent8Client: Agent8Client;
  private readonly connectionLastActivityTime: Map<string, number>;
  private machineLastActivityTime: number | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly connectionTestInterval = 60000; // 1 minute
  private readonly machineDestroyInterval = 300000; // 5 minutes
  private machinePool: MachinePool | null = null;
  private latestOpenPort: number | null = null;
  private agentUid: number;
  private gitlabApiRoutes: GitLabApiRoutes;
  private agent8ApiRoutes: Agent8ApiRoutes;

  constructor(config: {
    port: number;
    workdirName: string;
    coep: string;
    forwardPreviewErrors: boolean;
    routerDomain: string;
    appName: string;
    machineId: string;
    processGroup: string;
    agentUid: number;
  }) {
    this.config = config;
    this.processes = new Map();
    this.fileSystemWatchers = new Map();
    this.activeWs = new Map();
    this.fileWatchClients = new Map();
    this.processClients = new Map();
    this.clientWatchers = new Map();
    this.connectionLastActivityTime = new Map();
    this.routerDomain = config.routerDomain;
    this.appName = config.appName;
    this.machineId = config.machineId;
    this.agentUid = config.agentUid;
    this.authManager = new AuthManager({
      authServerUrl: process.env.AUTH_SERVER_URL || "https://v8-meme-api.verse8.io",
    });

    // Initialize Agent8 client with container server reference and workdir
    this.agent8Client = new Agent8Client(this, config.workdirName);

    // Initialize GitLab API routes
    this.gitlabApiRoutes = new GitLabApiRoutes();

    // Initialize Agent8 API routes
    this.agent8ApiRoutes = new Agent8ApiRoutes(this.agent8Client, this.authManager);

    this.portScanner = new PortScanner({
      scanIntervalMs: 2000,
      enableLogging: false,
      portFilter: { min: 1024, max: 65535 }, // Exclude system ports
      excludeProcesses: ["bun"], // Exclude bun processes (including this server)
    });

    this.flyClient = initializeFlyClient({
      apiToken: process.env.FLY_API_TOKEN || "",
      appName: process.env.TARGET_APP_NAME || "",
      imageRef: process.env.FLY_IMAGE_REF || "",
    });

    // Initialize machine pool only from pool
    this.machinePool = new MachinePool(this.flyClient, {
      defaultPoolSize: 10, // Maximum 10 machines
      checkInterval: 60000, // Check every minute
    });

    this.portScanner.start().then(() => {});

    this.portScanner.on("portAdded", (event: CandidatePort) => {
      // Exclude the current server port to prevent infinite proxy loops
      if (event.port === this.config.port) {
        return;
      }
      this.latestOpenPort = event.port;
      const url = `https://${this.appName}-${this.machineId}.${this.routerDomain}`;
      const message = JSON.stringify({
        data: {
          success: true,
          data: {
            type: "port",
            data: { port: event.port, type: "open", url },
          },
        },
      });

      for (const socket of this.activeWs.values()) {
        socket.send(message);
      }
    });

    this.portScanner.on("portRemoved", (event: CandidatePort) => {
      // If the closed port is the current latest port, reset to null
      if (this.latestOpenPort === event.port) {
        this.latestOpenPort = null;
      }
      const url = `https://${this.appName}-${this.machineId}.${this.routerDomain}`;
      const message = JSON.stringify({
        data: {
          success: true,
          data: {
            type: "port",
            data: { port: event.port, type: "close", url },
          },
        },
      });

      for (const socket of this.activeWs.values()) {
        socket.send(message);
      }
    });

    console.info("Starting server on port", config.port);

    this.machineLastActivityTime = Date.now();
    if (!this.cleanupInterval) {
      this.cleanupInterval = setInterval(() => this.checkTimeouts(), this.connectionTestInterval);
    }

    // Clean up old background tasks every hour
    setInterval(
      () => {
        this.agent8Client.cleanupOldTasks();
      },
      60 * 60 * 1000,
    );

    this.server = globalThis.Bun.serve({
      port: config.port,
      routes: {
        "/api/machine": {
          POST: corsMiddleware(async (req: Request) => {
            const token = this.authManager.extractTokenFromHeader(req.headers.get("authorization"));
            if (!token) {
              return Response.json({ error: "Missing authorization token" }, { status: 401 });
            }

            const userInfo = await this.authManager.verifyToken(token);
            if (!userInfo) {
              return Response.json({ error: "Invalid authorization token" }, { status: 401 });
            }

            if (!this.machinePool) {
              return Response.json({ error: "Machine pool not initialized" }, { status: 500 });
            }

            // Get a machine from the pool
            let machineId = await this.machinePool.getMachine(userInfo.userUid);

            // If no machine is available, create a new one and assign it
            if (!machineId) {
              console.info(
                `[Machine Pool] No available machines, creating a new one for user ${userInfo.userUid}`,
              );
              machineId = await this.machinePool.createNewMachineWithUser(userInfo.userUid);

              if (!machineId) {
                return Response.json(
                  { error: "Failed to create and assign new machine" },
                  { status: 503 },
                );
              }
            }

            return Response.json({ machine_id: machineId });
          }),
          OPTIONS: corsMiddleware((_req: Request) => {
            return new Response(null, { status: 204 });
          }),
        },
        "/api/machine/:id": {
          GET: corsMiddleware(async (req: Request) => {
            const token = this.authManager.extractTokenFromHeader(req.headers.get("authorization"));

            if (!token) {
              return Response.json({ error: "Missing authorization token" }, { status: 401 });
            }

            const userInfo = await this.authManager.verifyToken(token);
            if (!userInfo) {
              return Response.json({ error: "Invalid authorization token" }, { status: 401 });
            }

            const machineId = (req as any).params.id;

            try {
              // Get machine status directly from Fly API
              const machine = await this.flyClient.getMachineStatus(machineId);
              if (!machine) {
                return Response.json({ error: "Machine not found" }, { status: 404 });
              }

              // Get machine assignment information
              const assignment = this.machinePool
                ? await this.machinePool.getMachineAssignment(machineId)
                : null;

              return Response.json({
                success: true,
                machine,
                assignment,
              });
            } catch (error) {
              console.error("Error retrieving machine:", error);
              return Response.json(
                {
                  error: "Error occurred while retrieving machine",
                  details: error instanceof Error ? error.message : "Unknown error",
                },
                { status: 500 },
              );
            }
          }),
          OPTIONS: corsMiddleware((_req: Request) => {
            return new Response(null, {
              status: 204,
              headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Authorization",
                "Access-Control-Max-Age": "86400",
              },
            });
          }),
        },
        "/api/health": {
          GET: corsMiddleware(async (req: Request) => {
            const host = req.headers.get("host");
            const querySuccess = await Promise.race([
              this.flyClient.listFlyMachines(),
              setTimeout(1000),
            ])
              .then(() => true)
              .catch(() => false);
            return Response.json({
              success: querySuccess,
              host,
            });
          }),
        },
      },
      fetch: corsMiddleware(async (req, server) => {
        // Try GitLab API routes first
        const gitlabResponse = await this.gitlabApiRoutes.handleRequest(req);
        if (gitlabResponse) {
          return gitlabResponse;
        }

        // Try Agent8 API routes
        const agent8Response = await this.agent8ApiRoutes.handleRequest(req);
        if (agent8Response) {
          return agent8Response;
        }

        // Handle WebSocket upgrade requests
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          if (req.headers.get("sec-websocket-protocol")?.startsWith("agent8")) {
            // Handle direct connection for agent8 protocol
            if (
              server.upgrade(req, {
                data: {
                  wsId: Math.random().toString(36).substring(7),
                },
              })
            ) {
              return;
            }
            return new Response("Direct WebSocket upgrade failed", { status: 500 });
          }
          // Proxy all other WebSocket protocols to localhost
          const url = new URL(req.url);

          // Check if there's an open port available
          if (!this.latestOpenPort) {
            console.warn("No open ports detected yet, ignoring WebSocket proxy request");
            return new Response("No open ports available", { status: 503 });
          }

          const targetUrl = `ws://localhost:${this.latestOpenPort}${url.pathname}${url.search}`;
          const headers = Object.fromEntries(req.headers.entries());

          if (server.upgrade(req, { data: { targetUrl, headers } })) {
            return;
          }
          return new Response("Proxy WebSocket upgrade failed", { status: 500 });
        }

        // Proxy HTTP requests to localhost when WebSocket upgrade fails
        try {
          const url = new URL(req.url);

          // Check if there's an open port available
          if (!this.latestOpenPort) {
            console.warn("No open ports detected yet, ignoring HTTP proxy request");
            return new Response("No open ports available", { status: 503 });
          }

          const targetUrl = `http://localhost:${this.latestOpenPort}${url.pathname}${url.search}`;

          const proxyResponse = await fetch(targetUrl, {
            method: req.method,
            headers: req.headers,
            body: req.body,
          });

          // Add CORS headers to the response
          const headers = new Headers(proxyResponse.headers);
          headers.set("Access-Control-Allow-Origin", "*");
          headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
          headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

          // Allow embedding in iframes
          headers.set("X-Frame-Options", "ALLOWALL");
          headers.set("Content-Security-Policy", "frame-ancestors *");
          headers.set("Cross-Origin-Resource-Policy", "cross-origin");
          headers.set("Cross-Origin-Embedder-Policy", "require-corp");

          // Inject error capture script for HTML content
          const contentType = proxyResponse.headers.get("content-type");
          if (contentType?.includes("text/html")) {
            // Get response body as text
            const originalHtml = await proxyResponse.text();

            // Error capture script
            const errorCaptureScript = `
          <script>
            window.onerror = function(message, source, lineno, colno, error) {
              window.parent.postMessage({
                type: 'iframe-error',
                error: {
                  type: 'uncaught-exception',
                  message: message,
                  source: source,
                  lineno: lineno,
                  colno: colno,
                  stack: error?.stack,
                  pathname: window.location.pathname,
                  search: window.location.search,
                  hash: window.location.hash,
                  port: ${url.port || 80}
                }
              }, '*');
              return false;
            };

            window.onunhandledrejection = function(event) {
              window.parent.postMessage({
                type: 'iframe-error',
                error: {
                  type: 'unhandled-rejection',
                  message: event.reason?.message || 'Unhandled Promise Rejection',
                  stack: event.reason?.stack,
                  pathname: window.location.pathname,
                  search: window.location.search,
                  hash: window.location.hash,
                  port: ${url.port || 80}
                }
              }, '*');
            };

            // Capture console.error (optional)
            const originalConsoleError = console.error;
            console.error = function() {
              originalConsoleError.apply(console, arguments);
              const args = Array.from(arguments);
              window.parent.postMessage({
                type: 'iframe-error',
                error: {
                  type: 'console-error',
                  message: args.map(arg => String(arg)).join(' '),
                  stack: new Error().stack,
                  pathname: window.location.pathname,
                  search: window.location.search,
                  hash: window.location.hash,
                  port: ${url.port || 80}
                }
              }, '*');
            };
          </script>`;

            // Insert script before </head> tag
            let modifiedHtml = originalHtml;
            if (originalHtml.includes("</head>")) {
              modifiedHtml = originalHtml.replace("</head>", `${errorCaptureScript}</head>`);
            } else {
              // If head tag is not present, add script to start of body
              modifiedHtml = originalHtml.replace("<body>", `<body>${errorCaptureScript}`);

              // If body tag is not present, add script to start of HTML
              if (!originalHtml.includes("<body>")) {
                modifiedHtml = `${errorCaptureScript}${originalHtml}`;
              }
            }

            // Create new response with modified HTML
            return new Response(modifiedHtml, {
              status: proxyResponse.status,
              statusText: proxyResponse.statusText,
              headers: headers,
            });
          }

          // If not HTML, return original response as is
          return new Response(proxyResponse.body, {
            status: proxyResponse.status,
            statusText: proxyResponse.statusText,
            headers: headers,
          });
        } catch (error) {
          console.error("Proxy error:", error);
          return new Response("Proxy error occurred", { status: 500 });
        }
      }),
      websocket: {
        message: (ws: ServerWebSocket<WebSocketData>, message) => {
          if (isDirectConnection(ws.data)) {
            this.handleMessage(ws, message);
          } else if (isProxyConnection(ws.data)) {
            ws.data.targetSocket?.send(message);
          }
        },
        open: (ws: ServerWebSocket<WebSocketData>) => {
          // WebSocket connection opened
          // Register websocket based on its type
          if (isDirectConnection(ws.data)) {
            this.activeWs.set(ws.data.wsId, ws);
          } else if (isProxyConnection(ws.data)) {
            const targetUrl = ws.data.targetUrl;
            const targetSocket = new WebSocket(
              targetUrl,
              ws.data.headers?.["sec-websocket-protocol"],
            );
            ws.data.targetSocket = targetSocket;

            targetSocket.onopen = () => {};

            targetSocket.onmessage = (ev) => {
              if (typeof ev.data === "string" || ev.data instanceof Uint8Array) {
                ws.send(ev.data);
              }
            };
            targetSocket.onclose = () => {
              ws.close();
            };
            targetSocket.onerror = (_ev) => {
              ws.close();
            };
          }
        },
        close: (ws: ServerWebSocket<WebSocketData>) => {
          // Remove client from all watch lists
          const data = ws.data;
          if (isDirectConnection(data)) {
            this.activeWs.delete(data.wsId);

            if (this.clientWatchers.has(ws)) {
              const watcherIds = this.clientWatchers.get(ws);
              if (watcherIds) {
                for (const watcherId of watcherIds) {
                  const clients = this.fileWatchClients.get(watcherId);
                  if (clients) {
                    clients.delete(ws);

                    if (clients.size === 0) {
                      const fsWatcher = this.fileSystemWatchers.get(watcherId);
                      if (fsWatcher) {
                        fsWatcher.close();
                        this.fileSystemWatchers.delete(watcherId);
                      }
                      this.fileWatchClients.delete(watcherId);
                    }
                  }
                }

                this.clientWatchers.delete(ws);
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
    if (isDirectConnection(ws.data)) {
      this.connectionLastActivityTime.set(ws.data.wsId, Date.now());
    }
    console.debug(message);

    try {
      const { id, operation } = JSON.parse(message.toString()) as ContainerRequest;
      const { type } = operation;
      let response: ContainerResponse;

      try {
        switch (type) {
          case "readFile":
          case "writeFile":
          case "rm":
          case "readdir":
          case "mkdir":
          case "stat":
          case "mount":
            response = await this.handleFileSystemOperation(operation);
            break;
          case "spawn":
          case "input":
          case "kill":
          case "resize":
            response = await this.handleProcessOperation(operation, ws);
            break;
          case "watch":
          case "watch-paths":
            response = await this.handleWatchOperation(operation, ws);
            break;
          case "auth":
            response = await this.handleAuthOperation(operation);
            break;
          case "heartbeat":
            response = { success: true, data: null };
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

        const serverResponse: ContainerResponseWithId = {
          id,
          ...response,
        };

        ws.send(JSON.stringify(serverResponse));
      } catch (error) {
        const errorResponse: ContainerResponseWithId = {
          id,
          success: false,
          error: {
            code: "INTERNAL_ERROR",
            message: error instanceof Error ? error.message : "Unknown error",
          },
        };
        ws.send(JSON.stringify(errorResponse));
      }
    } catch (error) {
      console.error(error);
    }
  }

  private async handleFileSystemOperation(
    operation: FileSystemOperation,
  ): Promise<ContainerResponse<{ content: string } | { entries: Dirent[] } | Stats | null>> {
    try {
      const path = operation.path || "";
      const fullPath = ensureSafePath(this.config.workdirName, path);

      switch (operation.type) {
        case "readFile": {
          const content = await readFile(fullPath, {
            encoding: (operation.options?.encoding as BufferEncoding) || "utf-8",
          });
          return { success: true, data: { content: content.toString() } };
        }
        case "writeFile": {
          if (!operation.content) {
            throw new Error("Content is required for write operation");
          }
          const content =
            typeof operation.content === "string"
              ? operation.content
              : new TextDecoder().decode(operation.content);
          await writeFile(fullPath, content, {
            encoding: (operation.options?.encoding as BufferEncoding) || "utf-8",
          });
          await chown(fullPath, this.agentUid, this.agentUid);
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
          await chown(fullPath, this.agentUid, this.agentUid);
          return { success: true, data: null };
        }
        case "stat": {
          const stats = await stat(fullPath);
          return { success: true, data: stats };
        }
        case "mount": {
          let content = operation.content;
          if (!content) {
            throw new Error("Content is required for mount operation");
          }

          if (typeof content !== "string") {
            content = new TextDecoder().decode(content);
          }

          const tree = JSON.parse(content) as FileSystemTree;

          await mount(fullPath, tree, this.agentUid);
          await chown(fullPath, this.agentUid, this.agentUid);
          return { success: true, data: null };
        }
        default:
          throw new Error(`Unsupported file system operation: ${operation.type}`);
      }
    } catch (error) {
      console.error("error", error);
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
    ws: ServerWebSocket<WebSocketData>,
  ): Promise<ContainerResponse<ProcessResponse | null>> {
    try {
      switch (operation.type) {
        case "spawn": {
          if (!operation.command) {
            throw new Error("Command is required for spawn operation");
          }
          return Promise.resolve(
            this.spawnProcess(operation.command, operation.args || [], ws, operation.options?.env),
          );
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
      console.error("error", error);
      return Promise.resolve({
        success: false,
        error: {
          code: "PROCESS_OPERATION_FAILED",
          message: error instanceof Error ? error.message : "Unknown error occurred",
        },
      });
    }
  }

  private async handleWatchOperation(
    operation: WatchOperation | WatchPathsOperation,
    ws: ServerWebSocket<WebSocketData>,
  ): Promise<ContainerResponse<WatchResponse>> {
    try {
      const watcherId = Math.random().toString(36).substring(7);

      if (operation.type === "watch-paths") {
        // Handle watch-paths operation
        const options = operation.options || {};
        if (options.include && options.include.length > 0) {
          const fsWatcher = await this.watchFiles(watcherId, options);
          this.fileSystemWatchers.set(watcherId, fsWatcher);
          this.registerWatchClient(watcherId, ws);
        }
      } else {
        const options = {
          include: operation.options?.patterns || [],
          exclude: [],
          ignoreInitial: false,
          includeContent: false,
        };
        const fsWatcher = await this.watchFiles(watcherId, options);
        this.fileSystemWatchers.set(watcherId, fsWatcher);
        this.registerWatchClient(watcherId, ws);
      }

      return {
        success: true,
        data: { watcherId },
      };
    } catch (error) {
      console.error("error", error);
      return {
        success: false,
        error: {
          code: "WATCH_OPERATION_FAILED",
          message: error instanceof Error ? error.message : "Unknown error occurred",
        },
      };
    }
  }

  private async handleAuthOperation(operation: AuthOperation): Promise<ContainerResponse<null>> {
    try {
      const { type, token } = operation;

      if (type === "auth" && token) {
        const userInfo = await this.authManager.verifyToken(token);
        if (userInfo) {
          this.authToken = token;
          return { success: true, data: null };
        }
        return {
          success: false,
          error: {
            code: "auth_error",
            message: "Invalid token",
          },
        };
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

  private checkTimeouts(): void {
    const now = Date.now();

    for (const [wsId, lastActivity] of this.connectionLastActivityTime.entries()) {
      if (this.machineLastActivityTime && this.machineLastActivityTime < lastActivity) {
        this.machineLastActivityTime = lastActivity;
      }
      if (now - lastActivity > this.connectionTestInterval) {
        const ws = this.activeWs.get(wsId);
        if (ws) {
          console.info(
            `Connection ${wsId} timed out after ${this.connectionTestInterval}ms of inactivity`,
          );
          ws.close();
          this.cleanupConnection(wsId);
        }
      }
    }

    const activeTasksCount = this.agent8Client.getActiveTasksCount();
    const hasActiveTasks = activeTasksCount > 0;

    if (hasActiveTasks) {
      this.machineLastActivityTime = now;
      console.debug(`Active Agent8 tasks: ${activeTasksCount}, updating activity time`);
    }

    if (
      this.activeWs.size === 0 &&
      this.config.processGroup === "worker" &&
      this.machineLastActivityTime &&
      now - this.machineLastActivityTime > this.machineDestroyInterval &&
      !hasActiveTasks
    ) {
      console.info(
        `No active connections (WS: ${this.activeWs.size}, Agent8 tasks: ${activeTasksCount}), releasing server`,
      );
      this.stop();
    }
  }

  private cleanupConnection(wsId: string): void {
    this.activeWs.delete(wsId);
    this.connectionLastActivityTime.delete(wsId);

    // Kill all processes associated with this connection
    for (const [pid, clients] of this.processClients.entries()) {
      if (clients.size === 0) {
        const process = this.processes.get(pid);
        if (process) {
          process.kill();
          this.processes.delete(pid);
        }
      }
    }

    // Clean up file watchers
    for (const [watcherId, clients] of this.fileWatchClients.entries()) {
      if (clients.size === 0) {
        const watcher = this.fileSystemWatchers.get(watcherId);
        if (watcher) {
          watcher.close();
          this.fileSystemWatchers.delete(watcherId);
        }
        this.fileWatchClients.delete(watcherId);
      }
    }
  }

  public getActiveTasksCount(): number {
    return this.agent8Client.getActiveTasksCount();
  }

  public async stop(): Promise<void> {
    // Self-destruction in DB and Fly
    try {
      const machine = await this.machinePool?.getMachineById(this.machineId);

      if (!machine) {
        console.warn(`[Self-destruction] Machine ${this.machineId} not found in DB`);
        return;
      }

      // Only destroy if machine is not available (has been used)
      if (machine.is_available) {
        console.info(
          `[Self-destruction] Machine ${this.machineId} is still available, skipping destruction`,
        );
      } else {
        try {
          await this.flyClient.destroyMachine(this.machineId);
          console.info(`[Self-destruction] Machine ${this.machineId} has been destroyed in Fly`);
        } catch (error) {
          console.error(
            `[Self-destruction] Failed to destroy machine ${this.machineId} in Fly:`,
            error,
          );
        }
      }
    } catch (error) {
      console.error("[Self-destruction] Error while cleaning up machine:", error);
    }
  }

  private spawnProcess(
    command: string,
    args: string[],
    ws: ServerWebSocket<WebSocketData>,
    env?: Record<string, string>,
  ): ContainerResponse<ProcessResponse> {
    // Use the Node.js PTY wrapper for terminal emulation
    // First try the container path, then fallback to local development path
    let ptyWrapperPath = "/app/pty-wrapper/dist/index.js";
    const ALLOWED_ENV_VARS = [
      "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS",
      "PNPM_STORE_DIR",
      "PNPM_HOME",
      "FORWARD_PREVIEW_ERRORS",
      "TERM",
      "PATH",
    ];

    // Check if file exists using Node.js methods - more reliable across environments
    try {
      require.resolve(ptyWrapperPath);
    } catch (_error) {
      // Fallback to local development path
      ptyWrapperPath = join(process.cwd(), "pty-wrapper/dist/index.js");
    }

    // Default terminal size
    const cols = 80;
    const rows = 24;

    // Create command for PTY wrapper
    const ptyArgs = [ptyWrapperPath, `--cols=${cols}`, `--rows=${rows}`, command, ...args];

    const mergedEnv = { ...process.env, ...(env || {}) };
    const filteredEnv = Object.fromEntries(
      ALLOWED_ENV_VARS.map((key) => [key, mergedEnv[key]]).filter(([, v]) => v),
    );
    const childProcess = spawn("node", ptyArgs, {
      cwd: this.config.workdirName,
      stdio: ["pipe", "pipe", "pipe"],
      env: filteredEnv,
      detached: true,
    });

    if (!(childProcess.stdin && childProcess.stdout && childProcess.pid)) {
      throw new Error("Failed to create process streams");
    }

    const { pid } = childProcess;
    const textDecoder = new TextDecoder();

    this.processes.set(pid, childProcess);
    this.registerProcessClient(pid, ws);

    childProcess.stdout.on("data", (chunk) => {
      const decoded = textDecoder.decode(chunk);
      this.notifyProcess(pid, "stdout", decoded);
    });

    childProcess.stderr.on("data", (chunk) => {
      const decoded = textDecoder.decode(chunk);
      this.notifyProcess(pid, "stderr", decoded);
    });

    childProcess.on("exit", (code) => {
      this.notifyProcess(pid, "exit", String(code ?? 0));
      this.processClients.delete(pid);
    });

    return {
      success: true,
      data: {
        pid: childProcess.pid,
      },
    };
  }

  private notifyProcess(pid: number, stream: string, data: string): void {
    const clients = this.processClients.get(pid);

    if (!clients || clients.size === 0) {
      return;
    }

    // Create stdout notification message
    const message: ContainerEventMessage<ProcessEventMessage> = {
      id: `process-${stream}-${Date.now()}`,
      event: "process",
      data: {
        pid,
        stream,
        data,
      },
    };

    // Send stdout notification to all clients watching this process
    for (const client of clients) {
      client.send(JSON.stringify(message));
    }
  }

  private registerProcessClient(pid: number, ws: ServerWebSocket<unknown>): void {
    if (!this.processClients.has(pid)) {
      this.processClients.set(pid, new Set());
    }

    const clients = this.processClients.get(pid);
    clients?.add(ws);
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

  private resizeTerminal(pid: number, cols: number, rows: number): ContainerResponse<null> {
    const targetProcess = this.processes.get(pid);
    if (!targetProcess) {
      throw new Error(`Process ${pid} not found`);
    }

    // Send resize message to the process
    if (targetProcess.send) {
      targetProcess.send({
        type: "resize",
        cols,
        rows,
      });
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

  private async watchFiles(watcherId: string, options: WatchPathsOptions): Promise<FSWatcher> {
    console.info("watchFiles", options);
    const watcher = chokidar.watch(this.config.workdirName, {
      persistent: true,
      ignoreInitial: options.ignoreInitial,
      ignored: (path) => {
        if (path === this.config.workdirName) {
          return false;
        }

        if (
          options.exclude &&
          options.exclude.length > 0 &&
          options.exclude.some((excludePattern) => minimatch(path, excludePattern))
        ) {
          return true;
        }

        if (
          options.include &&
          options.include.length > 0 &&
          options.include.some((includePattern) => minimatch(path, includePattern, { dot: true }))
        ) {
          return false;
        }

        const relPath = path.replace(this.config.workdirName, "").replace(LEADING_SLASH_REGEX, "");
        const isParentOfPattern =
          options.include &&
          options.include.length > 0 &&
          options.include.some(
            (includePattern) =>
              includePattern.startsWith(`${relPath}/`) || includePattern.includes(`/${relPath}/`),
          );

        if (isParentOfPattern) {
          return false;
        }

        return true;
      },
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    // Add error handler for chokidar watcher
    watcher.on("error", (error: any) => {
      console.error(`File watcher error for watcherId ${watcherId}:`, error);

      // Handle specific error types
      if (error.code === "EINVAL") {
        console.warn(
          `EINVAL error detected for watcherId ${watcherId}. This may be due to temporary files or file system limitations.`,
        );

        // Optionally restart watcher with polling if EINVAL occurs frequently
        if (error.path?.includes("_tmp_")) {
          console.info(
            `Temporary file error detected: ${error.path}. Continuing with current watcher.`,
          );
        }
      } else if (error.code === "ENOENT") {
        console.warn(`File or directory not found for watcherId ${watcherId}: ${error.path}`);
      } else if (error.code === "EMFILE" || error.code === "ENFILE") {
        console.error(
          `Too many open files for watcherId ${watcherId}. Consider reducing watch scope.`,
        );
      } else {
        console.error(`Unexpected watcher error for watcherId ${watcherId}:`, error);
      }
    });

    watcher.on("all", async (eventName, filePath, stats) => {
      const eventType = this.mapChokidarEvent(eventName);
      try {
        const fileContent =
          options.includeContent && stats?.isFile() ? await readFile(filePath) : null;
        this.notifyFileChange(watcherId, eventType, filePath, fileContent);
      } catch (err) {
        console.error(
          `Error watching file: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    });

    return watcher;
  }

  private mapChokidarEvent(chokidarEvent: string): string {
    switch (chokidarEvent) {
      case "add":
        return "add_file";
      case "change":
        return "change";
      case "unlink":
        return "remove_file";
      case "addDir":
        return "add_dir";
      case "unlinkDir":
        return "remove_dir";
      default:
        return "update_directory";
    }
  }

  private notifyFileChange(
    watcherId: string,
    eventType: string,
    filename: string | null,
    buffer: Uint8Array | null,
  ): void {
    const clients = this.fileWatchClients.get(watcherId);

    if (!clients || clients.size === 0) {
      return;
    }

    // Create change notification message
    const changeMessage: ContainerEventMessage = {
      id: `watch-${Date.now()}`,
      event: "file-change",
      data: {
        watcherId,
        eventType,
        filename,
        buffer: buffer ? Buffer.from(buffer).toString("base64") : null,
      },
    };

    // Send change notification to all clients watching this path
    for (const client of clients) {
      client.send(JSON.stringify(changeMessage));
    }
  }

  private registerWatchClient(watcherId: string, ws: ServerWebSocket<unknown>): void {
    const clients = this.fileWatchClients.get(watcherId);
    if (clients) {
      clients.add(ws);
    } else {
      this.fileWatchClients.set(watcherId, new Set([ws]));
    }

    if (this.clientWatchers.has(ws)) {
      this.clientWatchers.get(ws)?.add(watcherId);
    } else {
      this.clientWatchers.set(ws, new Set([watcherId]));
    }
  }

  private cleanup() {
    // Abort all watchers
    for (const fsWatcher of this.fileSystemWatchers.values()) {
      fsWatcher.close();
    }
    this.fileSystemWatchers.clear();
    this.fileWatchClients.clear();
    this.clientWatchers.clear();
    this.processClients.clear();
  }
}

export function ensureSafePath(workdir: string, userPath: string): string {
  if (userPath.startsWith(workdir)) {
    return userPath;
  }

  const normalizedPath = normalize(join(workdir, userPath));
  const normalizedWorkdir = normalize(workdir);

  // Check if the path is within the workspace directory
  if (normalizedPath.startsWith(normalizedWorkdir)) {
    return normalizedPath;
  }

  // Remove dangerous path components and keep the path within workspace
  return join(
    normalizedWorkdir,
    userPath
      .split(PATH_SEPARATOR_REGEX)
      .filter((segment) => segment !== "..")
      .join("/"),
  );
}

async function mount(mountPath: string, tree: FileSystemTree, agentUid: number) {
  await mkdir(mountPath, { recursive: true });
  await chown(mountPath, agentUid, agentUid);

  for (const [name, item] of Object.entries(tree)) {
    const fullPath = join(mountPath, name);

    if ("file" in item) {
      await writeFile(fullPath, item.file.contents);
    } else if ("directory" in item) {
      await mount(fullPath, item.directory, agentUid);
    }
    await chown(fullPath, agentUid, agentUid);
  }
}

async function clearDirectory(dirPath: string): Promise<void> {
  const entries: Dirent[] = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath: string = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      // Recursively delete subdirectory contents then delete directory
      await clearDirectory(fullPath);
      await rmdir(fullPath);
    } else {
      // Delete file
      await unlink(fullPath);
    }
  }
}

function generateRandomName() {
  // Generate a simple, meaningless 8-character random alphanumeric string
  return Math.random().toString(36).substring(2, 10);
}
