import { GitLabClient } from './gitlabClient.js';
import { GitLabContainerService } from './gitlabContainerService.js';
import { GitLabIssueRepository } from '../repositories/gitlabIssueRepository.js';
import { ContainerTrigger } from '../triggers/containerTrigger.js';
import { MachinePool } from '../../fly/machinePool.js';
import { GitLabConfig } from '../types/index.js';

export class GitLabPoller {
  private gitlabClient: GitLabClient;
  private containerService: GitLabContainerService;
  private issueRepository: GitLabIssueRepository;
  private containerTrigger: ContainerTrigger;
  private isRunning: boolean = false;
  private checkInterval: number;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(config: GitLabConfig, machinePool: MachinePool) {
    this.gitlabClient = new GitLabClient(config.url, config.token);
    this.issueRepository = new GitLabIssueRepository();
    this.containerService = new GitLabContainerService(
      machinePool,
      this.issueRepository,
      this.gitlabClient,
      process.env.FLY_ROUTER_DOMAIN || 'agent8.verse8.net'
    );
    this.containerTrigger = new ContainerTrigger(this.containerService);
    this.checkInterval = config.pollInterval * 60 * 1000;
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
        await this.checkForNewIssues();
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
