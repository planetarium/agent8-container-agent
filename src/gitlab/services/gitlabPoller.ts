import type { MachinePool } from "../../fly/machinePool.js";
import { GitLabIssueRepository } from "../repositories/gitlabIssueRepository.js";
import { ContainerTrigger } from "../triggers/containerTrigger.js";
import type { GitLabConfig, GitLabIssueRecord } from "../types/index.js";
import { IssueLifecycleWorkflow } from "../workflows/issueLifecycleWorkflow.js";
import { GitLabClient } from "./gitlabClient.js";
import { GitLabContainerService } from "./gitlabContainerService.js";
import { GitLabLabelService } from "./gitlabLabelService.js";

export class GitLabPoller {
  private gitlabClient: GitLabClient;
  private containerService: GitLabContainerService;
  private issueRepository: GitLabIssueRepository;
  private containerTrigger: ContainerTrigger;
  private labelService: GitLabLabelService;
  private lifecycleWorkflow: IssueLifecycleWorkflow;
  private isRunning = false;
  private checkInterval: number;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(config: GitLabConfig, machinePool: MachinePool) {
    this.gitlabClient = new GitLabClient(config.url, config.token);
    this.issueRepository = new GitLabIssueRepository();
    this.containerService = new GitLabContainerService(
      machinePool,
      this.issueRepository,
      this.gitlabClient,
      process.env.FLY_ROUTER_DOMAIN || "agent8.verse8.net",
    );
    this.checkInterval = config.pollInterval * 60 * 1000;

    // Initialize lifecycle management services
    this.labelService = new GitLabLabelService(this.gitlabClient, this.issueRepository);
    this.lifecycleWorkflow = new IssueLifecycleWorkflow(this.labelService, this.issueRepository);

    // Initialize container trigger with label service for lifecycle validation
    this.containerTrigger = new ContainerTrigger(this.containerService, this.labelService);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn("GitLab poller already running");
      return;
    }

    const connected = await this.gitlabClient.testConnection();
    if (!connected) {
      throw new Error("Failed to connect to GitLab");
    }

    this.isRunning = true;

    await this.checkForNewIssues();

    this.intervalId = setInterval(async () => {
      if (this.isRunning) {
        await Promise.all([this.checkForNewIssues(), this.checkForLabelChanges()]);
      }
    }, this.checkInterval);

    process.on("SIGINT", () => this.stop());
    process.on("SIGTERM", () => this.stop());
  }

  private async checkForNewIssues(): Promise<void> {
    try {
      console.info("[GitLab Poller] Starting new issue check and processing...");

      // Fetch and store new issues from GitLab
      const lastCheckTime =
        (await this.issueRepository.getLastCheckTime()) || new Date(Date.now() - 60 * 60 * 1000);

      const triggerLabels = process.env.CONTAINER_TRIGGER_LABELS?.split(",");
      const recentIssues = await this.gitlabClient.fetchRecentIssues(lastCheckTime, triggerLabels);

      if (recentIssues.length > 0) {
        console.info(`[GitLab Poller] Found ${recentIssues.length} recent issues, storing to DB`);

        for (const issue of recentIssues) {
          if (this.labelService.getCurrentLifecycleLabel(issue) === "TODO") {
            await this.issueRepository.markIssueProcessed(issue);
          }
        }
      }

      // Select and process issues from DB
      const processableIssues = await this.selectProcessableIssuesWithLock();

      if (processableIssues.length === 0) {
        console.info("[GitLab Poller] No TODO issues to process");
        return;
      }

      console.info(`[GitLab Poller] Selected ${processableIssues.length} issues for processing`);

      await this.processSelectedIssues(processableIssues);
    } catch (error) {
      console.error("[GitLab Poller] Error during issue check:", error);
    }
  }

  private async checkForLabelChanges(): Promise<void> {
    try {
      const lastCheckTime =
        (await this.issueRepository.getLastCheckTime()) || new Date(Date.now() - 60 * 60 * 1000);

      const labelChanges = await this.labelService.detectLabelChanges(lastCheckTime);

      if (labelChanges.length > 0) {
        for (const labelChange of labelChanges) {
          try {
            await this.lifecycleWorkflow.onLabelChange(labelChange);
          } catch (error) {
            console.error(
              `[Lifecycle] Error processing label change for issue #${labelChange.issue.iid}:`,
              error,
            );
          }
        }
      }

      await this.processRetryableIssues();
    } catch (error) {
      console.error("[Lifecycle] Error during label change check:", error);
    }
  }

  private async processRetryableIssues(): Promise<void> {
    try {
      const retryableIssues = this.lifecycleWorkflow.getIssuesReadyForRetry();

      if (retryableIssues.length > 0) {
        for (const retryState of retryableIssues) {
          try {
            const issueRecord = await this.issueRepository.findByGitLabIssueId(retryState.issueId);
            if (!issueRecord) {
              continue;
            }

            const issue = await this.gitlabClient.getIssue(
              issueRecord.project_id,
              issueRecord.gitlab_iid,
            );

            const _containerId = await this.containerTrigger.processIssue(issue);
          } catch (error) {
            console.error(`[Lifecycle] Retry failed for issue ${retryState.issueId}:`, error);

            const issueRecord = await this.issueRepository.findByGitLabIssueId(retryState.issueId);
            if (issueRecord) {
              const issue = await this.gitlabClient.getIssue(
                issueRecord.project_id,
                issueRecord.gitlab_iid,
              );
              await this.lifecycleWorkflow.onContainerCreationFailure(issue, error as Error);
            }
          }
        }
      }
    } catch (error) {
      console.error("[Lifecycle] Error processing retryable issues:", error);
    }
  }

  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  getStatus(): { isRunning: boolean; interval: number } {
    return {
      isRunning: this.isRunning,
      interval: this.checkInterval,
    };
  }

  private async selectProcessableIssuesWithLock(): Promise<GitLabIssueRecord[]> {
    console.info("[GitLab Poller] Starting issue selection process with database lock...");
    const selectedIssues = await this.issueRepository.selectProcessableIssuesWithLock();
    console.info(
      `[GitLab Poller] Issue selection complete: ${selectedIssues.length} issues selected for processing`,
    );
    return selectedIssues;
  }

  private async processSelectedIssues(issues: GitLabIssueRecord[]): Promise<void> {
    let processedCount = 0;
    let containersCreated = 0;
    let skippedCount = 0;

    for (const storedIssue of issues) {
      try {
        console.info(
          `[GitLab Poller] Processing project ${storedIssue.project_id} issue #${storedIssue.gitlab_iid} (created: ${storedIssue.created_at.toISOString()})`,
        );

        console.info(
          `[Processing Validation] Validating project ${storedIssue.project_id} issue #${storedIssue.gitlab_iid} before container creation...`,
        );

        const currentBlockingCount = await this.issueRepository.getProjectBlockingCount(
          storedIssue.project_id,
        );

        if (currentBlockingCount > 0) {
          console.info(
            `[Processing Validation] ❌ Project ${storedIssue.project_id} now has ${currentBlockingCount} blocking issues, reverting selection for issue #${storedIssue.gitlab_iid}`,
          );
          await this.issueRepository.revertProcessingMark(Number(storedIssue.id));
          skippedCount++;
          continue;
        }

        console.info(
          `[Processing Validation] ✅ Project ${storedIssue.project_id} is clear for processing issue #${storedIssue.gitlab_iid}`,
        );

        const currentIssue = await this.gitlabClient.getIssue(
          storedIssue.project_id,
          storedIssue.gitlab_iid,
        );

        console.info(
          `[Label Validation] Checking current labels for issue #${currentIssue.iid}...`,
        );

        const currentLabel = this.labelService.getCurrentLifecycleLabel(currentIssue);
        if (currentLabel !== "TODO") {
          console.info(
            `[Label Validation] ❌ Issue #${currentIssue.iid} no longer TODO (current: ${currentLabel}), reverting selection`,
          );
          await this.issueRepository.revertProcessingMark(Number(storedIssue.id));
          skippedCount++;
          continue;
        }

        if (!this.labelService.hasTriggerLabel(currentIssue)) {
          console.info(
            `[Label Validation] ❌ Issue #${currentIssue.iid} no longer has trigger label, reverting selection`,
          );
          await this.issueRepository.revertProcessingMark(Number(storedIssue.id));
          skippedCount++;
          continue;
        }

        console.info(
          `[Label Validation] ✅ Issue #${currentIssue.iid} has valid labels (lifecycle: ${currentLabel}, has trigger label: true)`,
        );

        console.info(
          `[GitLab Poller] Attempting container creation for issue #${currentIssue.iid}...`,
        );
        const containerId = await this.containerTrigger.processIssue(currentIssue);

        if (containerId) {
          containersCreated++;
          console.info(
            `[GitLab Poller] Container ${containerId} created for project ${currentIssue.project_id} issue #${currentIssue.iid}`,
          );
        } else {
          await this.issueRepository.markIssueProcessed(currentIssue);
          console.info(
            `[GitLab Poller] Project ${currentIssue.project_id} issue #${currentIssue.iid} processed without container creation`,
          );
        }

        processedCount++;
      } catch (error) {
        console.error(
          `[GitLab Poller] Error processing issue ${storedIssue.gitlab_issue_id}:`,
          error,
        );
        await this.issueRepository.revertProcessingMark(Number(storedIssue.id));
      }
    }

    const stats = await this.issueRepository.getIssueStats();
    const projectStats = await this.issueRepository.getProjectIssueStats();

    console.info("[GitLab Poller] Project-based processing completed:");
    console.info(`  - Issues selected: ${issues.length}`);
    console.info(`  - Issues processed: ${processedCount}`);
    console.info(`  - Containers created: ${containersCreated}`);
    console.info(`  - Issues skipped: ${skippedCount}`);
    console.info(`  - Total issues in DB: ${stats.total}`);

    if (projectStats.size > 0) {
      console.info("[GitLab Poller] Project breakdown:");
      for (const [projectId, counts] of projectStats.entries()) {
        console.info(
          `  - Project ${projectId}: TODO=${counts.todo}, WIP=${counts.wip}, CONFIRM_NEEDED=${counts.confirmNeeded}, Others=${counts.others}`,
        );
      }
    }
  }
}
