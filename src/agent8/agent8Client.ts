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
import { GitLabClient } from '../gitlab/services/gitlabClient.js';
import { GitLabGitService } from '../gitlab/services/gitlabGitService.js';
import { GitLabLabelService } from '../gitlab/services/gitlabLabelService.js';
import { GitLabIssueRepository } from '../gitlab/repositories/gitlabIssueRepository.js';
import { IssueLifecycleWorkflow } from '../gitlab/workflows/issueLifecycleWorkflow.js';
import type { GitLabInfo } from '../gitlab/types/api.js';
import type { GitLabIssue, GitLabComment, IssueState } from '../gitlab/types/index.js';
import type { LabelChangeEvent } from '../gitlab/types/lifecycle.js';
import type { GitCommitPushResult, GitCommitResult } from '../gitlab/types/git.js';
import type { IssueCompletionEvent } from '../gitlab/workflows/issueLifecycleWorkflow.js';
import type { FileMap } from './types/fileMap.js';
import { FileMapBuilder } from './utils/fileMapBuilder.js';


interface ChatRequest {
  userId: string;
  token: string;
  targetServerUrl: string;
  cookies?: string;
  messages: UIMessage[];
  files: FileMap;
  promptId?: string;
  contextOptimization: boolean;
  gitlabInfo: GitLabInfo;
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
  private readonly gitlabGitService: GitLabGitService;
  private readonly gitlabClient: GitLabClient;
  private readonly lifecycleWorkflow: IssueLifecycleWorkflow;
  private readonly fileMapBuilder: FileMapBuilder;
  private issuePollingInterval: NodeJS.Timeout | null = null;
  private currentGitLabInfo: GitLabInfo | null = null;
  private previousIssueState: IssueState | null = null;
  private readonly POLLING_INTERVAL = 30000; // 30 seconds

  constructor(containerServer: ContainerServer, workdir: string) {
    console.log(`[Agent8] Initializing - workdir: ${workdir}`);

    // Validate GitLab configuration
    if (!process.env.GITLAB_URL || !process.env.GITLAB_TOKEN) {
      throw new Error(
        'GitLab configuration required: GITLAB_URL and GITLAB_TOKEN environment variables must be set'
      );
    }

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

    // Initialize GitLab services (required)
    console.log(`[Agent8] Initializing GitLab services`);
    this.gitlabClient = new GitLabClient(process.env.GITLAB_URL, process.env.GITLAB_TOKEN);
    this.gitlabGitService = new GitLabGitService(this.gitlabClient, workdir);

    // Initialize FileMapBuilder
    console.log(`[Agent8] Initializing FileMapBuilder`);
    this.fileMapBuilder = new FileMapBuilder(workdir);

    // Initialize lifecycle workflow dependencies
    const gitlabIssueRepository = new GitLabIssueRepository();
    const gitlabLabelService = new GitLabLabelService(this.gitlabClient, gitlabIssueRepository);

    // Initialize IssueLifecycleWorkflow with proper dependencies
    this.lifecycleWorkflow = new IssueLifecycleWorkflow(
      gitlabLabelService,
      gitlabIssueRepository
    );

    // Register issue completion event listener
    this.lifecycleWorkflow.onIssueCompletion(this.handleIssueCompletionEvent.bind(this));

    console.log(`[Agent8] GitLab services and lifecycle workflow initialized`);
  }

  async createTask(request: any): Promise<string> {
    const taskId = this.generateTaskId();
    const startTime = Date.now();

    console.log(`[Agent8] Creating new task: ${taskId}`);
    // Validate GitLab info is provided (required for Agent8Client)
    if (!request.gitlabInfo) {
      throw new Error('GitLab info is required for Agent8Client operation');
    }

    console.log(`[Agent8] Task request info:`, {
      userId: request.userId,
      targetServerUrl: request.targetServerUrl,
      messagesCount: request.messages?.length || 0,
      projectId: request.gitlabInfo.projectId,
      issueIid: request.gitlabInfo.issueIid,
      promptId: request.promptId,
      contextOptimization: request.contextOptimization,
    });

    // Perform GitLab git checkout (required)
    console.log(`[Agent8] Performing git checkout for issue #${request.gitlabInfo.issueIid}`);

    // Start issue monitoring
    console.log(`[Agent8] Starting issue monitoring for issue #${request.gitlabInfo.issueIid}`);
    await this.startIssueMonitoring(request.gitlabInfo);

    try {
      const gitResult = await this.gitlabGitService.checkoutRepositoryForIssue(
        request.gitlabInfo.projectId,
        request.gitlabInfo.issueIid
      );
      console.log(`[Agent8] Git checkout completed:`, {
        success: gitResult.success,
        clonedRepository: gitResult.clonedRepository,
        createdBranch: gitResult.createdBranch,
        hasMergeRequest: !!gitResult.createdMergeRequest,
      });
      if (gitResult.createdMergeRequest) {
        console.log(`[Agent8] Draft MR created: ${gitResult.createdMergeRequest.web_url}`);
      }
    } catch (error) {
      console.error(`[Agent8] Git checkout failed:`, error);
      // Continue with task execution even if git checkout fails
    }

    // Build FileMap from GitLab checkout (always required)
    console.log(`[Agent8] Building FileMap from local checkout`);
    const files = await this.buildFileMapFromWorkdir();
    console.log(`[Agent8] FileMap built successfully with ${Object.keys(files).length} files`);

    const chatRequest: ChatRequest = {
      userId: request.userId,
      token: request.token,
      targetServerUrl: request.targetServerUrl,
      cookies: request.cookies,
      messages: MessageConverter.convertToUIMessages(request.messages || []),
      files: files,
      promptId: request.promptId,
      contextOptimization: request.contextOptimization,
      gitlabInfo: request.gitlabInfo,
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
      const result = await this.processResponse(taskId, response, request);
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

    // Use provided token for backward compatibility with external services
    if (request.token) {
      const tokenCookie = `v8AccessToken=${request.token}`;
      if (cookieString) {
        cookieString += `; ${tokenCookie}`;
      } else {
        cookieString = tokenCookie;
      }
      console.log(`[Agent8] Token cookie added for LLM server authentication`);
    }

    if (cookieString) {
      headers.Cookie = cookieString;
    }

    const payload = {
      messages: request.messages,
      files: request.files,
      ...(request.promptId && { promptId: request.promptId }),
      ...(request.contextOptimization !== undefined && {
        contextOptimization: request.contextOptimization,
      }),
    };

    const payloadString = JSON.stringify(payload);
    console.log(`[Agent8] Request payload size:`, payloadString.length, "bytes");
    console.log(`[Agent8] Request message count:`, request.messages.length);
    console.log(`[Agent8] Attached files count:`, Object.keys(request.files).length);
    console.log(`[Agent8] Attached files list:`, Object.keys(request.files));

    // Full payload content output (for debugging)
    console.log(`[Agent8] Full request payload content:`);
    console.log(payloadString);

    // Message summary
    console.log(`[Agent8] Message summary:`);
    request.messages.forEach((msg, index) => {
      console.log(`  ${index + 1}. ${msg.role}: ${msg.content.substring(0, 100)}${msg.content.length > 100 ? '...' : ''}`);
    });

    try {
      // Use the token provided in the request for authentication
      const authHeaders = {
        ...headers,
        'Authorization': `Bearer ${request.token}`,
      };

      const response = await fetch(request.targetServerUrl, {
        method: "POST",
        headers: authHeaders,
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

  private async processResponse(taskId: string, response: Response, request: ChatRequest): Promise<any> {
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

          // Check if this is the last action and trigger auto-commit/push
          if (actionResults.length === actions.length) {
            console.log(`[Agent8] Task ${taskId} - All actions completed, checking auto-commit conditions`);

            const allActionsSuccessful = actionResults.every(r => r.success);

            if (request.gitlabInfo && this.gitlabGitService) {
              if (allActionsSuccessful) {
                console.log(`[Agent8] Task ${taskId} - Auto-commit triggered (all actions successful)`);
                await this.performAutoCommitPush(taskId, request.gitlabInfo);
              } else {
                console.log(`[Agent8] Task ${taskId} - Some actions failed, skipping auto-commit`);
                await this.handleActionFailure(taskId, request.gitlabInfo, actionResults);
              }
            } else if (request.gitlabInfo) {
              console.log(`[Agent8] Task ${taskId} - GitLab info provided but GitLabGitService not available`);
            } else {
              console.log(`[Agent8] Task ${taskId} - No GitLab info provided, skipping auto-commit`);
            }
          }

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

          // Check if this is the last action and handle failure
          if (actionResults.length === actions.length && request.gitlabInfo) {
            console.log(`[Agent8] Task ${taskId} - All actions completed with failures`);
            await this.handleActionFailure(taskId, request.gitlabInfo, actionResults);
          }
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

  public getActiveTasksInfo(): Array<{ id: string, status: string, progress?: number, createdAt: Date }> {
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

  /**
   * Force complete a task when issue is marked as DONE
   */
  public forceCompleteTask(taskId: string, reason: string): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      console.warn(`[Agent8] Attempted to force complete task but task not found: ${taskId}`);
      return;
    }

    if (task.status === 'completed' || task.status === 'failed') {
      console.log(`[Agent8] Task ${taskId} already in final state: ${task.status}`);
      return;
    }

    console.log(`[Agent8] Force completing task ${taskId}: ${reason}`);

    const completionResult = {
      forcedCompletion: true,
      reason: reason,
      originalStatus: task.status,
      originalProgress: task.progress,
      timestamp: new Date().toISOString()
    };

    this.updateTaskStatus(taskId, "completed", 100, undefined, completionResult);
    console.log(`[Agent8] Task ${taskId} force completed due to: ${reason}`);
  }

  /**
   * Execute automatic commit and push after successful action completion
   */
  private async performAutoCommitPush(taskId: string, gitlabInfo: GitLabInfo): Promise<void> {
    try {
      console.log(`[Agent8] Task ${taskId} - Auto-commit started for issue #${gitlabInfo.issueIid}`);



      const commitMessage = this.generateCommitMessage(gitlabInfo);
      console.log(`[Agent8] Task ${taskId} - Commit message prepared (length: ${commitMessage.length})`);
      console.log(`[Agent8] Task ${taskId} - Commit title: ${gitlabInfo.issueTitle}`);

      const commitPushResult = await this.gitlabGitService.commitAndPush(commitMessage);

      if (commitPushResult.success) {
        console.log(`[Agent8] Task ${taskId} - Auto-commit/push completed successfully`);

        if (commitPushResult.commitResult.commitHash) {
          console.log(`[Agent8] Task ${taskId} - Commit hash: ${commitPushResult.commitResult.commitHash}`);
        }

        if (commitPushResult.pushResult.pushedBranch) {
          console.log(`[Agent8] Task ${taskId} - Pushed to branch: ${commitPushResult.pushResult.pushedBranch}`);
        }

        // Handle task success: add success comment and update issue status
        await this.handleTaskSuccess(taskId, gitlabInfo, commitPushResult);
      } else {
        // Determine the specific failure type for better error handling
        if (commitPushResult.commitResult.success && !commitPushResult.pushResult.success) {
          // Commit succeeded but push failed
          const pushError = new Error(`Push failed: ${commitPushResult.pushResult.error}`);
          await this.handleCommitPushFailure(taskId, gitlabInfo, pushError, commitPushResult.commitResult);
        } else {
          // Commit failed
          const commitError = new Error(`Commit failed: ${commitPushResult.commitResult.error || commitPushResult.error}`);
          await this.handleCommitPushFailure(taskId, gitlabInfo, commitError);
        }
        return; // Don't throw, we've handled the error
      }
    } catch (error) {
      console.error(`[Agent8] Task ${taskId} - Auto-commit/push failed:`, error);
      await this.handleCommitPushFailure(taskId, gitlabInfo, error as Error);
    }
  }

  /**
   * Handle action execution failures by logging and preparing for REJECT state
   */
  private async handleActionFailure(taskId: string, gitlabInfo: GitLabInfo, actionResults: ActionResult[]): Promise<void> {
    try {
      const failedActions = actionResults.filter(r => !r.success);
      const successfulActions = actionResults.filter(r => r.success);

      console.log(`[Agent8] Task ${taskId} - Action execution failed:`, {
        totalActions: actionResults.length,
        successful: successfulActions.length,
        failed: failedActions.length
      });

      const errorComment = this.generateErrorComment('action_failure', {
        timestamp: new Date().toISOString(),
        failedActions: failedActions.map(r => ({
          error: r.error,
        })),
        successfulActions: successfulActions.length,
        failedActionsCount: failedActions.length,
        containerId: gitlabInfo.containerId
      });

      console.log(`[Agent8] Task ${taskId} - Action failure comment prepared:`, errorComment.substring(0, 100) + '...');

      // Add error comment to GitLab issue
      await this.addIssueErrorComment(gitlabInfo, errorComment);

      // Update issue status to REJECT (Phase 5 implementation)
      const issue = await this.getGitLabIssue(gitlabInfo.projectId, gitlabInfo.issueIid);
      if (issue) {
        const errorMessage = `Agent8 actions failed: ${failedActions.length}/${actionResults.length} actions failed`;
        await this.lifecycleWorkflow.onTaskExecutionFailure(issue, new Error(errorMessage));
        console.log(`[Agent8] Task ${taskId} - Issue status updated to REJECT due to action failures`);
      }

    } catch (error) {
      console.error(`[Agent8] Task ${taskId} - Failed to handle action failure:`, error);
    }
  }

  /**
   * Handle commit/push failures by logging and preparing for REJECT state
   */
  private async handleCommitPushFailure(taskId: string, gitlabInfo: GitLabInfo, error: Error, commitResult?: GitCommitResult): Promise<void> {
    try {
      console.error(`[Agent8] Task ${taskId} - Commit/Push failed:`, error.message);

      // Determine error type based on whether commit succeeded
      const errorType = commitResult?.success ? 'push_failure' : 'commit_failure';

      const errorComment = this.generateErrorComment(errorType, {
        timestamp: new Date().toISOString(),
        errorMessage: error.message,
        commitHash: commitResult?.commitHash,
        containerId: gitlabInfo.containerId
      });

      console.log(`[Agent8] Task ${taskId} - ${errorType === 'push_failure' ? 'Push' : 'Commit'} failure comment prepared:`, errorComment.substring(0, 100) + '...');

      // Add error comment to GitLab issue
      await this.addIssueErrorComment(gitlabInfo, errorComment);

      // Update issue status to REJECT (Phase 5 implementation)
      const issue = await this.getGitLabIssue(gitlabInfo.projectId, gitlabInfo.issueIid);
      if (issue) {
        await this.lifecycleWorkflow.onTaskExecutionFailure(issue, error);
        console.log(`[Agent8] Task ${taskId} - Issue status updated to REJECT due to ${errorType === 'push_failure' ? 'push' : 'commit'} failure`);
      }

    } catch (handlingError) {
      console.error(`[Agent8] Task ${taskId} - Failed to handle commit/push failure:`, handlingError);
    }
  }

  /**
   * Generate commit message based on GitLab issue information
   */
  private generateCommitMessage(gitlabInfo: GitLabInfo): string {
    const title = gitlabInfo.issueTitle;
    const description = gitlabInfo.issueDescription;

    if (!description || description.trim() === '') {
      return title;
    }

    return `${title}\n\n${description}`;
  }

  /**
   * Generate error comment templates for different failure types
   */
  private generateErrorComment(errorType: 'action_failure' | 'commit_failure' | 'push_failure', details: any): string {
    const timestamp = details.timestamp || new Date().toISOString();
    const containerId = details.containerId || 'unknown';

    switch (errorType) {
      case 'action_failure':
        return `## ❌ Agent8 Action Execution Failed

**Error Type**: Action execution failure
**Timestamp**: ${timestamp}
**Failed Actions**: ${details.failedActionsCount}/${details.failedActionsCount + details.successfulActions}

**Execution Statistics**:
- Successful actions: ${details.successfulActions}
- Failed actions: ${details.failedActionsCount}

**Resolution Steps**:
1. Review issue description for clarity
2. Check for missing files or dependencies
3. Change issue state back to TODO to retry

**Container**: \`${containerId}\``;

      case 'commit_failure':
        return `## ❌ Auto-Commit Failed

**Error Type**: Git commit failure
**Timestamp**: ${timestamp}
**Error Message**: ${details.errorMessage}

**Resolution Steps**:
1. Check Git configuration (user.name, user.email)
2. Verify working directory permissions
3. Change issue state back to TODO to retry

**Container**: \`${containerId}\``;

      case 'push_failure':
        return `## ❌ Auto-Push Failed

**Error Type**: Git push failure
**Timestamp**: ${timestamp}
**Error Message**: ${details.errorMessage}
**Commit Hash**: \`${details.commitHash || 'N/A'}\`

**Changes were committed locally but failed to push to remote.**

**Resolution Steps**:
1. Verify GitLab token permissions (write_repository)
2. Check network connectivity
3. Change issue state back to TODO to retry

**Container**: \`${containerId}\``;

      default:
        return `## ❌ Unknown Error

**Timestamp**: ${timestamp}
**Container**: \`${containerId}\``;
    }
  }

  /**
   * Handle task success: add success comment and update issue status to CONFIRM NEEDED
   */
  private async handleTaskSuccess(
    taskId: string,
    gitlabInfo: GitLabInfo,
    commitResult: GitCommitPushResult
  ): Promise<void> {
    try {
      console.log(`[Agent8] Task ${taskId} - Task completed successfully, updating issue status`);

      // Generate success comment
      const successComment = this.generateSuccessComment(gitlabInfo, commitResult);

      // Update issue status to CONFIRM NEEDED (Phase 5 implementation)
      const issue = await this.getGitLabIssue(gitlabInfo.projectId, gitlabInfo.issueIid);
      if (issue) {
        await this.lifecycleWorkflow.onTaskCompletion(issue, {
          containerId: gitlabInfo.containerId,
          commitHash: commitResult.commitResult.commitHash,
          pushedBranch: commitResult.pushResult.pushedBranch
        });
      }

      // Add success comment to GitLab issue
      await this.addIssueSuccessComment(gitlabInfo, successComment);

      console.log(`[Agent8] Task ${taskId} - Issue status updated to CONFIRM NEEDED`);

    } catch (error) {
      console.error(`[Agent8] Task ${taskId} - Failed to handle task success:`, error);
      // Do not convert to error state since the actual work was successful
    }
  }

  /**
   * Generate success comment template
   */
  private generateSuccessComment(
    gitlabInfo: GitLabInfo,
    commitResult: GitCommitPushResult
  ): string {
    const commitInfo = commitResult.commitResult.commitHash
      ? `\n**Commit Hash:** \`${commitResult.commitResult.commitHash}\``
      : '';

    const branchInfo = commitResult.pushResult.pushedBranch
      ? `\n**Branch:** \`${commitResult.pushResult.pushedBranch}\``
      : '';

    return `## ✅ Agent8 Task Completed

**Status:** Task completed successfully
**Completion Time:** ${new Date().toISOString()}
**Container:** \`${gitlabInfo.containerId}\`${commitInfo}${branchInfo}

**Next Steps:**
Please review the task results and change the issue status to **DONE** if everything looks correct.

---
*Agent8 automatic task completion notification*`;
  }

  /**
   * Add success comment to GitLab issue
   */
  private async addIssueSuccessComment(gitlabInfo: GitLabInfo, comment: string): Promise<void> {
    try {
      await this.gitlabClient.addIssueComment(gitlabInfo.projectId, gitlabInfo.issueIid, comment);
      console.log(`[Agent8] Success comment added to issue #${gitlabInfo.issueIid}`);
    } catch (error) {
      console.error(`[Agent8] Failed to add success comment to issue #${gitlabInfo.issueIid}:`, error);
    }
  }

  /**
   * Add error comment to GitLab issue
   */
  private async addIssueErrorComment(gitlabInfo: GitLabInfo, comment: string): Promise<void> {
    try {
      await this.gitlabClient.addIssueComment(gitlabInfo.projectId, gitlabInfo.issueIid, comment);
      console.log(`[Agent8] Error comment added to issue #${gitlabInfo.issueIid}`);
    } catch (error) {
      console.error(`[Agent8] Failed to add error comment to issue #${gitlabInfo.issueIid}:`, error);
    }
  }

  /**
   * Get GitLab issue by project ID and issue IID
   */
  private async getGitLabIssue(projectId: number, issueIid: number): Promise<GitLabIssue | null> {
    try {
      return await this.gitlabClient.getIssue(projectId, issueIid);
    } catch (error) {
      console.error(`[Agent8] Failed to fetch GitLab issue #${issueIid}:`, error);
      return null;
    }
  }

  /**
   * Handle issue completion event - terminate related tasks
   */
  private async handleIssueCompletionEvent(event: IssueCompletionEvent): Promise<void> {
    console.log(`[Agent8] Issue #${event.issue.iid} completed, stopping monitoring and cleaning up tasks`);

    this.stopIssueMonitoring();

    const activeTasks = this.getActiveTasksInfo();
    let terminatedCount = 0;

    for (const task of activeTasks) {
      if (task.status === 'pending' || task.status === 'running') {
        this.forceCompleteTask(task.id, `Issue #${event.issue.iid} marked as DONE`);
        terminatedCount++;
      }
    }

    console.log(`[Agent8] Terminated ${terminatedCount} tasks for completed issue #${event.issue.iid}`);
  }

  private async startIssueMonitoring(gitlabInfo: GitLabInfo): Promise<void> {
    this.stopIssueMonitoring();

    this.currentGitLabInfo = gitlabInfo;
    this.previousIssueState = await this.getCurrentIssueState(gitlabInfo);
    console.log(`[Agent8] Initial issue state captured for #${gitlabInfo.issueIid}`);

    this.issuePollingInterval = setInterval(async () => {
      await this.checkIssueChanges();
    }, this.POLLING_INTERVAL);

    console.log(`[Agent8] Issue monitoring started for #${gitlabInfo.issueIid} (${this.POLLING_INTERVAL / 1000}s interval)`);
  }

  private async getCurrentIssueState(gitlabInfo: GitLabInfo): Promise<IssueState> {
    const issue = await this.gitlabClient.getIssue(gitlabInfo.projectId, gitlabInfo.issueIid);
    const comments = await this.gitlabClient.getIssueComments(gitlabInfo.projectId, gitlabInfo.issueIid);

    return {
      labels: issue.labels || [],
      lastCommentAt: comments.length > 0 ? comments[comments.length - 1].created_at : null,
      commentCount: comments.length,
      lastComment: comments.length > 0 ? comments[comments.length - 1] : null,
      updatedAt: issue.updated_at
    };
  }

  private async checkIssueChanges(): Promise<void> {
    if (!this.currentGitLabInfo || !this.previousIssueState) return;

    try {
      const currentState = await this.getCurrentIssueState(this.currentGitLabInfo);

      if (this.hasLabelChanged(this.previousIssueState, currentState)) {
        await this.handleLabelChange(this.previousIssueState, currentState);
      }

      if (this.hasCommentChanged(this.previousIssueState, currentState)) {
        await this.handleCommentChange(this.previousIssueState, currentState);
      }

      this.previousIssueState = currentState;

    } catch (error) {
      console.error(`[Agent8] Error checking issue changes:`, error);
    }
  }

  private hasLabelChanged(previous: IssueState, current: IssueState): boolean {
    return JSON.stringify(previous.labels.sort()) !== JSON.stringify(current.labels.sort());
  }

  private hasCommentChanged(previous: IssueState, current: IssueState): boolean {
    return previous.commentCount !== current.commentCount ||
      previous.lastCommentAt !== current.lastCommentAt;
  }

  private async handleLabelChange(previousState: IssueState, currentState: IssueState): Promise<void> {
    console.log(`[Agent8] Label change detected: ${previousState.labels} → ${currentState.labels}`);

    const issue = await this.gitlabClient.getIssue(
      this.currentGitLabInfo!.projectId,
      this.currentGitLabInfo!.issueIid
    );

    const labelChangeEvent: LabelChangeEvent = {
      issue: issue,
      previousLabels: previousState.labels,
      currentLabels: currentState.labels,
      changedAt: new Date(),
      changeType: 'modified'
    };

    await this.lifecycleWorkflow.onLabelChange(labelChangeEvent);
  }

  private async handleCommentChange(previousState: IssueState, currentState: IssueState): Promise<void> {
    if (!currentState.lastComment) return;

    console.log(`[Agent8] New comment detected from ${currentState.lastComment.author.username}`);
    console.log(`[Agent8] Comment preview: "${currentState.lastComment.body.substring(0, 100)}${currentState.lastComment.body.length > 100 ? '...' : ''}"`);

    if (currentState.lastComment.system) {
      console.log(`[Agent8] System comment detected, ignoring`);
      return;
    }

    console.log(`[Agent8] User comment logged successfully`);
  }

  private stopIssueMonitoring(): void {
    if (this.issuePollingInterval) {
      clearInterval(this.issuePollingInterval);
      this.issuePollingInterval = null;
      console.log(`[Agent8] Issue monitoring stopped`);
    }
  }

  private async buildFileMapFromWorkdir(): Promise<FileMap> {
    console.log(`[Agent8] Building FileMap from working directory`);
    const result = await this.fileMapBuilder.buildFileMap();

    console.log(`[Agent8] FileMap built successfully:`, {
      filesCount: Object.keys(result.fileMap).length,
      totalSize: result.stats.totalSize,
      duration: result.stats.duration,
      processedFiles: result.stats.processedFiles,
      skippedFiles: result.stats.skippedFiles,
      errors: result.stats.errors.length
    });

    // If no files were processed, this indicates a critical problem
    if (result.stats.processedFiles === 0) {
      console.error(`[Agent8] FileMap build failed: No files were processed`);
      throw new Error('FileMap build failed: No source files found or processed');
    }

    // Log warnings but continue (minor issues like some binary files, etc.)
    if (result.stats.errors.length > 0) {
      console.warn(`[Agent8] FileMap build completed with ${result.stats.errors.length} warnings:`, result.stats.errors.slice(0, 3));
    }

    return result.fileMap;
  }

  public cleanup(): void {
    this.stopIssueMonitoring();
    console.log(`[Agent8] Client cleanup completed`);
  }
}
