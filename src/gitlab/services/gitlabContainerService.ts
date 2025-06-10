import { MachinePool } from '../../fly/machinePool.js';
import { GitLabIssue, ContainerCreationOptions } from '../types/index.js';
import { GitLabIssueRepository } from '../repositories/gitlabIssueRepository.js';
import { GitLabClient } from './gitlabClient.js';

export class GitLabContainerService {
  private machinePool: MachinePool;
  private issueRepository: GitLabIssueRepository;
  private gitlabClient?: GitLabClient;

  constructor(
    machinePool: MachinePool,
    issueRepository: GitLabIssueRepository,
    gitlabClient?: GitLabClient
  ) {
    this.machinePool = machinePool;
    this.issueRepository = issueRepository;
    this.gitlabClient = gitlabClient;
  }

  async createContainerForIssue(issue: GitLabIssue): Promise<string | null> {
    try {
      const userId = this.generateUserId(issue);

      console.log(`Creating container for issue #${issue.iid}`);

      // Use existing MachinePool method with minimal changes
      const containerId = await this.machinePool.createNewMachineWithUser(userId);

      if (!containerId) {
        console.error(`Failed to create container for issue ${issue.id}`);
        return null;
      }

      // Update container with GitLab environment variables after creation
      await this.configureContainerForGitLab(containerId, issue);

      // Store GitLab issue information
      await this.issueRepository.markIssueProcessed(issue, containerId);

      console.log(`Container ${containerId} created for issue #${issue.iid}`);

      // Send notifications
      await Promise.all([
        this.sendWebhookNotification(issue, containerId),
        this.addIssueComment(issue, containerId)
      ]);

      return containerId;
    } catch (error) {
      console.error(`Error creating container for issue ${issue.id}:`, error);
      return null;
    }
  }

  private generateUserId(issue: GitLabIssue): string {
    return `gitlab-${issue.author.username}`;
  }

  private async configureContainerForGitLab(containerId: string, issue: GitLabIssue): Promise<void> {
    // This method would ideally update container environment variables
    // For now, we'll store the mapping for future reference
    console.log(`Configured container ${containerId} for GitLab issue #${issue.iid}`);

    // Environment variables that would be set:
    const gitlabEnv = {
      GITLAB_ISSUE_ID: issue.id.toString(),
      GITLAB_ISSUE_IID: issue.iid.toString(),
      GITLAB_PROJECT_ID: issue.project_id.toString(),
      GITLAB_ISSUE_TITLE: issue.title,
      GITLAB_ISSUE_URL: issue.web_url,
      GITLAB_ISSUE_LABELS: issue.labels.join(','),
      GITLAB_ISSUE_AUTHOR: issue.author.username,
      TRIGGER_SOURCE: 'gitlab-poller',
      CREATED_BY: 'auto-trigger',
    };

    // NOTE: Actual environment variable setting would require
    // additional Fly.io API calls or restart mechanisms
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
        console.log(`Webhook notification sent for issue ${issue.id}`);
      }
    } catch (error) {
      console.error('Error sending webhook notification:', error);
    }
  }

  private async addIssueComment(issue: GitLabIssue, containerId: string): Promise<void> {
    if (!this.gitlabClient) return;

    try {
      const comment = `Container created automatically

Container ID: \`${containerId}\`
Access URL: \`https://${containerId}.your-domain.com\`

This container was created automatically based on issue labels.
Trigger labels: ${issue.labels.join(', ')}`;

      await this.gitlabClient.addIssueComment(issue.project_id, issue.iid, comment);
      console.log(`Comment added to issue #${issue.iid}`);
    } catch (error) {
      console.error(`Error adding comment to issue ${issue.id}:`, error);
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
}
