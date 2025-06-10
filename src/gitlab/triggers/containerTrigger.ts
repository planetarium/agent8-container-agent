import { GitLabIssue } from '../types/index.js';
import { GitLabContainerService } from '../services/gitlabContainerService.js';

export class ContainerTrigger {
  private containerService: GitLabContainerService;

  constructor(containerService: GitLabContainerService) {
    this.containerService = containerService;
  }

  async shouldTriggerContainer(issue: GitLabIssue): Promise<boolean> {
    const triggerLabels = process.env.CONTAINER_TRIGGER_LABELS?.split(',') || [];
    const hasValidLabel = issue.labels.some(label => triggerLabels.includes(label));

    const isNotConfidential = !issue.confidential;
    const isOpenState = issue.state === 'opened';

    return hasValidLabel && isNotConfidential && isOpenState;
  }

  async processIssue(issue: GitLabIssue): Promise<string | null> {
    if (!await this.shouldTriggerContainer(issue)) {
      console.log(`Issue #${issue.iid} does not meet trigger conditions`);
      return null;
    }

    console.log(`Processing issue #${issue.iid} for container creation`);
    return await this.containerService.createContainerForIssue(issue);
  }
}
