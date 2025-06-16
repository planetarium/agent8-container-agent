import { GitLabIssue, TaskDelegationOptions, TaskDelegationResult, TaskStatusResult, ApiResponse } from '../types/index.js';
import { GitLabIssueRepository } from '../repositories/gitlabIssueRepository.js';
import { GitLabClient } from './gitlabClient.js';
import { getContainerAuthTokenForUser } from '../../container/containerAuthClient.js';
import { TaskPayload } from '../../container/containerTaskReporter.js';

export class GitLabTaskDelegationService {
  private issueRepository: GitLabIssueRepository;
  private gitlabClient?: GitLabClient;
  private routerDomain: string;

  constructor(
    issueRepository: GitLabIssueRepository,
    gitlabClient?: GitLabClient,
    routerDomain: string = process.env.FLY_ROUTER_DOMAIN || 'agent8.verse8.net'
  ) {
    this.issueRepository = issueRepository;
    this.gitlabClient = gitlabClient;
    this.routerDomain = routerDomain;

    console.log(`[GitLab-Agent8] TaskDelegationService initialized with domain: ${this.routerDomain}`);
  }

  /**
   * Main delegation method: Convert GitLab issue to Agent8 task and delegate to container
   */
  async delegateTaskToContainer(
    issue: GitLabIssue,
    containerId: string,
    options: Partial<TaskDelegationOptions> = {}
  ): Promise<TaskDelegationResult | null> {
    const startTime = new Date();
    console.log(`[GitLab-Agent8] Starting task delegation for issue #${issue.iid} to container ${containerId}`);

    try {
      // Validate required options
      if (!options.targetServerUrl) {
        throw new Error('targetServerUrl is required for task delegation');
      }

      // Step 1: Convert GitLab issue to Agent8 messages
      const messages = this.convertIssueToMessages(issue);
      console.log(`[GitLab-Agent8] Converted issue to ${messages.length} messages`);

      // Step 2: Build container URL
      const containerUrl = options.containerUrl || this.buildContainerUrl(containerId);
      console.log(`[GitLab-Agent8] Target container URL: ${containerUrl}`);

      // Step 3: Prepare task payload with GitLab info for autonomous reporting
      const payload: TaskPayload = {
        targetServerUrl: options.targetServerUrl,
        messages: messages,
        promptId: 'agent8',
        contextOptimization: options.contextOptimization ?? (process.env.GITLAB_CONTEXT_OPTIMIZATION === 'true'),
        files: {}, // Empty files object for now
        // 🔥 Add GitLab info for container autonomous reporting
        gitlabInfo: {
          projectId: issue.project_id,
          issueIid: issue.iid,
          issueUrl: issue.web_url,
          issueTitle: issue.title,
          issueDescription: issue.description,
          issueAuthor: await this.getUserEmail(issue.author.id, issue.author.username),
          containerId: containerId
        }
      };

      console.log(`[GitLab-Agent8] Task payload prepared:`, {
        targetServerUrl: payload.targetServerUrl,
        messagesCount: payload.messages.length,
        promptId: payload.promptId,
        contextOptimization: payload.contextOptimization,
        gitlabInfo: payload.gitlabInfo
      });

      // Step 4: Send task to container (using the issue author's email for authentication)
      const response = await this.sendTaskToContainer(containerUrl, payload);

      if (!response.success) {
        console.error(`[GitLab-Agent8] Task delegation failed:`, response.error);
        return null;
      }

      // Step 5: Create delegation result
      const result: TaskDelegationResult = {
        taskId: response.taskId!,
        containerId: containerId,
        status: 'pending',
        startTime: startTime,
        result: undefined
      };

      console.log(`[GitLab-Agent8] Task delegation successful: ${result.taskId}`);
      console.log(`[GitLab-Agent8] Container will autonomously report completion to GitLab issue #${issue.iid}`);
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
    taskResult?: any
  ): Promise<void> {
    if (!this.gitlabClient) {
      console.warn(`[GitLab-Agent8] No GitLab client available for issue comment`);
      return;
    }

    try {
      console.log(`[GitLab-Agent8] Adding completion comment to issue #${issue.iid}`);

      const status = result.status;
      const statusEmoji = this.getStatusEmoji(status);
      const containerUrl = this.buildContainerUrl(result.containerId);

      // Build execution summary
      const executedActions = taskResult?.executedActions || 0;
      const failedActions = taskResult?.failedActions || 0;
      const artifacts = taskResult?.artifacts || [];

      // Build artifact list
      let artifactList = '';
      if (artifacts.length > 0) {
        artifactList = artifacts.slice(0, 10).map((artifact: any) => {
          return `- \`${artifact.title || 'Untitled'}\``;
        }).join('\n');

        if (artifacts.length > 10) {
          artifactList += `\n- ... and ${artifacts.length - 10} more files`;
        }
      } else {
        artifactList = '_No files were created or modified_';
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
      console.log(`[GitLab-Agent8] Completion comment added to issue #${issue.iid}`);

    } catch (error) {
      console.error(`[GitLab-Agent8] Failed to add issue comment:`, error);
    }
  }

  /**
   * Convert GitLab issue to Agent8 message format (user message only)
   */
  private convertIssueToMessages(issue: GitLabIssue): any[] {
    if (!issue.description || issue.description.trim() === '') {
      throw new Error(`GitLab issue #${issue.iid} has no description`);
    }

    const userPrompt = issue.description;

    const messages = [
      { role: 'user', content: userPrompt }
    ];

    console.log(`[GitLab-Agent8] Issue converted to user message:`, {
      issueId: issue.iid,
      title: issue.title.substring(0, 50) + '...',
      messagesCount: messages.length,
      contentLength: userPrompt.length
    });

    return messages;
  }

  /**
   * Build container URL using app name and router domain
   */
  private buildContainerUrl(containerId: string): string {
    const appName = process.env.TARGET_APP_NAME || 'agent8-container';
    const url = `https://${appName}-${containerId}.${this.routerDomain}`;
    return url;
  }

    /**
   * Send task to container via HTTP API
   */
  private async sendTaskToContainer(containerUrl: string, payload: TaskPayload): Promise<ApiResponse> {
    const url = `${containerUrl}/api/agent8/task`;

    console.log(`[GitLab-Agent8] Sending task to container: ${url}`);

    // Extract user email from payload
    const userEmail = payload.gitlabInfo?.issueAuthor;
    if (!userEmail) {
      throw new Error('[GitLab-Agent8] User email not found in payload.gitlabInfo.issueAuthor');
    }

    console.log(`[GitLab-Agent8] Using authentication for user: ${userEmail}`);

    try {
      // Get user-specific authentication token
      const authServerUrl = process.env.AUTH_SERVER_URL || 'https://v8-meme-api.verse8.io/v1';
      const token = await getContainerAuthTokenForUser(authServerUrl, userEmail);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000) // 30 second timeout
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[GitLab-Agent8] Container API call failed (${response.status}):`, errorText);
        return {
          success: false,
          error: `HTTP ${response.status}: ${errorText}`
        };
      }

      const data: any = await response.json();
      console.log(`[GitLab-Agent8] Container task created successfully:`, {
        taskId: data.taskId,
        message: data.message
      });

      return {
        success: true,
        taskId: data.taskId,
        message: data.message,
        data: data
      };

    } catch (error) {
      console.error(`[GitLab-Agent8] Container API call error:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Get status emoji for task status
   */
  private getStatusEmoji(status: string): string {
    switch (status) {
      case 'completed': return '✅';
      case 'failed': return '❌';
      case 'running': return '🔄';
      case 'pending': return '⏳';
      default: return '❓';
    }
  }

  /**
   * Get user email address by user ID (required - throws error if not found)
   * Requires admin token to access private email addresses
   */
  private async getUserEmail(userId: number, username: string): Promise<string> {
    if (!this.gitlabClient) {
      throw new Error('[GitLab-Agent8] GitLab client not available for email lookup');
    }

    try {
      // Use direct API call to get user details with email
      const baseUrl = process.env.GITLAB_URL || 'https://gitlab.com';
      const token = process.env.GITLAB_TOKEN;

      if (!token) {
        throw new Error('[GitLab-Agent8] GitLab token not available for email lookup');
      }

      const response = await fetch(`${baseUrl}/api/v4/users/${userId}`, {
        headers: {
          'PRIVATE-TOKEN': token
        }
      });

      if (!response.ok) {
        throw new Error(`[GitLab-Agent8] Failed to fetch user details: ${response.status} ${response.statusText}`);
      }

      const user = await response.json() as { email?: string; public_email?: string };

      // Return email (available for admins) or public_email (available for regular users)
      const userEmail = user.email || user.public_email;

      if (!userEmail) {
        throw new Error(`[GitLab-Agent8] Could not retrieve email address for user ${username} (ID: ${userId}). Email is required for container authentication. Please ensure the user has a public email or the GitLab token has admin privileges.`);
      }

      return userEmail;

    } catch (error) {
      // Re-throw all errors since email is required
      throw error;
    }
  }
}
