import type { LifecycleLabel } from '../types/index.js';
import type { GitLabInfo } from '../types/api.js';

export interface CommentSection {
  title: string;
  emoji?: string;
  content: string[];
}

export interface ErrorDetails {
  timestamp: string;
  errorMessage?: string;
  containerId?: string;
  commitHash?: string;
  failedActions?: Array<{ error: string }>;
  successfulActions?: number;
  failedActionsCount?: number;
}

export interface SuccessDetails {
  timestamp: string;
  containerId: string;
  commitHash?: string;
  pushedBranch?: string;
}

export interface ContainerCreationDetails {
  containerId: string;
  containerUrl: string;
  issueIid: number;
  issueTitle: string;
  labels: string[];
  authorName: string;
  authorUsername: string;
}

export class GitLabCommentFormatter {
  /**
   * Create a structured markdown comment with sections
   */
  static createComment(
    title: string,
    emoji: string,
    sections: CommentSection[],
    footer?: string
  ): string {
    const parts = [`## ${emoji} ${title}`];

    sections.forEach((section, index) => {
      if (index > 0 || section.title !== title) {
        parts.push('---');

        if (section.emoji) {
          parts.push(`### ${section.emoji} ${section.title}`);
        } else {
          parts.push(`### ${section.title}`);
        }
      }

      parts.push('');
      parts.push(...section.content);
      parts.push('');
    });

    if (footer) {
      parts.push('---');
      parts.push('');
      parts.push(footer);
    }

    return parts.join('\n');
  }

  /**
   * Generate success comment for completed tasks
   */
  static createSuccessComment(details: SuccessDetails): string {
    const sections: CommentSection[] = [
      {
        title: 'Task Completed Successfully',
        content: [
          `- **Status**: Task completed successfully`,
          `- **Completion Time**: ${details.timestamp}`
        ]
      },
      {
        title: 'Technical Details',
        emoji: '📋',
        content: [
          `- **Container ID**: \`${details.containerId}\``,
          ...(details.commitHash ? [`- **Commit Hash**: \`${details.commitHash}\``] : []),
          ...(details.pushedBranch ? [`- **Branch**: \`${details.pushedBranch}\``] : [])
        ]
      },
      {
        title: 'Next Steps',
        emoji: '🎯',
        content: [
          'Please **review the task results** and change the issue status to **DONE** if everything looks correct.',
          '',
          'If you need any modifications, change the status back to **TODO** with additional instructions.'
        ]
      }
    ];

    return this.createComment(
      'Agent8 Task Completed Successfully',
      '✅',
      sections,
      '*Agent8 automatic task completion notification*'
    );
  }

  /**
   * Generate error comment for action failures
   */
  static createActionFailureComment(details: ErrorDetails): string {
    const totalActions = (details.failedActionsCount || 0) + (details.successfulActions || 0);

    const sections: CommentSection[] = [
      {
        title: 'Agent8 Action Execution Failed',
        content: [
          `- **Error Type**: Action execution failure`,
          `- **Timestamp**: ${details.timestamp}`
        ]
      },
      {
        title: 'Execution Statistics',
        emoji: '📊',
        content: [
          `- **Total Actions**: ${totalActions}`,
          `- **Successful Actions**: ${details.successfulActions || 0}`,
          `- **Failed Actions**: ${details.failedActionsCount || 0}`
        ]
      },
      {
        title: 'Resolution Steps',
        emoji: '🔧',
        content: [
          '1. **Review issue description** - Check if requirements are clear',
          '2. **Verify dependencies** - Ensure all required files exist',
          '3. **Retry task** - Change issue state back to **TODO** to retry'
        ]
      },
      {
        title: 'Technical Details',
        emoji: '📋',
        content: [
          `- **Container ID**: \`${details.containerId || 'unknown'}\``
        ]
      }
    ];

    return this.createComment(
      'Agent8 Action Execution Failed',
      '❌',
      sections,
      '*Agent8 automatic error report*'
    );
  }

  /**
   * Generate error comment for commit failures
   */
  static createCommitFailureComment(details: ErrorDetails): string {
    const sections: CommentSection[] = [
      {
        title: 'Auto-Commit Failed',
        content: [
          `- **Error Type**: Git commit failure`,
          `- **Timestamp**: ${details.timestamp}`
        ]
      },
      {
        title: 'Error Details',
        emoji: '❗',
        content: [
          `- **Error Message**: ${details.errorMessage || 'Unknown error'}`
        ]
      },
      {
        title: 'Resolution Steps',
        emoji: '🔧',
        content: [
          '1. **Check Git configuration** - Verify user.name and user.email settings',
          '2. **Verify permissions** - Ensure working directory has write permissions',
          '3. **Retry task** - Change issue state back to **TODO** to retry'
        ]
      },
      {
        title: 'Technical Details',
        emoji: '📋',
        content: [
          `- **Container ID**: \`${details.containerId || 'unknown'}\``
        ]
      }
    ];

    return this.createComment(
      'Auto-Commit Failed',
      '❌',
      sections,
      '*Agent8 automatic error report*'
    );
  }

  /**
   * Generate error comment for push failures
   */
  static createPushFailureComment(details: ErrorDetails): string {
    const sections: CommentSection[] = [
      {
        title: 'Auto-Push Failed',
        content: [
          `- **Error Type**: Git push failure`,
          `- **Timestamp**: ${details.timestamp}`
        ]
      },
      {
        title: 'Error Details',
        emoji: '❗',
        content: [
          `- **Error Message**: ${details.errorMessage || 'Unknown error'}`,
          `- **Commit Hash**: \`${details.commitHash || 'N/A'}\``
        ]
      },
      {
        title: 'Important Notice',
        emoji: '⚠️',
        content: [
          'Changes were **committed locally** but failed to push to remote repository.'
        ]
      },
      {
        title: 'Resolution Steps',
        emoji: '🔧',
        content: [
          '1. **Verify GitLab token** - Check if token has write_repository permissions',
          '2. **Check network connectivity** - Ensure connection to GitLab server',
          '3. **Retry task** - Change issue state back to **TODO** to retry'
        ]
      },
      {
        title: 'Technical Details',
        emoji: '📋',
        content: [
          `- **Container ID**: \`${details.containerId || 'unknown'}\``
        ]
      }
    ];

    return this.createComment(
      'Auto-Push Failed',
      '❌',
      sections,
      '*Agent8 automatic error report*'
    );
  }

  /**
   * Generate status update comment for lifecycle changes
   */
  static createStatusUpdateComment(
    newLabel: LifecycleLabel,
    reason: string,
    timestamp: string
  ): string {
    const emoji = this.getLabelEmoji(newLabel);
    const nextSteps = this.getNextStepsMessage(newLabel);

    const sections: CommentSection[] = [
      {
        title: `Status Updated: ${newLabel}`,
        content: [
          `- **New Status**: ${newLabel}`,
          `- **Timestamp**: ${timestamp}`
        ]
      },
      {
        title: 'Update Details',
        emoji: '📋',
        content: [
          `- **Reason**: ${reason}`,
          `- **Updated by**: System (GitLab Poller)`
        ]
      },
      {
        title: "What's Next",
        emoji: '🎯',
        content: [nextSteps]
      }
    ];

    return this.createComment(
      `Status Updated: ${newLabel}`,
      emoji,
      sections,
      '*Automated lifecycle management by Agent8 GitLab Integration*'
    );
  }

  /**
   * Get emoji for lifecycle labels
   */
  private static getLabelEmoji(label: LifecycleLabel): string {
    const emojiMap: Record<LifecycleLabel, string> = {
      'TODO': '📋',
      'WIP': '🔄',
      'CONFIRM NEEDED': '⏳',
      'DONE': '✅',
      'REJECT': '❌'
    };

    return emojiMap[label];
  }

  /**
   * Get next steps message for lifecycle labels
   */
  private static getNextStepsMessage(label: LifecycleLabel): string {
    const nextStepsMap: Record<LifecycleLabel, string> = {
      'TODO': 'Issue is ready for processing. Agent8 will automatically detect this status and begin task execution.',
      'WIP': 'Agent8 is currently processing this issue. Please wait for completion or monitor the container logs.',
      'CONFIRM NEEDED': 'Agent8 has completed the task. Please **review the changes** and update status to **DONE** if satisfied, or **TODO** if modifications are needed.',
      'DONE': 'Issue has been completed successfully. No further action required.',
      'REJECT': 'Issue processing failed or was rejected. Review the error details above and update status to **TODO** to retry.'
    };

    return nextStepsMap[label];
  }

  /**
   * Generate container creation notification comment
   */
  static createContainerCreatedComment(details: ContainerCreationDetails): string {
    const sections: CommentSection[] = [
      {
        title: 'Container Created & Task Delegated',
        content: [
          `- **Container ID**: \`${details.containerId}\``,
          `- **Container URL**: [${details.containerUrl}](${details.containerUrl})`,
          `- **Status**: Task delegated, container will report results automatically`
        ]
      },
      {
        title: 'Task Information',
        emoji: '📋',
        content: [
          `- **Issue**: #${details.issueIid} - ${details.issueTitle}`,
          `- **Labels**: ${details.labels.length > 0 ? details.labels.join(', ') : 'None'}`,
          `- **Created by**: ${details.authorName} (@${details.authorUsername})`
        ]
      },
      {
        title: 'Next Steps',
        emoji: '🎯',
        content: [
          '- Container is processing your request autonomously',
          '- Results will be posted as a comment when complete',
          '- Monitor container at the URL above if needed'
        ]
      }
    ];

    return this.createComment(
      'Container Created & Task Delegated',
      '🚀',
      sections,
      '*This container was created automatically by Agent8 GitLab integration.*'
    );
  }
}
