import type { GitLabIssueRepository } from "../repositories/gitlabIssueRepository.js";
import type { GitLabLabelService } from "../services/gitlabLabelService.js";
import {
  type GitLabIssue,
  type IssueRetryState,
  LIFECYCLE_LABELS,
  type LabelChangeEvent,
  type LifecycleLabel,
} from "../types/index.js";

// Issue completion event type definition
export interface IssueCompletionEvent {
  issue: GitLabIssue;
  containerId: string;
  timestamp: Date;
}

// Event listener type definition
export type IssueCompletionListener = (event: IssueCompletionEvent) => Promise<void>;

export class IssueLifecycleWorkflow {
  private labelService: GitLabLabelService;
  private issueRepository: GitLabIssueRepository;
  private retryStates: Map<number, IssueRetryState> = new Map();
  private issueCompletionListeners: Set<IssueCompletionListener> = new Set();

  constructor(labelService: GitLabLabelService, issueRepository: GitLabIssueRepository) {
    this.labelService = labelService;
    this.issueRepository = issueRepository;
  }

  /**
   * Register issue completion event listener
   */
  public onIssueCompletion(listener: IssueCompletionListener): void {
    this.issueCompletionListeners.add(listener);
  }

  /**
   * Remove issue completion event listener
   */
  public offIssueCompletion(listener: IssueCompletionListener): void {
    this.issueCompletionListeners.delete(listener);
  }

  async onContainerCreationStart(issue: GitLabIssue): Promise<void> {
    const currentLabel = this.labelService.getCurrentLifecycleLabel(issue);

    if (currentLabel === "TODO") {
      if (this.labelService.isValidTransition(currentLabel, "WIP")) {
        await this.labelService.updateIssueLifecycleLabel(
          issue,
          "WIP",
          "Container creation started",
        );
      }
    } else if (!currentLabel) {
      console.warn(`[Lifecycle] Issue #${issue.iid} has no current label`);
    }
  }

  onContainerCreationSuccess(issue: GitLabIssue, _containerId: string): void {
    this.retryStates.delete(issue.id);
  }

  async onTaskCompletion(issue: GitLabIssue, taskResult: any): Promise<void> {
    const currentLabel = this.labelService.getCurrentLifecycleLabel(issue);

    if (currentLabel === "WIP") {
      if (this.labelService.isValidTransition(currentLabel, "CONFIRM NEEDED")) {
        await this.labelService.updateIssueLifecycleLabel(
          issue,
          "CONFIRM NEEDED",
          `Task completed successfully. Container: ${taskResult.containerId || "unknown"}`,
        );
      }
    }
  }

  async onContainerCreationFailure(issue: GitLabIssue, error: Error): Promise<void> {
    const retryState = this.getOrCreateRetryState(issue);
    const currentLabel = this.labelService.getCurrentLifecycleLabel(issue);

    retryState.currentAttempt++;
    retryState.lastAttemptAt = new Date();
    retryState.lastError = error.message;

    if (retryState.currentAttempt >= retryState.maxAttempts) {
      if (this.labelService.isValidTransition(currentLabel, "REJECT")) {
        await this.labelService.updateIssueLifecycleLabel(
          issue,
          "REJECT",
          `Container creation failed after ${retryState.maxAttempts} attempts. Last error: ${error.message}`,
        );
      }

      this.retryStates.delete(issue.id);
    } else {
      const nextRetryMinutes = 30 * retryState.currentAttempt;
      retryState.nextRetryAt = new Date(Date.now() + nextRetryMinutes * 60 * 1000);
    }
  }

  async onTaskExecutionFailure(issue: GitLabIssue, error: Error): Promise<void> {
    const currentLabel = this.labelService.getCurrentLifecycleLabel(issue);

    if (this.labelService.isValidTransition(currentLabel, "REJECT")) {
      await this.labelService.updateIssueLifecycleLabel(
        issue,
        "REJECT",
        `Task execution failed: ${error.message}`,
      );
    }
  }

  async onLabelChange(labelChangeEvent: LabelChangeEvent): Promise<void> {
    const { issue, previousLabels } = labelChangeEvent;

    const previousLifecycleLabel = previousLabels.find((label) =>
      LIFECYCLE_LABELS.includes(label as LifecycleLabel),
    ) as LifecycleLabel | undefined;

    const currentLifecycleLabel = this.labelService.getCurrentLifecycleLabel(issue);

    if (previousLifecycleLabel === "CONFIRM NEEDED" && currentLifecycleLabel === "DONE") {
      await this.handleIssueCompletion(issue);
    }

    if (previousLifecycleLabel === "REJECT" && currentLifecycleLabel === "TODO") {
      this.retryStates.delete(issue.id);

      // Reset processed_at to created_at to allow reprocessing
      try {
        await this.issueRepository.resetProcessedTime(issue.id);
      } catch (error) {
        console.error(`[Lifecycle] Failed to reset processed_at for issue #${issue.iid}:`, error);
      }
    }
  }

  getIssuesReadyForRetry(): IssueRetryState[] {
    const now = new Date();
    return Array.from(this.retryStates.values()).filter(
      (state) => state.nextRetryAt && state.nextRetryAt <= now,
    );
  }

  private async handleIssueCompletion(issue: GitLabIssue): Promise<void> {
    const issueRecord = await this.issueRepository.findByGitLabIssueId(issue.id);
    if (issueRecord?.container_id) {
      // Publish event
      const event: IssueCompletionEvent = {
        issue,
        containerId: issueRecord.container_id,
        timestamp: new Date(),
      };

      await this.notifyIssueCompletionListeners(event);
    }
  }

  /**
   * Notify all issue completion listeners about the event
   */
  private async notifyIssueCompletionListeners(event: IssueCompletionEvent): Promise<void> {
    if (this.issueCompletionListeners.size === 0) {
      return;
    }

    const promises = Array.from(this.issueCompletionListeners).map(async (listener) => {
      try {
        await listener(event);
      } catch (error) {
        console.error("[Lifecycle] Error in issue completion listener:", error);
      }
    });

    await Promise.all(promises);
  }

  private getOrCreateRetryState(issue: GitLabIssue): IssueRetryState {
    let retryState = this.retryStates.get(issue.id);

    if (!retryState) {
      retryState = {
        issueId: issue.id,
        currentAttempt: 0,
        maxAttempts: 3,
        lastAttemptAt: new Date(),
      };

      this.retryStates.set(issue.id, retryState);
    }

    return retryState;
  }
}
