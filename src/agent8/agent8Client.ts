import { promises as fs } from "node:fs";
import path from "node:path";
import type { UIMessage } from "@ai-sdk/ui-utils";
import { GitLabIssueRepository } from "../gitlab/repositories/gitlabIssueRepository.js";
import { GitLabClient } from "../gitlab/services/gitlabClient.js";
import { GitLabGitService } from "../gitlab/services/gitlabGitService.js";
import { GitLabLabelService } from "../gitlab/services/gitlabLabelService.js";
import type { GitLabInfo } from "../gitlab/types/api.js";
import type { GitCommitPushResult, GitCommitResult } from "../gitlab/types/git.js";
import type { GitLabIssue, IssueState } from "../gitlab/types/index.js";
import type { LabelChangeEvent } from "../gitlab/types/lifecycle.js";
import {
  createActionFailureComment,
  createComment,
  createCommitFailureComment,
  createPushFailureComment,
  createSuccessComment,
} from "../gitlab/utils/commentFormatter.js";
import type { ErrorDetails, SuccessDetails } from "../gitlab/utils/commentFormatter.js";
import { IssueLifecycleWorkflow } from "../gitlab/workflows/issueLifecycleWorkflow.js";
import type { IssueCompletionEvent } from "../gitlab/workflows/issueLifecycleWorkflow.js";
import type { ContainerServer } from "../server.ts";
import type { ActionCallbacks, ActionResult, BoltAction, ParserCallbacks } from "./index.ts";
import { ActionRunner, StreamingMessageParser } from "./index.ts";
import type { FileMap } from "./types/fileMap.js";
import { FileMapBuilder } from "./utils/fileMapBuilder.js";
import { convertToUIMessages } from "./utils/messageUtils.js";
import { ConfigurationFormatter } from "./configurationFormatter.js";

interface TaskResponseData {
  taskId: string;
  userId: string;
  timestamp: string;

  // LLM server request data
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    payload: string; // JSON stringified full request
    sentAt: string;
  };

  // LLM server response data (AI SDK Data Stream Protocol)
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    rawContent: string; // Full AI SDK Data Stream
    receivedAt: string;
    duration: number;
    streaming: boolean;
    contentLength: number;
    chunkCount: number;
  };

  // GitLab information
  gitlabInfo?: GitLabInfo;

  // Agent8 processing results summary
  processing: {
    artifactsCount: number;
    actionsCount: number;
    executedActions: number;
    failedActions: number;
    textChunksLength: number;
  };
}

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
  mcpConfig?: string;
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
  private containerServer: ContainerServer;

  constructor(containerServer: ContainerServer, workdir: string) {
    this.containerServer = containerServer;
    // Validate GitLab configuration
    if (!(process.env.GITLAB_URL && process.env.GITLAB_TOKEN)) {
      throw new Error(
        "GitLab configuration required: GITLAB_URL and GITLAB_TOKEN environment variables must be set",
      );
    }

    // Create ActionRunner with callbacks for progress tracking
    const actionCallbacks: ActionCallbacks = {
      onStart: (_action) => {
        console.info(`[Agent8] Action started: ${_action.type}`);
      },
      onComplete: (_action, result) => {
        if (!result.success && result.error) {
          console.error(`[Agent8] Action failed: ${_action.type}`, result.error);
        }
      },
      onError: (action, error: any) => {
        console.error(`[Agent8] Action failed: ${action.type}`, error);
        console.error(
          "[Agent8] Error stack:",
          error instanceof Error ? error.stack : "No stack info",
        );
      },
    };

    this.actionRunner = new ActionRunner(containerServer, workdir, actionCallbacks);
    this.gitlabClient = new GitLabClient(process.env.GITLAB_URL, process.env.GITLAB_TOKEN);

    // Use specified branch, default to 'develop'
    const branch = process.env.GITLAB_BRANCH || "develop";
    this.gitlabGitService = new GitLabGitService(this.gitlabClient, workdir, branch);
    this.fileMapBuilder = new FileMapBuilder(workdir);

    // Initialize lifecycle workflow dependencies
    const gitlabIssueRepository = new GitLabIssueRepository();
    const gitlabLabelService = new GitLabLabelService(this.gitlabClient, gitlabIssueRepository);

    // Initialize IssueLifecycleWorkflow with proper dependencies
    this.lifecycleWorkflow = new IssueLifecycleWorkflow(gitlabLabelService, gitlabIssueRepository);

    // Register issue completion event listener
    this.lifecycleWorkflow.onIssueCompletion(this.handleIssueCompletionEvent.bind(this));
  }

  async createTask(request: any): Promise<string> {
    const taskId = this.generateTaskId();
    // Validate GitLab info is provided (required for Agent8Client)
    if (!request.gitlabInfo) {
      throw new Error("GitLab info is required for Agent8Client operation");
    }
    await this.startIssueMonitoring(request.gitlabInfo);

    try {
      const gitResult = await this.gitlabGitService.checkoutRepositoryForIssue(
        request.gitlabInfo.projectId,
        request.gitlabInfo.issueIid,
      );
      if (gitResult.createdMergeRequest) {
        console.info(`[Agent8] Git checkout successful: ${gitResult.createdMergeRequest}`);
      }
    } catch (error) {
      console.error("[Agent8] Git checkout failed:", error);
      // Continue with task execution even if git checkout fails
    }
    const files = await this.buildFileMapFromWorkdir();

    // Set MCP configuration if provided
    if (request.mcpConfig) {
      this.setContainerMcpConfiguration(request.mcpConfig);
      console.log(`[MCP] Task ${taskId} configured with MCP servers`);
    }

    const chatRequest: ChatRequest = {
      userId: request.userId,
      token: request.token,
      targetServerUrl: request.targetServerUrl,
      cookies: request.cookies,
      messages: convertToUIMessages(request.messages || []),
      files: files,
      promptId: request.promptId,
      contextOptimization: request.contextOptimization,
      gitlabInfo: request.gitlabInfo,
      mcpConfig: request.mcpConfig,
    };

    const task: Task = {
      id: taskId,
      userId: request.userId,
      status: "pending",
      createdAt: new Date(),
      progress: 0,
    };

    this.tasks.set(taskId, task);

    this.executeTask(taskId, chatRequest).catch((error) => {
      console.error(`[Agent8] Task ${taskId} execution failed:`, error);
      console.error(
        "[Agent8] Error stack:",
        error instanceof Error ? error.stack : "No stack info",
      );
      this.updateTaskStatus(taskId, "failed", undefined, error.message);
    });

    return taskId;
  }

  private async executeTask(taskId: string, request: ChatRequest): Promise<void> {
    const startTime = Date.now();

    try {
      this.updateTaskStatus(taskId, "running", 10);
      const llmStartTime = Date.now();
      const { response, requestData } = await this.callLLMServer(request);
      const _llmDuration = Date.now() - llmStartTime;

      this.updateTaskStatus(taskId, "running", 30);
      const processStartTime = Date.now();
      const result = await this.processResponse(taskId, { response, requestData }, request);
      const _processDuration = Date.now() - processStartTime;

      this.updateTaskStatus(taskId, "completed", 100, undefined, result);

      const _totalDuration = Date.now() - startTime;
    } catch (error: any) {
      const totalDuration = Date.now() - startTime;
      console.error(`[Agent8] Task ${taskId} execution failed (took ${totalDuration}ms):`, error);
      console.error(
        `[Agent8] Task ${taskId} error stack:`,
        error instanceof Error ? error.stack : "No stack info",
      );
      this.updateTaskStatus(
        taskId,
        "failed",
        undefined,
        error instanceof Error ? error.message : "Unknown error",
      );
    }
  }

  private async callLLMServer(
    request: ChatRequest,
  ): Promise<{ response: Response; requestData: any }> {
    const startTime = Date.now();

    // Log MCP integration status
    this.logMcpIntegrationStatus(request);

    const headers = this.buildHeaders(request);

    const payload = this.buildLLMPayload(request);

    const payloadString = JSON.stringify(payload);

    // Capture request data for response storage
    const requestData = {
      url: request.targetServerUrl,
      method: "POST",
      headers: headers,
      payload: payloadString,
      sentAt: new Date().toISOString(),
    };

    try {
      const response = await fetch(request.targetServerUrl, {
        method: "POST",
        headers: headers,
        body: payloadString,
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });

      const _duration = Date.now() - startTime;

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        console.error("[Agent8] LLM server request failed:", {
          status: response.status,
          statusText: response.statusText,
          errorText: errorText.substring(0, 500),
        });
        throw new Error(
          `LLM server request failed: ${response.status} ${response.statusText} - ${errorText}`,
        );
      }

      return { response, requestData };
    } catch (error: any) {
      const duration = Date.now() - startTime;
      console.error(`[Agent8] LLM server call error (took ${duration}ms):`, error);
      throw error;
    }
  }

  private async processResponse(
    taskId: string,
    responseData: { response: Response; requestData: any },
    request: ChatRequest,
  ): Promise<any> {
    const startTime = Date.now();
    const { response, requestData } = responseData;

    // Initialize dual file storage (JSON metadata + Raw streaming)
    const initialMetadata = {
      taskId,
      userId: request.userId,
      timestamp: new Date().toISOString(),
      request: requestData,
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        receivedAt: new Date().toISOString(),
        streaming: true,
        rawContentFile: `${taskId}.raw`,
      },
      gitlabInfo: request.gitlabInfo,
      processing: {},
    };

    await this.saveMetadata(taskId, initialMetadata);
    const rawFile = await this.initRawStreamingFile(taskId);

    if (!response.body) {
      throw new Error("No response body received");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let chunkCount = 0;
    let totalBytes = 0;

    const artifacts: any[] = [];
    const actions: BoltAction[] = [];
    const actionResults: ActionResult[] = [];
    const textChunks: string[] = [];

    // Set up Agent8 streaming parser callbacks with real-time action execution
    const callbacks: ParserCallbacks = {
      onTextChunk: (text) => {
        textChunks.push(text);
      },
      onArtifactOpen: (_artifact) => {},
      onArtifactClose: (artifact) => {
        artifacts.push(artifact);
      },
      onActionOpen: (_action) => {},
      onActionStream: (_chunk) => {},
      onActionClose: async (action) => {
        const actionStartTime = Date.now();

        // Convert BoltActionData to BoltAction by ensuring all required fields are present
        const fullAction: BoltAction = {
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
          const command = action.content.trim().split("\n")[0].trim();
          if (command) {
            fullAction.command = command;
          }
        }

        actions.push(fullAction);

        try {
          // Execute action immediately when parsing completes
          const result = await this.actionRunner.executeAction(fullAction);

          actionResults.push(result);

          // Update task progress
          const progressIncrement = 50 / actions.length; // Allocate 50% progress for actions
          const currentProgress = 30 + actionResults.length * progressIncrement;
          this.updateTaskStatus(taskId, "running", Math.min(currentProgress, 95));

          // Check if this is the last action and trigger auto-commit/push
          if (actionResults.length === actions.length) {
            const allActionsSuccessful = actionResults.every((r) => r.success);

            if (request.gitlabInfo && this.gitlabGitService) {
              if (allActionsSuccessful) {
                await this.performAutoCommitPush(taskId, request.gitlabInfo);
              } else {
                await this.handleActionFailure(taskId, request.gitlabInfo, actionResults);
              }
            } else if (request.gitlabInfo) {
            } else {
            }
          }
        } catch (error: any) {
          const actionDuration = Date.now() - actionStartTime;
          const errorResult: ActionResult = {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
          actionResults.push(errorResult);
          console.error(
            `[Agent8] Task ${taskId} - Action execution failed (took ${actionDuration}ms):`,
            {
              actionType: fullAction.type,
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : "No stack info",
            },
          );

          // Check if this is the last action and handle failure
          if (actionResults.length === actions.length && request.gitlabInfo) {
            await this.handleActionFailure(taskId, request.gitlabInfo, actionResults);
          }
        }
      },
    };

    const parser = new StreamingMessageParser({ callbacks });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        chunkCount++;
        totalBytes += chunk.length;

        // Save chunk to raw file immediately (no memory accumulation)
        await this.appendToRawFile(rawFile, chunk);

        if (chunkCount % 10 === 0) {
        }

        // Force garbage collection for large streams (every 50 chunks)
        if (chunkCount % 50 === 0) {
          if (typeof global.gc === "function") {
            global.gc();
          } else if (typeof Bun !== "undefined" && typeof Bun.gc === "function") {
            Bun.gc(true);
          }
        }
      }

      // Finalize raw file
      await this.finalizeRawFile(rawFile);
      const rawContent = await this.loadRawContent(taskId);

      if (!rawContent) {
        throw new Error("Failed to read raw content from file for parsing");
      }

      const parseStartTime = Date.now();
      const result = parser.parseDataStream("stream", rawContent);
      const _parseDuration = Date.now() - parseStartTime;

      // Clear rawContent from memory after parsing (memory optimization)
      const _rawContentLength = rawContent.length;
      // rawContent is no longer needed in memory, file contains the data

      const totalDuration = Date.now() - startTime;

      // Prepare final result with memory optimization
      const finalResult = {
        content: null, // Do not store raw content in memory, use file instead
        parsedContent: result,
        textChunks: textChunks.join(""),
        artifacts,
        actions,
        actionResults,
        executedActions: actionResults.filter((r) => r.success).length,
        failedActions: actionResults.filter((r) => !r.success).length,
        timestamp: new Date().toISOString(),
        processed: true,
        type: "chat-response",
        rawContentFile: `${taskId}.raw`, // Reference to file location
      };

      // Clear large arrays from memory after processing
      textChunks.length = 0;
      artifacts.length = 0;

      // Save final metadata
      const finalMetadata = {
        ...initialMetadata,
        response: {
          ...initialMetadata.response,
          duration: totalDuration,
          streaming: false,
          contentLength: totalBytes,
          chunkCount,
        },
        processing: {
          artifactsCount: artifacts.length,
          actionsCount: actions.length,
          executedActions: finalResult.executedActions,
          failedActions: finalResult.failedActions,
          textChunksLength: finalResult.textChunks.length,
          completedAt: new Date().toISOString(),
        },
      };

      await this.saveMetadata(taskId, finalMetadata);

      return finalResult;
    } finally {
      reader.releaseLock();
      await this.closeRawFile(rawFile);
    }
  }

  async getTaskStatus(taskId: string, userId: string): Promise<Task | null> {
    const task = this.tasks.get(taskId);
    if (!task || task.userId !== userId) {
      return null;
    }
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

    const _previousStatus = task.status;
    const _previousProgress = task.progress;

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
  }

  private generateTaskId(): string {
    return `agent8-task_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  public cleanupOldTasks(): void {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const _initialCount = this.tasks.size;
    let _cleanedCount = 0;

    for (const [taskId, task] of this.tasks.entries()) {
      if (task.completedAt && task.completedAt < oneHourAgo) {
        this.tasks.delete(taskId);
        _cleanedCount++;
      }
    }
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

  public getActiveTasksInfo(): Array<{
    id: string;
    status: string;
    progress?: number;
    createdAt: Date;
  }> {
    const activeTasks = [];
    for (const task of this.tasks.values()) {
      if (task.status === "pending" || task.status === "running") {
        activeTasks.push({
          id: task.id,
          status: task.status,
          progress: task.progress,
          createdAt: task.createdAt,
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

    if (task.status === "completed" || task.status === "failed") {
      return;
    }

    const completionResult = {
      forcedCompletion: true,
      reason: reason,
      originalStatus: task.status,
      originalProgress: task.progress,
      timestamp: new Date().toISOString(),
    };

    this.updateTaskStatus(taskId, "completed", 100, undefined, completionResult);
  }

  /**
   * Execute automatic commit and push after successful action completion
   */
  private async performAutoCommitPush(taskId: string, gitlabInfo: GitLabInfo): Promise<void> {
    try {
      const commitMessage = this.generateCommitMessage(gitlabInfo);

      const commitPushResult = await this.gitlabGitService.commitAndPush(commitMessage);

      if (commitPushResult.success) {
        if (commitPushResult.commitResult.commitHash) {
        }

        if (commitPushResult.pushResult.pushedBranch) {
        }

        // Handle task success: add success comment and update issue status
        await this.handleTaskSuccess(taskId, gitlabInfo, commitPushResult);
      } else {
        // Determine the specific failure type for better error handling
        if (commitPushResult.commitResult.success && !commitPushResult.pushResult.success) {
          // Commit succeeded but push failed
          const pushError = new Error(`Push failed: ${commitPushResult.pushResult.error}`);
          await this.handleCommitPushFailure(
            taskId,
            gitlabInfo,
            pushError,
            commitPushResult.commitResult,
          );
        } else {
          // Commit failed
          const commitError = new Error(
            `Commit failed: ${commitPushResult.commitResult.error || commitPushResult.error}`,
          );
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
  private async handleActionFailure(
    taskId: string,
    gitlabInfo: GitLabInfo,
    actionResults: ActionResult[],
  ): Promise<void> {
    try {
      const failedActions = actionResults.filter((r) => !r.success);
      const successfulActions = actionResults.filter((r) => r.success);

      const errorComment = this.generateErrorComment("action_failure", {
        timestamp: new Date().toISOString(),
        failedActions: failedActions.map((r) => ({
          error: r.error,
        })),
        successfulActions: successfulActions.length,
        failedActionsCount: failedActions.length,
        containerId: gitlabInfo.containerId,
      });

      // Add error comment to GitLab issue
      await this.addIssueErrorComment(gitlabInfo, errorComment);

      // Update issue status to REJECT (Phase 5 implementation)
      const issue = await this.getGitLabIssue(gitlabInfo.projectId, gitlabInfo.issueIid);
      if (issue) {
        const errorMessage = `Agent8 actions failed: ${failedActions.length}/${actionResults.length} actions failed`;
        await this.lifecycleWorkflow.onTaskExecutionFailure(issue, new Error(errorMessage));
      }
    } catch (error) {
      console.error(`[Agent8] Task ${taskId} - Failed to handle action failure:`, error);
    }
  }

  /**
   * Handle commit/push failures by logging and preparing for REJECT state
   */
  private async handleCommitPushFailure(
    taskId: string,
    gitlabInfo: GitLabInfo,
    error: Error,
    commitResult?: GitCommitResult,
  ): Promise<void> {
    try {
      console.error(`[Agent8] Task ${taskId} - Commit/Push failed:`, error.message);

      // Determine error type based on whether commit succeeded
      const errorType = commitResult?.success ? "push_failure" : "commit_failure";

      const errorComment = this.generateErrorComment(errorType, {
        timestamp: new Date().toISOString(),
        errorMessage: error.message,
        commitHash: commitResult?.commitHash,
        containerId: gitlabInfo.containerId,
      });

      // Add error comment to GitLab issue
      await this.addIssueErrorComment(gitlabInfo, errorComment);

      // Update issue status to REJECT (Phase 5 implementation)
      const issue = await this.getGitLabIssue(gitlabInfo.projectId, gitlabInfo.issueIid);
      if (issue) {
        await this.lifecycleWorkflow.onTaskExecutionFailure(issue, error);
      }
    } catch (handlingError) {
      console.error(
        `[Agent8] Task ${taskId} - Failed to handle commit/push failure:`,
        handlingError,
      );
    }
  }

  /**
   * Generate commit message based on GitLab issue information
   */
  private generateCommitMessage(gitlabInfo: GitLabInfo): string {
    const title = gitlabInfo.issueTitle;
    const description = gitlabInfo.issueDescription;

    if (!description || description.trim() === "") {
      return title;
    }

    return `${title}\n\n${description}`;
  }

  /**
   * Generate error comment templates for different failure types
   */
  private generateErrorComment(
    errorType: "action_failure" | "commit_failure" | "push_failure",
    details: any,
  ): string {
    const timestamp = new Date().toISOString();
    const errorDetails: ErrorDetails = {
      timestamp,
      errorMessage: details.errorMessage,
      containerId: details.containerId,
      commitHash: details.commitHash,
      failedActions: details.failedActions,
      successfulActions: details.successfulActions,
      failedActionsCount: details.failedActionsCount,
    };

    switch (errorType) {
      case "action_failure":
        return createActionFailureComment(errorDetails);
      case "commit_failure":
        return createCommitFailureComment(errorDetails);
      case "push_failure":
        return createPushFailureComment(errorDetails);
      default:
        return createComment(
          "Unknown Error",
          "❌",
          [
            {
              title: "Technical Details",
              emoji: "📋",
              content: [`**Container ID**: \`${errorDetails.containerId}\``],
            },
          ],
          "*Agent8 automatic error report*",
        );
    }
  }

  /**
   * Handle task success: add success comment and update issue status to CONFIRM NEEDED
   */
  private async handleTaskSuccess(
    taskId: string,
    gitlabInfo: GitLabInfo,
    commitResult: GitCommitPushResult,
  ): Promise<void> {
    try {
      // Generate success comment
      const successComment = this.generateSuccessComment(gitlabInfo, commitResult);

      // Update issue status to CONFIRM NEEDED (Phase 5 implementation)
      const issue = await this.getGitLabIssue(gitlabInfo.projectId, gitlabInfo.issueIid);
      if (issue) {
        await this.lifecycleWorkflow.onTaskCompletion(issue, {
          containerId: gitlabInfo.containerId,
          commitHash: commitResult.commitResult.commitHash,
          pushedBranch: commitResult.pushResult.pushedBranch,
        });
      }

      // Add success comment to GitLab issue
      await this.addIssueSuccessComment(gitlabInfo, successComment);
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
    commitResult: GitCommitPushResult,
  ): string {
    const successDetails: SuccessDetails = {
      timestamp: new Date().toISOString(),
      containerId: gitlabInfo.containerId,
      commitHash: commitResult.commitResult.commitHash,
      pushedBranch: commitResult.pushResult.pushedBranch,
    };

    return createSuccessComment(successDetails);
  }

  /**
   * Add success comment to GitLab issue
   */
  private async addIssueSuccessComment(gitlabInfo: GitLabInfo, comment: string): Promise<void> {
    try {
      await this.gitlabClient.addIssueComment(gitlabInfo.projectId, gitlabInfo.issueIid, comment);
    } catch (error) {
      console.error(
        `[Agent8] Failed to add success comment to issue #${gitlabInfo.issueIid}:`,
        error,
      );
    }
  }

  /**
   * Add error comment to GitLab issue
   */
  private async addIssueErrorComment(gitlabInfo: GitLabInfo, comment: string): Promise<void> {
    try {
      await this.gitlabClient.addIssueComment(gitlabInfo.projectId, gitlabInfo.issueIid, comment);
    } catch (error) {
      console.error(
        `[Agent8] Failed to add error comment to issue #${gitlabInfo.issueIid}:`,
        error,
      );
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
    this.stopIssueMonitoring();

    const activeTasks = this.getActiveTasksInfo();
    let _terminatedCount = 0;

    for (const task of activeTasks) {
      if (task.status === "pending" || task.status === "running") {
        this.forceCompleteTask(task.id, `Issue #${event.issue.iid} marked as DONE`);
        _terminatedCount++;
      }
    }
  }

  private async startIssueMonitoring(gitlabInfo: GitLabInfo): Promise<void> {
    this.stopIssueMonitoring();

    this.currentGitLabInfo = gitlabInfo;
    this.previousIssueState = await this.getCurrentIssueState(gitlabInfo);

    this.issuePollingInterval = setInterval(async () => {
      await this.checkIssueChanges();
    }, this.POLLING_INTERVAL);
  }

  private async getCurrentIssueState(gitlabInfo: GitLabInfo): Promise<IssueState> {
    const issue = await this.gitlabClient.getIssue(gitlabInfo.projectId, gitlabInfo.issueIid);
    const comments = await this.gitlabClient.getIssueComments(
      gitlabInfo.projectId,
      gitlabInfo.issueIid,
    );

    return {
      labels: issue.labels || [],
      lastCommentAt: comments.length > 0 ? comments[comments.length - 1].created_at : null,
      commentCount: comments.length,
      lastComment: comments.length > 0 ? comments[comments.length - 1] : null,
      updatedAt: issue.updated_at,
    };
  }

  private async checkIssueChanges(): Promise<void> {
    if (!(this.currentGitLabInfo && this.previousIssueState)) {
      return;
    }

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
      console.error("[Agent8] Error checking issue changes:", error);
    }
  }

  private hasLabelChanged(previous: IssueState, current: IssueState): boolean {
    return JSON.stringify(previous.labels.sort()) !== JSON.stringify(current.labels.sort());
  }

  private hasCommentChanged(previous: IssueState, current: IssueState): boolean {
    return (
      previous.commentCount !== current.commentCount ||
      previous.lastCommentAt !== current.lastCommentAt
    );
  }

  private async handleLabelChange(
    previousState: IssueState,
    currentState: IssueState,
  ): Promise<void> {
    if (!this.currentGitLabInfo) {
      return;
    }

    const issue = await this.gitlabClient.getIssue(
      this.currentGitLabInfo.projectId,
      this.currentGitLabInfo.issueIid,
    );

    const labelChangeEvent: LabelChangeEvent = {
      issue: issue,
      previousLabels: previousState.labels,
      currentLabels: currentState.labels,
      changedAt: new Date(),
      changeType: "modified",
    };

    await this.lifecycleWorkflow.onLabelChange(labelChangeEvent);
  }

  private async handleCommentChange(
    _previousState: IssueState,
    currentState: IssueState,
  ): Promise<void> {
    if (!currentState.lastComment) {
      return;
    }

    if (currentState.lastComment.system) {
      return;
    }
  }

  private stopIssueMonitoring(): void {
    if (this.issuePollingInterval) {
      clearInterval(this.issuePollingInterval);
      this.issuePollingInterval = null;
    }
  }

  private async initRawStreamingFile(taskId: string): Promise<fs.FileHandle> {
    try {
      const responseDir = path.join("/", ".agent8", "llm-responses");
      await fs.mkdir(responseDir, { recursive: true });

      const rawFilePath = path.join(responseDir, `${taskId}.raw`);
      const fileHandle = await fs.open(rawFilePath, "w");
      return fileHandle;
    } catch (error) {
      console.error("[Agent8] Failed to initialize raw streaming file:", error);
      throw error;
    }
  }

  private async appendToRawFile(fileHandle: fs.FileHandle, chunk: string): Promise<void> {
    try {
      await fileHandle.write(chunk, null, "utf8");
      await fileHandle.sync();
    } catch (error) {
      console.error("[Agent8] Failed to append to raw file:", error);
    }
  }

  private async finalizeRawFile(fileHandle: fs.FileHandle): Promise<void> {
    try {
      await fileHandle.sync();
    } catch (error) {
      console.error("[Agent8] Failed to finalize raw file:", error);
    }
  }

  private async closeRawFile(fileHandle: fs.FileHandle): Promise<void> {
    try {
      await fileHandle.close();
    } catch (error) {
      console.error("[Agent8] Failed to close raw file:", error);
    }
  }

  private async saveMetadata(taskId: string, metadata: any): Promise<void> {
    try {
      const responseDir = path.join("/", ".agent8", "llm-responses");
      await fs.mkdir(responseDir, { recursive: true });

      const jsonFile = path.join(responseDir, `${taskId}.json`);
      await fs.writeFile(jsonFile, JSON.stringify(metadata, null, 2), "utf8");
    } catch (error) {
      console.error("[Agent8] Failed to save metadata:", error);
    }
  }

  private async buildFileMapFromWorkdir(): Promise<FileMap> {
    const result = await this.fileMapBuilder.buildFileMap();

    // If no files were processed, this indicates a critical problem
    if (result.stats.processedFiles === 0) {
      console.error("[Agent8] FileMap build failed: No files were processed");
      throw new Error("FileMap build failed: No source files found or processed");
    }

    // Log warnings but continue (minor issues like some binary files, etc.)
    if (result.stats.errors.length > 0) {
      console.warn(
        `[Agent8] FileMap build completed with ${result.stats.errors.length} warnings:`,
        result.stats.errors.slice(0, 3),
      );
    }

    return result.fileMap;
  }

  public cleanup(): void {
    this.stopIssueMonitoring();
  }

  // ========================================
  // Phase 2: Current Task Access Methods
  // ========================================

  /**
   * Get current task ID (1 container = 1 task principle)
   * Returns the most recent task ID in the container
   */
  public async getCurrentTaskId(): Promise<string | null> {
    try {
      const responseDir = path.join("/", ".agent8", "llm-responses");

      // Check if directory exists
      try {
        await fs.access(responseDir);
      } catch {
        return null;
      }

      const files = await fs.readdir(responseDir);
      const jsonFiles = files.filter((file) => file.endsWith(".json"));

      if (jsonFiles.length === 0) {
        return null;
      }

      // Find the most recent task (by timestamp in filename)
      const taskFiles = jsonFiles
        .map((file) => file.replace(".json", ""))
        .filter((taskId) => taskId.startsWith("agent8-task_"))
        .sort((a, b) => {
          // Extract timestamp from taskId format: agent8-task_1735123456_abc123
          const timestampA = Number.parseInt(a.split("_")[1]) || 0;
          const timestampB = Number.parseInt(b.split("_")[1]) || 0;
          return timestampB - timestampA; // Most recent first
        });

      const currentTaskId = taskFiles[0] || null;

      if (currentTaskId) {
      } else {
      }

      return currentTaskId;
    } catch (error) {
      console.error("[Agent8] Failed to get current task ID:", error);
      return null;
    }
  }

  /**
   * Load current task's raw content (AI SDK Data Stream)
   * No taskId required - uses current container's task
   */
  public async loadCurrentRawContent(): Promise<string | null> {
    try {
      const taskId = await this.getCurrentTaskId();
      if (!taskId) {
        return null;
      }

      return await this.loadRawContent(taskId);
    } catch (error) {
      console.error("[Agent8] Failed to load current raw content:", error);
      return null;
    }
  }

  /**
   * Load current task's metadata
   * No taskId required - uses current container's task
   */
  public async loadCurrentMetadata(): Promise<TaskResponseData | null> {
    try {
      const taskId = await this.getCurrentTaskId();
      if (!taskId) {
        return null;
      }

      return await this.loadMetadata(taskId);
    } catch (error) {
      console.error("[Agent8] Failed to load current metadata:", error);
      return null;
    }
  }

  /**
   * Load raw content by taskId (Phase 1 method, kept for backwards compatibility)
   */
  public async loadRawContent(taskId: string): Promise<string | null> {
    try {
      const responseDir = path.join("/", ".agent8", "llm-responses");
      const rawFilePath = path.join(responseDir, `${taskId}.raw`);

      const content = await fs.readFile(rawFilePath, "utf8");
      return content;
    } catch (error) {
      console.error(`[Agent8] Failed to load raw content for task ${taskId}:`, error);
      return null;
    }
  }

  /**
   * Load metadata by taskId (Phase 1 method, kept for backwards compatibility)
   */
  public async loadMetadata(taskId: string): Promise<TaskResponseData | null> {
    try {
      const responseDir = path.join("/", ".agent8", "llm-responses");
      const jsonFilePath = path.join(responseDir, `${taskId}.json`);

      const content = await fs.readFile(jsonFilePath, "utf8");
      const metadata = JSON.parse(content) as TaskResponseData;
      return metadata;
    } catch (error) {
      console.error(`[Agent8] Failed to load metadata for task ${taskId}:`, error);
      return null;
    }
  }

  /**
   * Set MCP configuration on container server
   */
  private setContainerMcpConfiguration(mcpConfig: string): void {
    try {
      if (this.containerServer && typeof this.containerServer.setMcpConfiguration === 'function') {
        this.containerServer.setMcpConfiguration(mcpConfig);
        console.log('[MCP] Container MCP configuration set successfully');
      } else {
        console.warn('[MCP] Container server does not support MCP configuration');
      }
    } catch (error) {
      console.error('[MCP] Failed to set container MCP configuration:', error);
    }
  }

  /**
   * Build HTTP headers for LLM server requests with MCP configuration
   */
  private buildHeaders(request: ChatRequest): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Agent8-Container/1.0',
      'Authorization': `Bearer ${request.token}`,
    };

    let cookieString = "";

    // Add existing cookies
    if (request.cookies) {
      cookieString = request.cookies;
    }

    // Add token cookie for backward compatibility
    if (request.token) {
      const tokenCookie = `v8AccessToken=${request.token}`;
      if (cookieString) {
        cookieString += `; ${tokenCookie}`;
      } else {
        cookieString = tokenCookie;
      }
    }

    // Add MCP configuration to cookies if available
    if (request.mcpConfig) {
      const mcpCookie = request.mcpConfig;
      if (cookieString) {
        cookieString += `; ${mcpCookie}`;
      } else {
        cookieString = mcpCookie;
      }
      console.log('[MCP] Adding MCP configuration to LLM server request');
    }

    // Set final cookie header
    if (cookieString) {
      headers.Cookie = cookieString;
    }

    return headers;
  }

  /**
   * Enhanced LLM server payload construction with MCP context
   */
  private buildLLMPayload(request: ChatRequest): any {
    const payload: any = {
      messages: request.messages,
      files: request.files,
      ...(request.promptId && { promptId: request.promptId }),
      ...(request.contextOptimization !== undefined && {
        contextOptimization: request.contextOptimization,
      }),
    };

    // Add MCP server information to payload for LLM server awareness
    if (request.mcpConfig) {
      const mcpData = ConfigurationFormatter.parseMcpConfiguration(request.mcpConfig);
      if (mcpData && mcpData.servers.length > 0) {
        payload.mcpContext = {
          availableServers: mcpData.servers.map((server: any) => server.name),
          serverCount: mcpData.servers.length,
          enabledServers: mcpData.servers.filter((s: any) => s.enabled).length,
        };
      }
    }

    return payload;
  }

  /**
   * MCP integration diagnostics
   */
  private logMcpIntegrationStatus(request: ChatRequest): void {
    if (request.mcpConfig) {
      const mcpData = ConfigurationFormatter.parseMcpConfiguration(request.mcpConfig);
      if (mcpData) {
        console.log(`[MCP-Integration] Found ${mcpData.servers.length} MCP servers for task`);
        mcpData.servers.forEach((server: any) => {
          console.log(`[MCP-Integration] Server: ${server.name} (${server.url}) - ${server.enabled ? 'Enabled' : 'Disabled'}`);
        });
      } else {
        console.warn('[MCP-Integration] Failed to parse MCP configuration');
      }
    } else {
      console.log('[MCP-Integration] No MCP configuration available for this task');
    }
  }
}
