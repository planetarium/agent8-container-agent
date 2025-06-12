import { GitLabLabelService } from '../services/gitlabLabelService.js';
import { GitLabIssueRepository } from '../repositories/gitlabIssueRepository.js';
import {
  GitLabIssue,
  LifecycleLabel,
  IssueRetryState,
  LabelChangeEvent,
  LIFECYCLE_LABELS
} from '../types/index.js';

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

  constructor(
    labelService: GitLabLabelService,
    issueRepository: GitLabIssueRepository
  ) {
    this.labelService = labelService;
    this.issueRepository = issueRepository;
  }

  /**
   * Register issue completion event listener
   */
  public onIssueCompletion(listener: IssueCompletionListener): void {
    this.issueCompletionListeners.add(listener);
    console.log(`[Lifecycle] Issue completion listener registered (total: ${this.issueCompletionListeners.size})`);
  }

  /**
   * Remove issue completion event listener
   */
  public offIssueCompletion(listener: IssueCompletionListener): void {
    this.issueCompletionListeners.delete(listener);
    console.log(`[Lifecycle] Issue completion listener removed (remaining: ${this.issueCompletionListeners.size})`);
  }

  async onContainerCreationStart(issue: GitLabIssue): Promise<void> {
    const currentLabel = this.labelService.getCurrentLifecycleLabel(issue);

    if (currentLabel === 'TODO') {
      if (this.labelService.isValidTransition(currentLabel, 'WIP')) {
        await this.labelService.updateIssueLifecycleLabel(
          issue,
          'WIP',
          'Container creation started'
        );
      }
    } else if (!currentLabel) {
      console.log(`[Lifecycle] Issue #${issue.iid} has no lifecycle label, skipping container creation`);
    }
  }

  async onContainerCreationSuccess(issue: GitLabIssue, containerId: string): Promise<void> {
    this.retryStates.delete(issue.id);
    console.log(`[Lifecycle] Container ${containerId} created for issue #${issue.iid}, keeping WIP status`);
  }

  async onTaskCompletion(issue: GitLabIssue, taskResult: any): Promise<void> {
    const currentLabel = this.labelService.getCurrentLifecycleLabel(issue);

    if (currentLabel === 'WIP') {
      if (this.labelService.isValidTransition(currentLabel, 'CONFIRM NEEDED')) {
        await this.labelService.updateIssueLifecycleLabel(
          issue,
          'CONFIRM NEEDED',
          `Task completed successfully. Container: ${taskResult.containerId || 'unknown'}`
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
      if (this.labelService.isValidTransition(currentLabel, 'REJECT')) {
        await this.labelService.updateIssueLifecycleLabel(
          issue,
          'REJECT',
          `Container creation failed after ${retryState.maxAttempts} attempts. Last error: ${error.message}`
        );
      }

      this.retryStates.delete(issue.id);
    } else {
      const nextRetryMinutes = 30 * retryState.currentAttempt;
      retryState.nextRetryAt = new Date(Date.now() + nextRetryMinutes * 60 * 1000);

      console.log(`[Lifecycle] Issue #${issue.iid} will retry in ${nextRetryMinutes} minutes (attempt ${retryState.currentAttempt}/${retryState.maxAttempts})`);
    }
  }

  async onTaskExecutionFailure(issue: GitLabIssue, error: Error): Promise<void> {
    const currentLabel = this.labelService.getCurrentLifecycleLabel(issue);

    if (this.labelService.isValidTransition(currentLabel, 'REJECT')) {
      await this.labelService.updateIssueLifecycleLabel(
        issue,
        'REJECT',
        `Task execution failed: ${error.message}`
      );
    }
  }

  async onLabelChange(labelChangeEvent: LabelChangeEvent): Promise<void> {
    const { issue, previousLabels, currentLabels } = labelChangeEvent;

    const previousLifecycleLabel = previousLabels.find(
      label => LIFECYCLE_LABELS.includes(label as LifecycleLabel)
    ) as LifecycleLabel | undefined;

    const currentLifecycleLabel = this.labelService.getCurrentLifecycleLabel(issue);

    if (previousLifecycleLabel === 'CONFIRM NEEDED' && currentLifecycleLabel === 'DONE') {
      console.log(`[Lifecycle] Issue #${issue.iid} confirmed as DONE by external system`);
      await this.handleIssueCompletion(issue);
    }

    if (previousLifecycleLabel === 'REJECT' && currentLifecycleLabel === 'TODO') {
      console.log(`[Lifecycle] Issue #${issue.iid} restarted from REJECT to TODO`);
      this.retryStates.delete(issue.id);
    }
  }

  getIssuesReadyForRetry(): IssueRetryState[] {
    const now = new Date();
    return Array.from(this.retryStates.values()).filter(
      state => state.nextRetryAt && state.nextRetryAt <= now
    );
  }

  private async handleIssueCompletion(issue: GitLabIssue): Promise<void> {
    const issueRecord = await this.issueRepository.findByGitLabIssueId(issue.id);
    if (issueRecord?.container_id) {
      console.log(`[Lifecycle] Issue #${issue.iid} completed, notifying listeners for container ${issueRecord.container_id}`);

      // Publish event
      const event: IssueCompletionEvent = {
        issue,
        containerId: issueRecord.container_id,
        timestamp: new Date()
      };

      await this.notifyIssueCompletionListeners(event);

      console.log(`[Lifecycle] Issue #${issue.iid} completion event processed, container ${issueRecord.container_id} can be cleaned up`);
    }
  }

  /**
   * Notify all issue completion listeners about the event
   */
  private async notifyIssueCompletionListeners(event: IssueCompletionEvent): Promise<void> {
    if (this.issueCompletionListeners.size === 0) {
      console.log(`[Lifecycle] No listeners registered for issue completion event`);
      return;
    }

    console.log(`[Lifecycle] Notifying ${this.issueCompletionListeners.size} listeners about issue #${event.issue.iid} completion`);

    const promises = Array.from(this.issueCompletionListeners).map(async (listener) => {
      try {
        await listener(event);
      } catch (error) {
        console.error(`[Lifecycle] Error in issue completion listener:`, error);
      }
    });

    await Promise.all(promises);
    console.log(`[Lifecycle] All listeners notified for issue #${event.issue.iid}`);
  }

  private getOrCreateRetryState(issue: GitLabIssue): IssueRetryState {
    let retryState = this.retryStates.get(issue.id);

    if (!retryState) {
      retryState = {
        issueId: issue.id,
        currentAttempt: 0,
        maxAttempts: 3,
        lastAttemptAt: new Date()
      };

      this.retryStates.set(issue.id, retryState);
    }

    return retryState;
  }
}
