import { getContainerAuthTokenForUser } from "../../container/containerAuthClient.js";
import type { TaskPayload } from "../../container/containerTaskReporter.js";
import type { McpConfigurationManager } from "../../agent8/mcpConfigurationManager.js";
import type { GitLabIssueRepository } from "../repositories/gitlabIssueRepository.js";
import type {
  ApiResponse,
  GitLabIssue,
  TaskDelegationOptions,
  TaskDelegationResult,
} from "../types/index.js";
import type { GitLabClient } from "./gitlabClient.js";

export class GitLabTaskDelegationService {
  private issueRepository: GitLabIssueRepository;
  private gitlabClient?: GitLabClient;
  private routerDomain: string;
  private mcpConfigManager?: McpConfigurationManager;

  constructor(
    issueRepository: GitLabIssueRepository,
    gitlabClient?: GitLabClient,
    routerDomain: string = process.env.FLY_ROUTER_DOMAIN || "agent8.verse8.net",
    mcpConfigManager?: McpConfigurationManager,
  ) {
    this.issueRepository = issueRepository;
    this.gitlabClient = gitlabClient;
    this.routerDomain = routerDomain;
    this.mcpConfigManager = mcpConfigManager;
  }

  /**
   * Main delegation method: Convert GitLab issue to Agent8 task and delegate to container
   */
  async delegateTaskToContainer(
    issue: GitLabIssue,
    containerId: string,
    options: Partial<TaskDelegationOptions> = {},
  ): Promise<TaskDelegationResult | null> {
    const startTime = new Date();

    try {
      // Validate required options
      if (!options.targetServerUrl) {
        throw new Error("targetServerUrl is required for task delegation");
      }

      // Step 1: Convert GitLab issue to Agent8 messages
      const messages = this.convertIssueToMessages(issue);

      // Step 2: Build container URL
      const containerUrl = options.containerUrl || this.buildContainerUrl(containerId);

      // Step 2.5: Get MCP configuration for this issue
      console.log(`[MCP-Integration] Starting MCP configuration retrieval for project ${issue.project_id}, issue #${issue.iid}`);

      const mcpConfig = this.mcpConfigManager
        ? await this.mcpConfigManager.prepareMcpConfigurationForIssue(
            issue.project_id,
            issue.iid
          )
        : null;

      if (mcpConfig) {
        console.log(`[MCP-Integration] ✅ Found MCP configuration for issue #${issue.iid}`);
        console.log(`[MCP-Integration] MCP config length: ${mcpConfig.length} characters`);
        console.log(`[MCP-Integration] MCP config preview: ${mcpConfig.substring(0, 200)}...`);
      } else {
        console.log(`[MCP-Integration] ❌ No MCP configuration available for this task`);
        console.log(`[MCP-Integration] MCP Config Manager available: ${!!this.mcpConfigManager}`);

        if (this.mcpConfigManager) {
          console.log(`[MCP-Integration] MCP Config Manager exists but returned null - this indicates no MCP metadata found`);
        }
      }

      // Step 3: Prepare task payload with GitLab info for autonomous reporting
      const payload: TaskPayload = {
        targetServerUrl: options.targetServerUrl,
        messages: messages,
        promptId: "agent8",
        contextOptimization:
          options.contextOptimization ?? process.env.GITLAB_CONTEXT_OPTIMIZATION === "true",
        files: {}, // Empty files object for now
        // 🔥 Add GitLab info for container autonomous reporting
        gitlabInfo: {
          projectId: issue.project_id,
          issueIid: issue.iid,
          issueUrl: issue.web_url,
          issueTitle: issue.title,
          issueDescription: issue.description,
          issueAuthor: this.gitlabClient
            ? await this.gitlabClient.getUserEmail(issue.author.id, issue.author.username)
            : issue.author.username,
          projectOwner: this.gitlabClient
            ? await this.gitlabClient.getProjectOwnerEmail(issue.project_id)
            : "unknown",
          containerId: containerId,
        },
        mcpConfig: mcpConfig || undefined,
      };

      // Step 4: Send task to container (using the issue author's email for authentication)
      const response = await this.sendTaskToContainer(containerUrl, payload);

      if (!response.success) {
        console.error("[GitLab-Agent8] Task delegation failed:", response.error);
        return null;
      }

      if (!response.taskId) {
        console.error("[GitLab-Agent8] Task delegation failed: no task ID");
        return null;
      }

      // Step 5: Create delegation result
      const result: TaskDelegationResult = {
        taskId: response.taskId,
        containerId: containerId,
        status: "pending",
        startTime: startTime,
        result: undefined,
      };
      return result;
    } catch (error) {
      console.error(`[GitLab-Agent8] Task delegation error for issue #${issue.iid}:`, error);
      return null;
    }
  }

  /**
   * Update GitLab issue with task execution results
   */
  async updateIssueWithTaskResult(
    issue: GitLabIssue,
    result: TaskDelegationResult,
    taskResult?: any,
  ): Promise<void> {
    if (!this.gitlabClient) {
      console.warn("[GitLab-Agent8] No GitLab client available for issue comment");
      return;
    }

    try {
      const status = result.status;
      const statusEmoji = this.getStatusEmoji(status);
      const containerUrl = this.buildContainerUrl(result.containerId);

      // Build execution summary
      const executedActions = taskResult?.executedActions || 0;
      const failedActions = taskResult?.failedActions || 0;
      const artifacts = taskResult?.artifacts || [];

      // Build artifact list
      let artifactList = "";
      if (artifacts.length > 0) {
        artifactList = artifacts
          .slice(0, 10)
          .map((artifact: any) => {
            return `- \`${artifact.title || "Untitled"}\``;
          })
          .join("\n");

        if (artifacts.length > 10) {
          artifactList += `\n- ... and ${artifacts.length - 10} more files`;
        }
      } else {
        artifactList = "_No files were created or modified_";
      }

      const comment = `## 🤖 Agent8 Task Completion Report

**Task ID:** \`${result.taskId}\`
**Container:** \`${result.containerId}\`
**Status:** ${statusEmoji} ${status.toUpperCase()}

**Execution Summary:**
- Actions Executed: ${executedActions}
- Failed Actions: ${failedActions}
- Files Modified: ${artifacts.length}

**Files Created/Modified:**
${artifactList}

**Container Access:** [View Container](${containerUrl})

---
*Generated automatically by Agent8 GitLab integration.*`;

      await this.gitlabClient.addIssueComment(issue.project_id, issue.iid, comment);
    } catch (error) {
      console.error("[GitLab-Agent8] Failed to add issue comment:", error);
    }
  }

  /**
   * Convert GitLab issue to Agent8 message format (user message only)
   */
  private convertIssueToMessages(issue: GitLabIssue): any[] {
    if (!issue.description || issue.description.trim() === "") {
      throw new Error(`GitLab issue #${issue.iid} has no description`);
    }

    const userPrompt = issue.description;

    const messages = [{ role: "user", content: userPrompt }];

    return messages;
  }

  /**
   * Build container URL using app name and router domain
   */
  private buildContainerUrl(containerId: string): string {
    const appName = process.env.TARGET_APP_NAME || "agent8-container";
    const url = `https://${appName}-${containerId}.${this.routerDomain}`;
    return url;
  }

  /**
   * Send task to container via HTTP API
   */
  private async sendTaskToContainer(
    containerUrl: string,
    payload: TaskPayload,
  ): Promise<ApiResponse> {
    const url = `${containerUrl}/api/agent8/task`;

    // Extract project owner email from payload for authentication
    const userEmail = payload.gitlabInfo?.projectOwner;
    if (!userEmail) {
      throw new Error(
        "[GitLab-Agent8] Project owner email not found in payload.gitlabInfo.projectOwner",
      );
    }

    try {
      // Get user-specific authentication token
      const authServerUrl = process.env.AUTH_SERVER_URL || "https://v8-meme-api.verse8.io/v1";
      const token = await getContainerAuthTokenForUser(authServerUrl, userEmail);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000), // 30 second timeout
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[GitLab-Agent8] Container API call failed (${response.status}):`, errorText);
        return {
          success: false,
          error: `HTTP ${response.status}: ${errorText}`,
        };
      }

      const data: any = await response.json();

      return {
        success: true,
        taskId: data.taskId,
        message: data.message,
        data: data,
      };
    } catch (error) {
      console.error("[GitLab-Agent8] Container API call error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Get status emoji for task status
   */
  private getStatusEmoji(status: string): string {
    switch (status) {
      case "completed":
        return "✅";
      case "failed":
        return "❌";
      case "running":
        return "🔄";
      case "pending":
        return "⏳";
      default:
        return "❓";
    }
  }
}
