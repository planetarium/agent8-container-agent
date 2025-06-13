import { GitLabIssue } from '../types/index.js';
import { GitLabContainerService } from '../services/gitlabContainerService.js';
import { GitLabLabelService } from '../services/gitlabLabelService.js';

export class ContainerTrigger {
  private containerService: GitLabContainerService;
  private labelService?: GitLabLabelService;

  constructor(containerService: GitLabContainerService, labelService?: GitLabLabelService) {
    this.containerService = containerService;
    this.labelService = labelService;
  }

  async shouldTriggerContainer(issue: GitLabIssue): Promise<boolean> {
    const triggerLabels = process.env.CONTAINER_TRIGGER_LABELS?.split(',') || [];
    const hasValidLabel = issue.labels.some(label => triggerLabels.includes(label));

    const isNotConfidential = !issue.confidential;
    const isOpenState = issue.state === 'opened';

    // Basic validation
    if (!hasValidLabel || !isNotConfidential || !isOpenState) {
      return false;
    }

    // Lifecycle validation - check if issue has TODO label or no lifecycle label
    if (this.labelService) {
      const currentLabel = this.labelService.getCurrentLifecycleLabel(issue);
      const hasTriggerLabel = this.labelService.hasTriggerLabel(issue);

      // Only process if:
      // Has trigger label AND has TODO label
      if (hasTriggerLabel && currentLabel === 'TODO') {
        console.log(`[Trigger] Issue #${issue.iid} qualifies for container creation (lifecycle: ${currentLabel || 'none'})`);
        return true;
      } else {
        console.log(`[Trigger] Issue #${issue.iid} skipped - lifecycle state: ${currentLabel || 'none'}`);
        return false;
      }
    }

    return true; // Fallback if no label service available
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
