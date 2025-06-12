import type {
  ReasoningUIPart,
  SourceUIPart,
  StepStartUIPart,
  TextUIPart,
  ToolInvocationUIPart,
  UIMessage,
} from "@ai-sdk/ui-utils";
import type { ContainerServer } from "../server";
import type {
  ActionCallbacks,
  ActionResult,
  BoltAction,
  ParserCallbacks,
} from "./index";
import { ActionRunner, StreamingMessageParser } from "./index";

interface FileMap {
  [key: string]: {
    type: string;
    content: string;
    isBinary: boolean;
  };
}

interface ChatRequest {
  userId: string;
  token: string;
  targetServerUrl: string;
  cookies?: string;
  messages: UIMessage[];
  files?: FileMap;
  promptId?: string;
  contextOptimization: boolean;
}

interface Task {
  id: string;
  userId: string;
  status: "pending" | "running" | "completed" | "failed";
  createdAt: Date;
  completedAt?: Date;
  result?: any;
  error?: string;
  progress?: number;
}

class MessageConverter {
  static convertToUIMessages(messages: any[]): UIMessage[] {
    return messages.map((msg) => {
      const role = msg.role || "user";
      const id = msg.id || MessageConverter.generateMessageId();

      let content = "";
      if (typeof msg.content === "string") {
        content = msg.content;
      } else if (msg.text) {
        content = msg.text;
      } else if (msg.message) {
        content = msg.message;
      } else if (Array.isArray(msg.content)) {
        content = msg.content
          .filter((part: any) => part.type === "text")
          .map((part: any) => part.text || "")
          .join("");
      }

      const parts: Array<
        TextUIPart | ReasoningUIPart | ToolInvocationUIPart | SourceUIPart | StepStartUIPart
      > = msg.parts || [
        {
          type: "text",
          text: content,
        },
      ];

      const convertedMessage: UIMessage = {
        id,
        role: role as "system" | "user" | "assistant" | "data",
        content,
        parts,
        ...(msg.annotations && { annotations: msg.annotations }),
        ...(msg.createdAt && { createdAt: msg.createdAt }),
        ...(msg.experimental_attachments && {
          experimental_attachments: msg.experimental_attachments,
        }),
      };

      return convertedMessage;
    });
  }

  private static generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }
}

export class Agent8Client {
  private tasks: Map<string, Task> = new Map();
  private readonly actionRunner: ActionRunner;

  constructor(containerServer: ContainerServer, workdir: string) {
    console.log(`[Agent8] Initializing - workdir: ${workdir}`);

    // Create ActionRunner with callbacks for progress tracking
    const actionCallbacks: ActionCallbacks = {
      onStart: (action) => {
        console.log(`[Agent8] Action started: ${action.type}`);
        console.log(`[Agent8] Action details:`, JSON.stringify(action, null, 2));
      },
      onComplete: (action, result) => {
        console.log(`[Agent8] Action completed: ${action.type}`, result.success ? "✅" : "❌");
        if (result.output) {
          console.log(`[Agent8] Action output:`, result.output);
        }
        if (!result.success && result.error) {
          console.log(`[Agent8] Action error:`, result.error);
        }
      },
      onError: (action, error: any) => {
        console.error(`[Agent8] Action failed: ${action.type}`, error);
        console.error(`[Agent8] Error stack:`, error instanceof Error ? error.stack : "No stack info");
      },
    };

    this.actionRunner = new ActionRunner(containerServer, workdir, actionCallbacks);
    console.log(`[Agent8] ActionRunner initialization completed`);
  }

  async createTask(request: any): Promise<string> {
    const taskId = this.generateTaskId();
    const startTime = Date.now();

    console.log(`[Agent8] Creating new task: ${taskId}`);
    console.log(`[Agent8] Task request info:`, {
      userId: request.userId,
      targetServerUrl: request.targetServerUrl,
      messagesCount: request.messages?.length || 0,
      filesCount: request.files ? Object.keys(request.files).length : 0,
      promptId: request.promptId,
      contextOptimization: request.contextOptimization,
    });

    const chatRequest: ChatRequest = {
      userId: request.userId,
      token: request.token,
      targetServerUrl: request.targetServerUrl,
      cookies: request.cookies,
      messages: MessageConverter.convertToUIMessages(request.messages || []),
      files: request.files,
      promptId: request.promptId,
      contextOptimization: request.contextOptimization,
    };

    const task: Task = {
      id: taskId,
      userId: request.userId,
      status: "pending",
      createdAt: new Date(),
      progress: 0,
    };

    this.tasks.set(taskId, task);
    console.log(`[Agent8] Task created: ${taskId} (took ${Date.now() - startTime}ms)`);
    console.log(`[Agent8] Current active tasks: ${this.tasks.size}`);

    this.executeTask(taskId, chatRequest).catch((error) => {
      console.error(`[Agent8] Task ${taskId} execution failed:`, error);
      console.error(`[Agent8] Error stack:`, error instanceof Error ? error.stack : "No stack info");
      this.updateTaskStatus(taskId, "failed", undefined, error.message);
    });

    return taskId;
  }

  private async executeTask(taskId: string, request: ChatRequest): Promise<void> {
    const startTime = Date.now();
    console.log(`[Agent8] Task ${taskId} execution started`);

    try {
      // Step 1: Start task execution
      console.log(`[Agent8] Task ${taskId} - Step 1: Setting status to running`);
      this.updateTaskStatus(taskId, "running", 10);

      // Step 2: Call LLM server
      console.log(`[Agent8] Task ${taskId} - Step 2: LLM server call started`);
      const llmStartTime = Date.now();
      const response = await this.callLLMServer(request);
      const llmDuration = Date.now() - llmStartTime;
      console.log(`[Agent8] Task ${taskId} - LLM server call completed (took ${llmDuration}ms)`);

      this.updateTaskStatus(taskId, "running", 30);

      // Step 3: Process response
      console.log(`[Agent8] Task ${taskId} - Step 3: Response processing started`);
      const processStartTime = Date.now();
      const result = await this.processResponse(taskId, response);
      const processDuration = Date.now() - processStartTime;
      console.log(`[Agent8] Task ${taskId} - Response processing completed (took ${processDuration}ms)`);

      this.updateTaskStatus(taskId, "completed", 100, undefined, result);

      const totalDuration = Date.now() - startTime;
      console.log(`[Agent8] Task ${taskId} fully completed!`);
      console.log(`[Agent8] Task ${taskId} total duration: ${totalDuration}ms`);
      console.log(`[Agent8] Task ${taskId} final results:`, {
        textChunksLength: result.textChunks?.length || 0,
        artifactsCount: result.artifacts?.length || 0,
        actionsCount: result.actions?.length || 0,
        executedActions: result.executedActions || 0,
        failedActions: result.failedActions || 0,
      });

    } catch (error: any) {
      const totalDuration = Date.now() - startTime;
      console.error(`[Agent8] Task ${taskId} execution failed (took ${totalDuration}ms):`, error);
      console.error(`[Agent8] Task ${taskId} error stack:`, error instanceof Error ? error.stack : "No stack info");
      this.updateTaskStatus(
        taskId,
        "failed",
        undefined,
        error instanceof Error ? error.message : "Unknown error",
      );
    }
  }

  private async callLLMServer(request: ChatRequest): Promise<Response> {
    const startTime = Date.now();
    console.log(`[Agent8] LLM server call started:`, request.targetServerUrl);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "Agent8-Container/1.0",
    };

    let cookieString = "";

    if (request.cookies) {
      cookieString = request.cookies;
      console.log(`[Agent8] Using existing cookies: ${cookieString.substring(0, 50)}...`);
    }

        // 🧪 테스트 모드: 환경변수에서 고정 토큰 사용
    let effectiveToken = request.token;
    const useTestToken = process.env.USE_TEST_TOKEN?.toLowerCase() === 'true';

    if (useTestToken && process.env.TEST_V8_ACCESS_TOKEN) {
      effectiveToken = process.env.TEST_V8_ACCESS_TOKEN;
      console.log(`[Agent8] 🧪 TEST MODE: Using fixed token from environment variable`);
    }

    if (effectiveToken) {
      const tokenCookie = `v8AccessToken=${effectiveToken}`;
      if (cookieString) {
        cookieString += `; ${tokenCookie}`;
      } else {
        cookieString = tokenCookie;
      }
      console.log(`[Agent8] Token cookie added${useTestToken ? ' (TEST MODE)' : ''}`);
    }

    if (cookieString) {
      headers.Cookie = cookieString;
    }

    const payload = {
      messages: request.messages,
      ...(request.files && { files: request.files }),
      ...(request.promptId && { promptId: request.promptId }),
      ...(request.contextOptimization !== undefined && {
        contextOptimization: request.contextOptimization,
      }),
    };

    const payloadString = JSON.stringify(payload);
    console.log(`[Agent8] Request payload size:`, payloadString.length, "bytes");
    console.log(`[Agent8] Request message count:`, request.messages.length);
    if (request.files) {
      console.log(`[Agent8] Attached files count:`, Object.keys(request.files).length);
      console.log(`[Agent8] Attached files list:`, Object.keys(request.files));
    }

    // Full payload content output (for debugging)
    console.log(`[Agent8] Full request payload content:`);
    console.log(payloadString);

    // Message summary
    console.log(`[Agent8] Message summary:`);
    request.messages.forEach((msg, index) => {
      console.log(`  ${index + 1}. ${msg.role}: ${msg.content.substring(0, 100)}${msg.content.length > 100 ? '...' : ''}`);
    });

    try {
      const response = await fetch(request.targetServerUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });

      const duration = Date.now() - startTime;
      console.log(`[Agent8] LLM server response received (took ${duration}ms)`);
      console.log(`[Agent8] Response status:`, response.status, response.statusText);
      console.log(`[Agent8] Response headers:`, Object.fromEntries(response.headers.entries()));

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        console.error(`[Agent8] LLM server request failed:`, {
          status: response.status,
          statusText: response.statusText,
          errorText: errorText.substring(0, 500),
        });
        throw new Error(
          `LLM server request failed: ${response.status} ${response.statusText} - ${errorText}`,
        );
      }

      return response;
    } catch (error: any) {
      const duration = Date.now() - startTime;
      console.error(`[Agent8] LLM server call error (took ${duration}ms):`, error);
      throw error;
    }
  }

  private async processResponse(taskId: string, response: Response): Promise<any> {
    const startTime = Date.now();
    console.log(`[Agent8] Task ${taskId} - Response processing started`);

    if (!response.body) {
      console.error(`[Agent8] Task ${taskId} - No response body`);
      throw new Error("No response body received");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let rawContent = "";
    let chunkCount = 0;
    let totalBytes = 0;

    // Store parsed artifacts and actions
    const artifacts: any[] = [];
    const actions: BoltAction[] = [];
    const actionResults: ActionResult[] = [];
    const textChunks: string[] = [];

    console.log(`[Agent8] Task ${taskId} - Setting up streaming parser callbacks`);

    // Set up Agent8 streaming parser callbacks with real-time action execution
    const callbacks: ParserCallbacks = {
      onTextChunk: (text) => {
        textChunks.push(text);
        console.log(`[Agent8] Task ${taskId} - Text chunk received (length: ${text.length})`);
      },
      onArtifactOpen: (artifact) => {
        console.log(`[Agent8] Task ${taskId} - Artifact parsing started:`, artifact.title || "Unnamed");
      },
      onArtifactClose: (artifact) => {
        artifacts.push(artifact);
        console.log(`[Agent8] Task ${taskId} - Artifact completed:`, {
          title: artifact.title || "Unnamed",
          type: artifact.type,
          contentLength: artifact.content?.length || 0,
        });
      },
      onActionOpen: (action) => {
        console.log(`[Agent8] Task ${taskId} - Action parsing started:`, action.type);
      },
      onActionStream: (chunk) => {
        console.log(`[Agent8] Task ${taskId} - Action stream chunk received (length: ${chunk.length})`);
      },
      onActionClose: async (action) => {
        const actionStartTime = Date.now();
        console.log(`[Agent8] Task ${taskId} - Action parsing completed, preparing execution:`, action.type);

        // Convert BoltActionData to BoltAction by ensuring all required fields are present
        let fullAction: BoltAction = {
          type: action.type,
          content: action.content || "",
          // Preserve all optional fields from the original action
          ...(action.filePath && { filePath: action.filePath }),
          ...(action.operation && { operation: action.operation }),
          ...(action.command && { command: action.command }),
        };

        // Handle missing command for shell actions
        if (action.type === "shell" && !action.command && action.content) {
          // Extract command from content (first line, trimmed)
          const command = action.content.trim().split('\n')[0].trim();
          if (command) {
            fullAction.command = command;
            console.log(`[Agent8] Task ${taskId} - Command extracted from content:`, command);
          }
        }

        actions.push(fullAction);
        console.log(`[Agent8] Task ${taskId} - Action execution started:`, {
          type: fullAction.type,
          filePath: fullAction.filePath,
          operation: fullAction.operation,
          command: fullAction.command,
          contentLength: fullAction.content.length,
        });

        try {
          // Execute action immediately when parsing completes
          const result = await this.actionRunner.executeAction(fullAction);
          const actionDuration = Date.now() - actionStartTime;

          actionResults.push(result);
          console.log(`[Agent8] Task ${taskId} - Action execution completed (took ${actionDuration}ms):`, {
            success: result.success,
            hasOutput: !!result.output,
            outputLength: result.output?.length || 0,
            error: result.error,
          });

          // Update task progress
          const progressIncrement = 50 / actions.length; // Allocate 50% progress for actions
          const currentProgress = 30 + (actionResults.length * progressIncrement);
          this.updateTaskStatus(taskId, "running", Math.min(currentProgress, 95));

        } catch (error: any) {
          const actionDuration = Date.now() - actionStartTime;
          const errorResult: ActionResult = {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
          actionResults.push(errorResult);
          console.error(`[Agent8] Task ${taskId} - Action execution failed (took ${actionDuration}ms):`, {
            actionType: fullAction.type,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : "No stack info",
          });
        }
      },
    };

    const parser = new StreamingMessageParser({ callbacks });
    console.log(`[Agent8] Task ${taskId} - Starting streaming reader`);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          console.log(`[Agent8] Task ${taskId} - Streaming completed (total chunks: ${chunkCount}, total bytes: ${totalBytes})`);
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        rawContent += chunk;
        chunkCount++;
        totalBytes += chunk.length;

        if (chunkCount % 10 === 0) { // Log every 10 chunks
          console.log(`[Agent8] Task ${taskId} - Streaming progress: ${chunkCount} chunks, ${totalBytes} bytes`);
        }
      }

      // Final parsing
      console.log(`[Agent8] Task ${taskId} - Final parsing started (total content length: ${rawContent.length})`);
      const parseStartTime = Date.now();
      const result = parser.parseDataStream("stream", rawContent);
      const parseDuration = Date.now() - parseStartTime;
      console.log(`[Agent8] Task ${taskId} - Final parsing completed (took ${parseDuration}ms)`);

      const totalDuration = Date.now() - startTime;
      const finalResult = {
        content: rawContent,
        parsedContent: result,
        textChunks: textChunks.join(""),
        artifacts,
        actions,
        actionResults,
        executedActions: actionResults.filter(r => r.success).length,
        failedActions: actionResults.filter(r => !r.success).length,
        timestamp: new Date().toISOString(),
        processed: true,
        type: "chat-response",
      };

      console.log(`[Agent8] Task ${taskId} - Response processing completed (total took ${totalDuration}ms)`);
      console.log(`[Agent8] Task ${taskId} - Processing results summary:`, {
        rawContentLength: rawContent.length,
        textChunksLength: finalResult.textChunks.length,
        artifactsCount: artifacts.length,
        actionsCount: actions.length,
        successfulActions: finalResult.executedActions,
        failedActions: finalResult.failedActions,
        totalChunks: chunkCount,
        totalBytes: totalBytes,
      });

      return finalResult;
    } finally {
      reader.releaseLock();
      console.log(`[Agent8] Task ${taskId} - Stream reader released`);
    }
  }

  async getTaskStatus(taskId: string, userId: string): Promise<Task | null> {
    console.log(`[Agent8] Task status query: ${taskId} (user: ${userId})`);
    const task = this.tasks.get(taskId);
    if (!task || task.userId !== userId) {
      console.log(`[Agent8] Task query result: Not found or no permission`);
      return null;
    }
    console.log(`[Agent8] Task status:`, {
      id: task.id,
      status: task.status,
      progress: task.progress,
      createdAt: task.createdAt,
      completedAt: task.completedAt,
      hasError: !!task.error,
      hasResult: !!task.result,
    });
    return task;
  }

  private updateTaskStatus(
    taskId: string,
    status: Task["status"],
    progress?: number,
    error?: string,
    result?: any,
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      console.warn(`[Agent8] Attempted to update task status but task not found: ${taskId}`);
      return;
    }

    const previousStatus = task.status;
    const previousProgress = task.progress;

    task.status = status;
    if (progress !== undefined) {
      task.progress = progress;
    }
    if (error) {
      task.error = error;
    }
    if (result) {
      task.result = result;
    }
    if (status === "completed" || status === "failed") {
      task.completedAt = new Date();
    }

    this.tasks.set(taskId, task);

    console.log(`[Agent8] Task ${taskId} status updated:`, {
      previousStatus: previousStatus,
      newStatus: status,
      previousProgress: previousProgress,
      newProgress: progress,
      error: error ? error.substring(0, 100) : null,
      hasResult: !!result,
    });
  }

  private generateTaskId(): string {
    return `agent8-task_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  public cleanupOldTasks(): void {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const initialCount = this.tasks.size;
    let cleanedCount = 0;

    console.log(`[Agent8] Old task cleanup started (current tasks: ${initialCount})`);

    for (const [taskId, task] of this.tasks.entries()) {
      if (task.completedAt && task.completedAt < oneHourAgo) {
        this.tasks.delete(taskId);
        cleanedCount++;
        console.log(`[Agent8] Old task cleaned up: ${taskId} (completed at: ${task.completedAt})`);
      }
    }

    console.log(`[Agent8] Task cleanup completed: ${cleanedCount} cleaned up (remaining tasks: ${this.tasks.size})`);
  }

  public hasActiveTasks(): boolean {
    for (const task of this.tasks.values()) {
      if (task.status === "pending" || task.status === "running") {
        return true;
      }
    }
    return false;
  }

  public getActiveTasksCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status === "pending" || task.status === "running") {
        count++;
      }
    }
    return count;
  }

  public getActiveTasksInfo(): Array<{id: string, status: string, progress?: number, createdAt: Date}> {
    const activeTasks = [];
    for (const task of this.tasks.values()) {
      if (task.status === "pending" || task.status === "running") {
        activeTasks.push({
          id: task.id,
          status: task.status,
          progress: task.progress,
          createdAt: task.createdAt
        });
      }
    }
    return activeTasks;
  }
}
