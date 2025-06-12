/**
 * Container Task Reporter
 *
 * This module handles autonomous task execution and reporting to GitLab.
 * Containers use this to process Agent8 tasks and report results directly to GitLab issues.
 */
import { Agent8Client } from '../agent8';
import type { ContainerServer } from '../server';
import { ensureSafePath } from '../server';

export interface GitLabInfo {
  projectId: number;
  issueIid: number;
  issueUrl: string;
  issueTitle: string;
  issueAuthor: string;
  containerId: string;
}

export interface TaskPayload {
  targetServerUrl: string;
  messages: any[];
  promptId: string;
  contextOptimization: boolean;
  files: any;
  gitlabInfo: GitLabInfo;
}

export interface TaskResult {
  success: boolean;
  executedActions: number;
  failedActions: number;
  artifacts: any[];
  textChunks: string;
  error?: string;
}

export class ContainerTaskReporter {
  private gitlabToken: string | undefined;
  private gitlabBaseUrl: string;

  constructor() {
    // Read GitLab credentials from environment variables
    this.gitlabToken = process.env.GITLAB_TOKEN;
    this.gitlabBaseUrl = process.env.GITLAB_BASE_URL || 'https://gitlab.com';

    if (!this.gitlabToken) {
      console.warn('[Container-Reporter] GITLAB_TOKEN not found in environment variables');
    }

    console.log(`[Container-Reporter] Initialized with GitLab base URL: ${this.gitlabBaseUrl}`);
  }

  /**
   * Main entry point: Execute task and report to GitLab
   */
  async executeTaskAndReport(taskPayload: TaskPayload): Promise<void> {
    const { messages, gitlabInfo } = taskPayload;
    const startTime = Date.now();

    console.log(`[Container-Reporter] Starting task execution for GitLab issue #${gitlabInfo.issueIid}`);
    console.log(`[Container-Reporter] Task details:`, {
      projectId: gitlabInfo.projectId,
      issueIid: gitlabInfo.issueIid,
      issueTitle: gitlabInfo.issueTitle,
      messagesCount: messages.length
    });

    try {
      // Execute Agent8 task
      const result = await this.executeAgent8Task(taskPayload);

      const executionTime = Date.now() - startTime;
      console.log(`[Container-Reporter] Task completed successfully in ${executionTime}ms`);

      // Report success to GitLab
      await this.reportToGitLab(gitlabInfo, result, 'completed', executionTime);

    } catch (error) {
      const executionTime = Date.now() - startTime;
      console.error(`[Container-Reporter] Task execution failed after ${executionTime}ms:`, error);

      // Report failure to GitLab
      const errorResult: TaskResult = {
        success: false,
        executedActions: 0,
        failedActions: 1,
        artifacts: [],
        textChunks: '',
        error: error instanceof Error ? error.message : 'Unknown error'
      };

      await this.reportToGitLab(gitlabInfo, errorResult, 'failed', executionTime);
    }
  }

  /**
   * Execute Agent8 task using real Agent8Client
   */
  private async executeAgent8Task(taskPayload: TaskPayload): Promise<TaskResult> {

    console.log(`[Container-Reporter] Executing Agent8 task...`);
    console.log(`[Container-Reporter] Target server: ${taskPayload.targetServerUrl}`);
    console.log(`[Container-Reporter] Prompt ID: ${taskPayload.promptId}`);
    console.log(`[Container-Reporter] Messages count: ${taskPayload.messages.length}`);

            // Initialize Agent8Client
    const workdir = process.env.WORKDIR || '/app';

    // Create a minimal container server implementation for this context
    // Agent8Client primarily needs ContainerServer for ActionRunner, but ActionRunner
    // mainly uses the ensureSafePath function which we can provide directly
    const containerServer = {} as ContainerServer;

    const agent8Client = new Agent8Client(containerServer, workdir);

    try {
      // 🧪 테스트 모드: 환경변수에서 고정 토큰 사용
      let effectiveToken = process.env.GITLAB_TOKEN || '';
      const useTestToken = process.env.USE_TEST_TOKEN?.toLowerCase() === 'true';

      if (useTestToken && process.env.TEST_V8_ACCESS_TOKEN) {
        effectiveToken = process.env.TEST_V8_ACCESS_TOKEN;
        console.log(`[Container-Reporter] 🧪 TEST MODE: Using fixed token from environment variable`);
      }

      // Create task request in Agent8Client format
      const taskRequest = {
        userId: 'container-task',
        token: effectiveToken,
        targetServerUrl: taskPayload.targetServerUrl,
        messages: taskPayload.messages,
        files: taskPayload.files || {},
        promptId: taskPayload.promptId,
        contextOptimization: taskPayload.contextOptimization,
      };

      // Execute task
      const taskId = await agent8Client.createTask(taskRequest);
      console.log(`[Container-Reporter] Agent8 task created: ${taskId}`);

      // Monitor task completion
      let task = await agent8Client.getTaskStatus(taskId, 'container-task');
      let attempts = 0;
      const maxAttempts = 300; // 5 minutes max (1 second intervals)

      while (task && task.status !== 'completed' && task.status !== 'failed' && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        task = await agent8Client.getTaskStatus(taskId, 'container-task');
        attempts++;

        if (attempts % 10 === 0) {
          console.log(`[Container-Reporter] Task ${taskId} status: ${task?.status}, progress: ${task?.progress}%`);
        }
      }

      if (!task) {
        throw new Error('Task not found or was removed');
      }

      if (task.status === 'failed') {
        throw new Error(task.error || 'Task execution failed');
      }

      if (task.status !== 'completed') {
        throw new Error('Task execution timed out');
      }

      // Extract results from completed task
      const result = task.result || {};

      return {
        success: true,
        executedActions: result.executedActions || 0,
        failedActions: result.failedActions || 0,
        artifacts: result.artifacts || [],
        textChunks: result.textChunks || 'Task completed successfully.',
      };

    } catch (error) {
      console.error(`[Container-Reporter] Agent8 task execution failed:`, error);
      throw error;
    }
  }

  /**
   * Report task results to GitLab issue
   */
  private async reportToGitLab(
    gitlabInfo: GitLabInfo,
    result: TaskResult,
    status: 'completed' | 'failed',
    executionTime: number
  ): Promise<void> {
    if (!this.gitlabToken) {
      console.error('[Container-Reporter] Cannot report to GitLab: GITLAB_TOKEN not available');
      return;
    }

    try {
      const comment = this.generateResultComment(gitlabInfo, result, status, executionTime);

      const url = `${this.gitlabBaseUrl}/api/v4/projects/${gitlabInfo.projectId}/issues/${gitlabInfo.issueIid}/notes`;

      console.log(`[Container-Reporter] Posting result to GitLab: ${url}`);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.gitlabToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ body: comment })
      });

      if (response.ok) {
        console.log(`[Container-Reporter] ✅ Successfully reported ${status} to GitLab issue #${gitlabInfo.issueIid}`);
      } else {
        const errorText = await response.text();
        console.error(`[Container-Reporter] ❌ Failed to report to GitLab (${response.status}): ${errorText}`);

        // Retry once after a delay
        await new Promise(resolve => setTimeout(resolve, 5000));
        await this.retryGitLabReport(url, comment, gitlabInfo.issueIid);
      }

    } catch (error) {
      console.error(`[Container-Reporter] ❌ Error reporting to GitLab:`, error);

      // Retry once after a delay
      await new Promise(resolve => setTimeout(resolve, 5000));
      await this.retryGitLabReport(
        `${this.gitlabBaseUrl}/api/v4/projects/${gitlabInfo.projectId}/issues/${gitlabInfo.issueIid}/notes`,
        this.generateResultComment(gitlabInfo, result, status, executionTime),
        gitlabInfo.issueIid
      );
    }
  }

  /**
   * Retry GitLab API call once
   */
  private async retryGitLabReport(url: string, comment: string, issueIid: number): Promise<void> {
    try {
      console.log(`[Container-Reporter] Retrying GitLab report for issue #${issueIid}...`);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.gitlabToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ body: comment })
      });

      if (response.ok) {
        console.log(`[Container-Reporter] ✅ Retry successful for issue #${issueIid}`);
      } else {
        const errorText = await response.text();
        console.error(`[Container-Reporter] ❌ Retry failed for issue #${issueIid} (${response.status}): ${errorText}`);
      }
    } catch (error) {
      console.error(`[Container-Reporter] ❌ Retry error for issue #${issueIid}:`, error);
    }
  }

  /**
   * Generate GitLab comment with task results
   */
  private generateResultComment(
    gitlabInfo: GitLabInfo,
    result: TaskResult,
    status: 'completed' | 'failed',
    executionTime: number
  ): string {
    const statusEmoji = status === 'completed' ? '✅' : '❌';
    const executionTimeFormatted = `${(executionTime / 1000).toFixed(1)}s`;

    // Build artifact list
    let artifactList = '';
    if (result.artifacts && result.artifacts.length > 0) {
      artifactList = result.artifacts.slice(0, 10).map(artifact => {
        return `- \`${artifact.title || 'Untitled'}\` (${artifact.type || 'file'})`;
      }).join('\n');

      if (result.artifacts.length > 10) {
        artifactList += `\n- ... and ${result.artifacts.length - 10} more files`;
      }
    } else {
      artifactList = '_No files were created or modified_';
    }

    const containerUrl = `https://${process.env.TARGET_APP_NAME || 'agent8'}-${gitlabInfo.containerId}.${process.env.FLY_ROUTER_DOMAIN || 'agent8.verse8.net'}`;

    let comment = `## ${statusEmoji} Agent8 Task ${status === 'completed' ? 'Completion' : 'Failure'} Report

**Container**: \`${gitlabInfo.containerId}\`
**Execution Time**: ${executionTimeFormatted}
**Status**: ${statusEmoji} ${status.toUpperCase()}

**Execution Summary**:
- Actions Executed: ${result.executedActions}
- Failed Actions: ${result.failedActions}
- Files Modified: ${result.artifacts?.length || 0}

**Files Created/Modified**:
${artifactList}`;

    if (result.textChunks) {
      comment += `\n\n**Task Output**:\n\`\`\`\n${result.textChunks.slice(0, 1000)}${result.textChunks.length > 1000 ? '...' : ''}\n\`\`\``;
    }

    if (status === 'failed' && result.error) {
      comment += `\n\n**Error Details**:\n\`\`\`\n${result.error}\n\`\`\``;
    }

    comment += `\n\n**Container Access**: [View Container](${containerUrl})

---
*Generated automatically by Agent8 container at ${new Date().toISOString()}*`;

    return comment;
  }
}

/**
 * Express endpoint handler for /api/background-task
 */
export function createTaskEndpoint() {
  const reporter = new ContainerTaskReporter();

  return async (req: any, res: any) => {
    try {
      const taskPayload: TaskPayload = req.body;

      // Validate payload
      if (!taskPayload.messages || !taskPayload.gitlabInfo) {
        return res.status(400).json({
          success: false,
          error: 'Invalid task payload: missing messages or gitlabInfo'
        });
      }

      // Generate task ID
      const taskId = `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // Respond immediately
      res.json({
        success: true,
        taskId: taskId,
        status: 'accepted',
        message: 'Task accepted for processing'
      });

      // Execute task and report asynchronously
      reporter.executeTaskAndReport(taskPayload).catch(error => {
        console.error('[Container-Reporter] Async task execution failed:', error);
      });

    } catch (error) {
      console.error('[Container-Reporter] Endpoint error:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    }
  };
}
