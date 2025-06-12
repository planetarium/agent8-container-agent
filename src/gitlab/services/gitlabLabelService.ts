import { GitLabClient } from './gitlabClient.js';
import { GitLabIssueRepository } from '../repositories/gitlabIssueRepository.js';
import {
  GitLabIssue,
  LifecycleLabel,
  LabelChangeEvent,
  LifecycleTransition,
  LifecycleConfig,
  LIFECYCLE_LABELS,
  LIFECYCLE_TRANSITIONS
} from '../types/index.js';

export class GitLabLabelService {
  private gitlabClient: GitLabClient;
  private issueRepository: GitLabIssueRepository;
  private config: LifecycleConfig;

  constructor(
    gitlabClient: GitLabClient,
    issueRepository: GitLabIssueRepository,
    config?: Partial<LifecycleConfig>
  ) {
    this.gitlabClient = gitlabClient;
    this.issueRepository = issueRepository;
    this.config = {
      triggerLabels: process.env.CONTAINER_TRIGGER_LABELS?.split(',') || ['auto-container'],
      retryPolicy: {
        maxRetries: parseInt(process.env.GITLAB_MAX_RETRIES || '3'),
        retryInterval: parseInt(process.env.GITLAB_RETRY_INTERVAL_MINUTES || '30')
      },
      labelCheckInterval: parseInt(process.env.GITLAB_LABEL_CHECK_INTERVAL_MINUTES || '5'),
      enabled: process.env.GITLAB_LIFECYCLE_ENABLED === 'true',
      ...config
    };
  }

  async updateIssueLifecycleLabel(
    issue: GitLabIssue,
    newLabel: LifecycleLabel,
    reason: string = 'System update'
  ): Promise<void> {
    try {
      console.log(`[Lifecycle] Updating issue #${issue.iid} label to: ${newLabel}`);

      const currentLabels = [...issue.labels];
      const filteredLabels = currentLabels.filter(
        label => !LIFECYCLE_LABELS.includes(label as LifecycleLabel)
      );

      const newLabels = [...filteredLabels, newLabel];

      await this.gitlabClient.updateIssueLabels(issue.project_id, issue.iid, newLabels);
      await this.recordLifecycleTransition(issue, newLabel, reason, 'system');
      await this.addLifecycleComment(issue, newLabel, reason);

      console.log(`[Lifecycle] Successfully updated issue #${issue.iid} to ${newLabel}`);

    } catch (error) {
      console.error(`[Lifecycle] Failed to update issue #${issue.iid} label:`, error);
      throw error;
    }
  }

  async detectLabelChanges(lastCheckTime: Date): Promise<LabelChangeEvent[]> {
    try {
      console.log(`[Lifecycle] Checking for label changes since ${lastCheckTime.toISOString()}`);

      const recentIssues = await this.gitlabClient.fetchRecentlyUpdatedIssues(lastCheckTime);
      const labelChanges: LabelChangeEvent[] = [];

      for (const issue of recentIssues) {
        const storedIssue = await this.issueRepository.findByGitLabIssueId(issue.id);

        if (storedIssue) {
          const previousLabels = JSON.parse(storedIssue.labels);
          const currentLabels = issue.labels;

          if (JSON.stringify(previousLabels.sort()) !== JSON.stringify(currentLabels.sort())) {
            labelChanges.push({
              issue,
              previousLabels,
              currentLabels,
              changedAt: new Date(issue.updated_at),
              changeType: this.determineChangeType(previousLabels, currentLabels)
            });

            await this.issueRepository.updateIssueLabels(issue.id, currentLabels);
          }
        }
      }

      console.log(`[Lifecycle] Found ${labelChanges.length} label changes`);
      return labelChanges;

    } catch (error) {
      console.error('[Lifecycle] Error detecting label changes:', error);
      return [];
    }
  }

  getCurrentLifecycleLabel(issue: GitLabIssue): LifecycleLabel | null {
    const lifecycleLabel = issue.labels.find(
      label => LIFECYCLE_LABELS.includes(label as LifecycleLabel)
    );

    return lifecycleLabel as LifecycleLabel || null;
  }

  hasTriggerLabel(issue: GitLabIssue): boolean {
    return issue.labels.some(label => this.config.triggerLabels.includes(label));
  }

  isValidTransition(from: LifecycleLabel | null, to: LifecycleLabel): boolean {
    if (!from) return true;
    return LIFECYCLE_TRANSITIONS[from].includes(to);
  }

  private async recordLifecycleTransition(
    issue: GitLabIssue,
    newLabel: LifecycleLabel,
    reason: string,
    triggeredBy: 'system' | 'user' | 'error'
  ): Promise<void> {
    const transition: LifecycleTransition = {
      from: this.getCurrentLifecycleLabel(issue),
      to: newLabel,
      reason,
      triggeredBy,
      timestamp: new Date()
    };

    console.log(`[Lifecycle] Transition recorded:`, transition);
    // TODO: Store transition in database if needed
  }

  private async addLifecycleComment(
    issue: GitLabIssue,
    newLabel: LifecycleLabel,
    reason: string
  ): Promise<void> {
    const emoji = this.getLabelEmoji(newLabel);
    const comment = `${emoji} **Status Updated: ${newLabel}**

**Reason:** ${reason}
**Updated by:** System (GitLab Poller)
**Timestamp:** ${new Date().toISOString()}

---
*Automated lifecycle management by Agent8 GitLab Integration*`;

    try {
      await this.gitlabClient.addIssueComment(issue.project_id, issue.iid, comment);
    } catch (error) {
      console.error(`[Lifecycle] Failed to add comment to issue #${issue.iid}:`, error);
    }
  }

  private getLabelEmoji(label: LifecycleLabel): string {
    const emojiMap: Record<LifecycleLabel, string> = {
      'TODO': '📋',
      'WIP': '🔄',
      'CONFIRM NEEDED': '⏳',
      'DONE': '✅',
      'REJECT': '❌'
    };

    return emojiMap[label];
  }

  private determineChangeType(
    previousLabels: string[],
    currentLabels: string[]
  ): 'added' | 'removed' | 'modified' {
    if (previousLabels.length < currentLabels.length) return 'added';
    if (previousLabels.length > currentLabels.length) return 'removed';
    return 'modified';
  }
}
