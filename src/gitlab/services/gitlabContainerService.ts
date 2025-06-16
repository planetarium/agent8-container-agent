import { MachinePool } from '../../fly/machinePool.js';
import { GitLabIssue, ContainerCreationOptions } from '../types/index.js';
import { GitLabIssueRepository } from '../repositories/gitlabIssueRepository.js';
import { GitLabClient } from './gitlabClient.js';
import { GitLabTaskDelegationService } from './gitlabTaskDelegationService.js';
import { GitLabLabelService } from './gitlabLabelService.js';
import { IssueLifecycleWorkflow } from '../workflows/issueLifecycleWorkflow.js';
import { GitLabCommentFormatter } from '../utils/commentFormatter.js';
import type { ContainerCreationDetails } from '../utils/commentFormatter.js';

export class GitLabContainerService {
  private machinePool: MachinePool;
  private issueRepository: GitLabIssueRepository;
  private gitlabClient?: GitLabClient;
  private taskDelegationService: GitLabTaskDelegationService;
  private routerDomain: string;
  private labelService?: GitLabLabelService;
  private lifecycleWorkflow?: IssueLifecycleWorkflow;

  constructor(
    machinePool: MachinePool,
    issueRepository: GitLabIssueRepository,
    gitlabClient?: GitLabClient,
    routerDomain: string = process.env.FLY_ROUTER_DOMAIN || 'agent8.verse8.net'
  ) {
    this.machinePool = machinePool;
    this.issueRepository = issueRepository;
    this.gitlabClient = gitlabClient;
    this.routerDomain = routerDomain;

    // Initialize GitLabTaskDelegationService
    this.taskDelegationService = new GitLabTaskDelegationService(
      issueRepository,
      gitlabClient,
      routerDomain
    );

    // Initialize lifecycle management services if GitLab client is available
    if (gitlabClient) {
      this.labelService = new GitLabLabelService(gitlabClient, issueRepository);
      this.lifecycleWorkflow = new IssueLifecycleWorkflow(this.labelService, issueRepository);
    }

    console.log(`[GitLab-Container] Service initialized with domain: ${this.routerDomain}`);
  }

  async createContainerForIssue(issue: GitLabIssue): Promise<string | null> {
    try {
      // Step 0: Lifecycle hook - Container creation start
      if (this.lifecycleWorkflow) {
        await this.lifecycleWorkflow.onContainerCreationStart(issue);
      }

      const userId = this.generateUserId(issue);

      console.log(`[GitLab-Container] Creating container for issue #${issue.iid}`);

      // Step 1: Create container (existing logic)
      const containerId = await this.machinePool.createNewMachineWithUser(userId);

      if (!containerId) {
        console.error(`[GitLab-Container] Failed to create container for issue ${issue.id}`);

        // Lifecycle hook - Container creation failure
        if (this.lifecycleWorkflow) {
          await this.lifecycleWorkflow.onContainerCreationFailure(
            issue,
            new Error('Failed to create container')
          );
        }

        return null;
      }

      // Step 2: Wait for container readiness (new)
      console.log(`[GitLab-Container] Waiting for container ${containerId} to be ready...`);
      const isReady = await this.waitForContainerReady(containerId, 120000); // 2 minutes

      if (!isReady) {
        console.error(`[GitLab-Container] Container ${containerId} failed to become ready`);

        // Lifecycle hook - Container creation failure (readiness timeout)
        if (this.lifecycleWorkflow) {
          await this.lifecycleWorkflow.onContainerCreationFailure(
            issue,
            new Error('Container readiness timeout')
          );
        }

        await this.handleDelegationError(issue, containerId, new Error('Container readiness timeout'));
        return containerId; // Return container ID even if delegation fails
      }

      // Step 3: Configure container (existing)
      await this.configureContainerForGitLab(containerId, issue);

      // Step 4: Store GitLab issue information (existing)
      await this.issueRepository.markIssueProcessed(issue, containerId);

      // Lifecycle hook - Container creation success
      if (this.lifecycleWorkflow) {
        await this.lifecycleWorkflow.onContainerCreationSuccess(issue, containerId);
      }

      console.log(`[GitLab-Container] Container ${containerId} created and ready for issue #${issue.iid}`);

      // Step 5: Delegate task to container (new)
      await this.delegateTaskToContainer(issue, containerId);

      // Step 6: Send notifications (existing, but skip for now to avoid duplication)
      await Promise.all([
        this.sendWebhookNotification(issue, containerId),
        this.addIssueComment(issue, containerId)
      ]);

      return containerId;
    } catch (error) {
      console.error(`[GitLab-Container] Error creating container for issue ${issue.id}:`, error);

      // Lifecycle hook - Container creation failure (general error)
      if (this.lifecycleWorkflow) {
        await this.lifecycleWorkflow.onContainerCreationFailure(issue, error as Error);
      }

      return null;
    }
  }

  /**
   * Wait for container to be ready with exponential backoff
   */
  private async waitForContainerReady(containerId: string, maxWaitTime: number = 120000): Promise<boolean> {
    const startTime = Date.now();
    let attempt = 1;

    console.log(`[GitLab-Container] Starting health check for container ${containerId}`);

    while (Date.now() - startTime < maxWaitTime) {
      // Exponential backoff: 5s → 7.5s → 11.25s → ... (max 30s)
      const delay = Math.min(5000 * Math.pow(1.5, attempt - 1), 30000);

      try {
        const containerUrl = this.buildContainerUrl(containerId);
        const healthUrl = `${containerUrl}/api/health`;

        console.log(`[GitLab-Container] Health check attempt ${attempt} for ${containerId}: ${healthUrl}`);

        const response = await fetch(healthUrl, {
          method: 'GET',
          headers: { 'User-Agent': 'GitLab-Agent8-Integration' },
          signal: AbortSignal.timeout(5000) // 5 second timeout per request
        });

        if (response.ok) {
          const elapsed = Date.now() - startTime;
          console.log(`[GitLab-Container] ✅ Container ${containerId} is ready (${elapsed}ms, ${attempt} attempts)`);
          return true;
        } else {
          console.log(`[GitLab-Container] Health check failed with status ${response.status}`);
        }
      } catch (error) {
        console.log(`[GitLab-Container] Health check attempt ${attempt} failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }

      // Wait before next attempt
      await new Promise(resolve => setTimeout(resolve, delay));
      attempt++;
    }

    const elapsed = Date.now() - startTime;
    console.log(`[GitLab-Container] ❌ Container ${containerId} failed to become ready within ${maxWaitTime}ms (${elapsed}ms elapsed, ${attempt - 1} attempts)`);
    return false;
  }

  /**
   * Delegate task to container
   */
  private async delegateTaskToContainer(issue: GitLabIssue, containerId: string): Promise<void> {
    try {
      console.log(`[GitLab-Container] 🚀 Delegating task for issue #${issue.iid} to container ${containerId}`);

      const taskResult = await this.taskDelegationService.delegateTaskToContainer(
        issue,
        containerId,
        {
          timeout: 30000, // 30 second delegation timeout
          contextOptimization: true,
          promptId: 'gitlab-agent8',
          targetServerUrl: process.env.LLM_SERVER_URL
        }
      );

      if (taskResult) {
        console.log(`[GitLab-Container] ✅ Task ${taskResult.taskId} delegated successfully to container ${containerId}`);
        console.log(`[GitLab-Container] Container will autonomously report results to GitLab when complete`);
      } else {
        console.error(`[GitLab-Container] ❌ Task delegation failed for issue #${issue.iid}`);
        throw new Error('Task delegation returned null');
      }

    } catch (error) {
      console.error(`[GitLab-Container] ❌ Task delegation failed for issue #${issue.iid}:`, error);
      await this.handleDelegationError(issue, containerId, error as Error);
      throw error;
    }
  }

  /**
   * Handle delegation errors with GitLab feedback
   */
  private async handleDelegationError(issue: GitLabIssue, containerId: string, error: Error): Promise<void> {
    console.error(`[GitLab-Container] ❌ Task delegation error for issue #${issue.iid}:`, error);

    try {
      // Add error comment to GitLab issue
      if (this.gitlabClient) {
        const containerUrl = containerId ? this.buildContainerUrl(containerId) : 'N/A';

        const errorComment = `## ❌ Agent8 Task Delegation Failed

**Error**: ${error.message}
**Container**: ${containerId || 'Failed to create'}
**Timestamp**: ${new Date().toISOString()}

${containerId ? `**Manual Access**: [View Container](${containerUrl})` : ''}

**Action Required**: Manual intervention needed to process this issue.

---
*Generated automatically by Agent8 GitLab integration.*`;

        await this.gitlabClient.addIssueComment(
          issue.project_id,
          issue.iid,
          errorComment
        );

        console.log(`[GitLab-Container] Error comment added to issue #${issue.iid}`);
      }

      // Update database status (optional)
      // await this.issueRepository.updateIssueTaskStatus(issue.id, 'failed', error.message);

    } catch (commentError) {
      console.error(`[GitLab-Container] Failed to add error comment to issue #${issue.iid}:`, commentError);
    }
  }

  /**
   * Build container URL using app name and router domain
   */
  private buildContainerUrl(containerId: string): string {
    const appName = process.env.TARGET_APP_NAME || 'agent8';
    return `https://${appName}-${containerId}.${this.routerDomain}`;
  }

  private generateUserId(issue: GitLabIssue): string {
    return `gitlab-${issue.author.username}`;
  }

  private async configureContainerForGitLab(containerId: string, issue: GitLabIssue): Promise<void> {
    // Container configuration is now handled via HTTP API task delegation
    // GitLab information is passed directly through the /api/background-task endpoint
    console.log(`[GitLab-Container] Container ${containerId} configured for GitLab issue #${issue.iid}`);
    console.log(`[GitLab-Container] GitLab info will be passed via HTTP API during task delegation`);

    // Note: Environment variables are no longer needed as GitLab info is passed via HTTP API
    // This eliminates the complexity of dynamic environment variable management
  }

  private async sendWebhookNotification(issue: GitLabIssue, containerId: string): Promise<void> {
    const webhookUrl = process.env.WEBHOOK_URL;
    if (!webhookUrl) return;

    try {
      const payload = {
        text: `Container created automatically`,
        attachments: [
          {
            color: 'good',
            fields: [
              { title: 'Issue', value: `#${issue.iid} - ${issue.title}`, short: false },
              { title: 'Project', value: issue.project_id.toString(), short: true },
              { title: 'Author', value: issue.author.name, short: true },
              { title: 'Container ID', value: containerId, short: true },
              { title: 'Labels', value: issue.labels.join(', ') || 'None', short: true },
              { title: 'Issue URL', value: issue.web_url, short: false }
            ]
          }
        ]
      };

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        console.log(`[GitLab-Container] Webhook notification sent for issue ${issue.id}`);
      }
    } catch (error) {
      console.error('[GitLab-Container] Error sending webhook notification:', error);
    }
  }

  private async addIssueComment(issue: GitLabIssue, containerId: string): Promise<void> {
    if (!this.gitlabClient) return;

    try {
      const containerUrl = this.buildContainerUrl(containerId);

      const containerDetails: ContainerCreationDetails = {
        containerId,
        containerUrl,
        issueIid: issue.iid,
        issueTitle: issue.title,
        labels: issue.labels,
        authorName: issue.author.name,
        authorUsername: issue.author.username
      };

      const comment = GitLabCommentFormatter.createContainerCreatedComment(containerDetails);

      await this.gitlabClient.addIssueComment(issue.project_id, issue.iid, comment);
      console.log(`[GitLab-Container] Task delegation comment added to issue #${issue.iid}`);
    } catch (error) {
      console.error(`[GitLab-Container] Error adding comment to issue ${issue.id}:`, error);
    }
  }

  async getContainerForIssue(issueId: number): Promise<string | null> {
    const issue = await this.issueRepository.findIssueByContainerId(issueId.toString());
    return issue?.container_id || null;
  }

  async getIssueForContainer(containerId: string): Promise<GitLabIssue | null> {
    const issue = await this.issueRepository.findIssueByContainerId(containerId);
    if (!issue) return null;

    return {
      id: issue.gitlab_issue_id,
      iid: issue.gitlab_iid,
      project_id: issue.project_id,
      title: issue.title,
      description: issue.description,
      state: 'opened' as const,
      created_at: issue.created_at.toISOString(),
      updated_at: issue.processed_at.toISOString(),
      closed_at: null,
      closed_by: null,
      author: {
        id: 0,
        username: issue.author_username,
        name: issue.author_username,
        state: 'active',
        avatar_url: '',
        web_url: ''
      },
      assignees: [],
      assignee: null,
      labels: JSON.parse(issue.labels),
      milestone: null,
      web_url: issue.web_url,
      references: {
        short: `#${issue.gitlab_iid}`,
        relative: `#${issue.gitlab_iid}`,
        full: `${issue.web_url}`
      },
      time_stats: {
        time_estimate: 0,
        total_time_spent: 0,
        human_time_estimate: null,
        human_total_time_spent: null
      },
      confidential: false,
      discussion_locked: false,
      issue_type: 'issue',
      severity: 'UNKNOWN',
      task_completion_status: {
        count: 0,
        completed_count: 0
      }
    };
  }

  async onTaskCompletion(issue: GitLabIssue, taskResult: any): Promise<void> {
    if (this.lifecycleWorkflow) {
      await this.lifecycleWorkflow.onTaskCompletion(issue, taskResult);
    }
  }

  async onTaskExecutionFailure(issue: GitLabIssue, error: Error): Promise<void> {
    if (this.lifecycleWorkflow) {
      await this.lifecycleWorkflow.onTaskExecutionFailure(issue, error);
    }
  }
}
