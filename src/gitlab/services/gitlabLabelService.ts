import type { GitLabIssueRepository } from "../repositories/gitlabIssueRepository.js";
import {
  type GitLabIssue,
  LIFECYCLE_LABELS,
  LIFECYCLE_TRANSITIONS,
  type LabelChangeEvent,
  type LifecycleConfig,
  type LifecycleLabel,
  type LifecycleTransition,
} from "../types/index.js";
import { createStatusUpdateComment } from "../utils/commentFormatter.js";
import type { GitLabClient } from "./gitlabClient.js";

export class GitLabLabelService {
  private gitlabClient: GitLabClient;
  private issueRepository: GitLabIssueRepository;
  private config: LifecycleConfig;

  constructor(
    gitlabClient: GitLabClient,
    issueRepository: GitLabIssueRepository,
    config?: Partial<LifecycleConfig>,
  ) {
    this.gitlabClient = gitlabClient;
    this.issueRepository = issueRepository;
    this.config = {
      triggerLabels: process.env.CONTAINER_TRIGGER_LABELS?.split(",") || ["auto-container"],
      retryPolicy: {
        maxRetries: Number.parseInt(process.env.GITLAB_MAX_RETRIES || "3"),
        retryInterval: Number.parseInt(process.env.GITLAB_RETRY_INTERVAL_MINUTES || "30"),
      },
      labelCheckInterval: Number.parseInt(process.env.GITLAB_LABEL_CHECK_INTERVAL_MINUTES || "5"),
      enabled: process.env.GITLAB_LIFECYCLE_ENABLED === "true",
      ...config,
    };
  }

  async updateIssueLifecycleLabel(
    issue: GitLabIssue,
    newLabel: LifecycleLabel,
    reason = "System update",
  ): Promise<void> {
    try {
      const currentLabels = [...issue.labels];
      const filteredLabels = currentLabels.filter(
        (label) => !LIFECYCLE_LABELS.includes(label as LifecycleLabel),
      );

      const newLabels = [...filteredLabels, newLabel];

      await this.gitlabClient.updateIssueLabels(issue.project_id, issue.iid, newLabels);
      await this.recordLifecycleTransition(issue, newLabel, reason, "system");
      await this.addLifecycleComment(issue, newLabel, reason);
    } catch (error) {
      console.error(`[Lifecycle] Failed to update issue #${issue.iid} label:`, error);
      throw error;
    }
  }

  async detectLabelChanges(lastCheckTime: Date): Promise<LabelChangeEvent[]> {
    try {
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
              changeType: this.determineChangeType(previousLabels, currentLabels),
            });

            await this.issueRepository.updateIssueLabels(issue.id, currentLabels);
          }
        }
      }
      return labelChanges;
    } catch (error) {
      console.error("[Lifecycle] Error detecting label changes:", error);
      return [];
    }
  }

  getCurrentLifecycleLabel(issue: GitLabIssue): LifecycleLabel | null {
    const lifecycleLabel = issue.labels.find((label) =>
      LIFECYCLE_LABELS.includes(label as LifecycleLabel),
    );

    return (lifecycleLabel as LifecycleLabel) || null;
  }

  hasTriggerLabel(issue: GitLabIssue): boolean {
    return issue.labels.some((label) => this.config.triggerLabels.includes(label));
  }

  isValidTransition(from: LifecycleLabel | null, to: LifecycleLabel): boolean {
    if (!from) {
      return true;
    }
    return LIFECYCLE_TRANSITIONS[from].includes(to);
  }

  private async recordLifecycleTransition(
    issue: GitLabIssue,
    newLabel: LifecycleLabel,
    reason: string,
    triggeredBy: "system" | "user" | "error",
  ): Promise<void> {
    const _transition: LifecycleTransition = {
      from: this.getCurrentLifecycleLabel(issue),
      to: newLabel,
      reason,
      triggeredBy,
      timestamp: new Date(),
    };
    // TODO: Store transition in database if needed
  }

  private async addLifecycleComment(
    issue: GitLabIssue,
    newLabel: LifecycleLabel,
    reason: string,
  ): Promise<void> {
    const comment = createStatusUpdateComment(newLabel, reason, new Date().toISOString());

    try {
      await this.gitlabClient.addIssueComment(issue.project_id, issue.iid, comment);
    } catch (error) {
      console.error(`[Lifecycle] Failed to add comment to issue #${issue.iid}:`, error);
    }
  }

  private determineChangeType(
    previousLabels: string[],
    currentLabels: string[],
  ): "added" | "removed" | "modified" {
    if (previousLabels.length < currentLabels.length) {
      return "added";
    }
    if (previousLabels.length > currentLabels.length) {
      return "removed";
    }
    return "modified";
  }
}
