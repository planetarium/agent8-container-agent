import { GitLabClient } from './gitlabClient.js';
import { GitLabContainerService } from './gitlabContainerService.js';
import { GitLabIssueRepository } from '../repositories/gitlabIssueRepository.js';
import { ContainerTrigger } from '../triggers/containerTrigger.js';
import { MachinePool } from '../../fly/machinePool.js';
import { GitLabConfig } from '../types/index.js';
import { GitLabLabelService } from './gitlabLabelService.js';
import { IssueLifecycleWorkflow } from '../workflows/issueLifecycleWorkflow.js';

export class GitLabPoller {
  private gitlabClient: GitLabClient;
  private containerService: GitLabContainerService;
  private issueRepository: GitLabIssueRepository;
  private containerTrigger: ContainerTrigger;
  private labelService: GitLabLabelService;
  private lifecycleWorkflow: IssueLifecycleWorkflow;
  private isRunning: boolean = false;
  private checkInterval: number;
  private intervalId: NodeJS.Timeout | null = null;
  private labelCheckInterval: number;

  constructor(config: GitLabConfig, machinePool: MachinePool) {
    this.gitlabClient = new GitLabClient(config.url, config.token);
    this.issueRepository = new GitLabIssueRepository();
    this.containerService = new GitLabContainerService(
      machinePool,
      this.issueRepository,
      this.gitlabClient,
      process.env.FLY_ROUTER_DOMAIN || 'agent8.verse8.net'
    );
        this.checkInterval = config.pollInterval * 60 * 1000;

    // Initialize lifecycle management services
    this.labelService = new GitLabLabelService(this.gitlabClient, this.issueRepository);
    this.lifecycleWorkflow = new IssueLifecycleWorkflow(this.labelService, this.issueRepository);
    this.labelCheckInterval = config.pollInterval * 60 * 1000; // Same as issue check for now

    // Initialize container trigger with label service for lifecycle validation
    this.containerTrigger = new ContainerTrigger(this.containerService, this.labelService);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn('GitLab poller already running');
      return;
    }

    console.log('Starting GitLab poller...');

    const connected = await this.gitlabClient.testConnection();
    if (!connected) {
      throw new Error('Failed to connect to GitLab');
    }

    this.isRunning = true;
    console.log(`GitLab poller started with ${this.checkInterval / 1000 / 60} minute intervals`);

    await this.checkForNewIssues();

    this.intervalId = setInterval(async () => {
      if (this.isRunning) {
        await Promise.all([
          this.checkForNewIssues(),
          this.checkForLabelChanges()
        ]);
      }
    }, this.checkInterval);

    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
  }

  private async checkForNewIssues(): Promise<void> {
    try {
      console.log('Checking for recent issues...');

      const lastCheckTime = await this.issueRepository.getLastCheckTime() ||
                           new Date(Date.now() - 60 * 60 * 1000);

      const triggerLabels = process.env.CONTAINER_TRIGGER_LABELS?.split(',');

      console.log(`Fetching issues since ${lastCheckTime.toISOString()}`);

      const recentIssues = await this.gitlabClient.fetchRecentIssues(lastCheckTime, triggerLabels);

      const processedIds = await this.issueRepository.getProcessedIssueIds();
      const unprocessedIssues = recentIssues.filter(issue => !processedIds.has(issue.id));

      console.log(`Found ${unprocessedIssues.length} unprocessed issues`);

      let processedCount = 0;
      let containersCreated = 0;

      for (const issue of unprocessedIssues) {
        try {
          console.log(`Processing issue #${issue.iid} - ${issue.title}`);

          const containerId = await this.containerTrigger.processIssue(issue);

          if (containerId) {
            containersCreated++;
            console.log(`Container ${containerId} created for issue #${issue.iid}`);
          } else {
            await this.issueRepository.markIssueProcessed(issue);
            console.log(`Issue #${issue.iid} processed without container creation`);
          }

          processedCount++;

        } catch (error) {
          console.error(`Error processing issue ${issue.id}:`, error);
        }
      }

      const stats = await this.issueRepository.getIssueStats();
      console.log(`Check completed:`);
      console.log(`  - Issues processed: ${processedCount}`);
      console.log(`  - Containers created: ${containersCreated}`);
      console.log(`  - Total issues in DB: ${stats.total}`);
      console.log(`  - Issues processed this week: ${stats.lastWeek}`);

    } catch (error) {
      console.error('Error during issue check:', error);
    }
  }

  private async checkForLabelChanges(): Promise<void> {
    try {
      console.log('[Lifecycle] Checking for label changes...');

      const lastCheckTime = await this.issueRepository.getLastCheckTime() ||
                           new Date(Date.now() - 60 * 60 * 1000);

      const labelChanges = await this.labelService.detectLabelChanges(lastCheckTime);

      if (labelChanges.length > 0) {
        console.log(`[Lifecycle] Found ${labelChanges.length} label changes`);

        for (const labelChange of labelChanges) {
          try {
            await this.lifecycleWorkflow.onLabelChange(labelChange);
          } catch (error) {
            console.error(`[Lifecycle] Error processing label change for issue #${labelChange.issue.iid}:`, error);
          }
        }
      }

      await this.processRetryableIssues();

    } catch (error) {
      console.error('[Lifecycle] Error during label change check:', error);
    }
  }

  private async processRetryableIssues(): Promise<void> {
    try {
      const retryableIssues = this.lifecycleWorkflow.getIssuesReadyForRetry();

      if (retryableIssues.length > 0) {
        console.log(`[Lifecycle] Processing ${retryableIssues.length} retryable issues`);

        for (const retryState of retryableIssues) {
          try {
            const issueRecord = await this.issueRepository.findByGitLabIssueId(retryState.issueId);
            if (!issueRecord) continue;

            const issue = await this.gitlabClient.getIssue(issueRecord.project_id, issueRecord.gitlab_iid);

            console.log(`[Lifecycle] Retrying issue #${issue.iid} (attempt ${retryState.currentAttempt + 1}/${retryState.maxAttempts})`);

            const containerId = await this.containerTrigger.processIssue(issue);

            if (containerId) {
              console.log(`[Lifecycle] Retry successful for issue #${issue.iid}, container: ${containerId}`);
            }

          } catch (error) {
            console.error(`[Lifecycle] Retry failed for issue ${retryState.issueId}:`, error);

            const issueRecord = await this.issueRepository.findByGitLabIssueId(retryState.issueId);
            if (issueRecord) {
              const issue = await this.gitlabClient.getIssue(issueRecord.project_id, issueRecord.gitlab_iid);
              await this.lifecycleWorkflow.onContainerCreationFailure(issue, error as Error);
            }
          }
        }
      }

    } catch (error) {
      console.error('[Lifecycle] Error processing retryable issues:', error);
    }
  }

  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    console.log('GitLab poller stopped');
  }

  getStatus(): { isRunning: boolean; interval: number } {
    return {
      isRunning: this.isRunning,
      interval: this.checkInterval
    };
  }
}
