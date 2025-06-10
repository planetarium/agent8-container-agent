export { GitLabPoller } from './services/gitlabPoller.js';
export { GitLabClient } from './services/gitlabClient.js';
export { GitLabContainerService } from './services/gitlabContainerService.js';
export { GitLabIssueRepository } from './repositories/gitlabIssueRepository.js';
export { ContainerTrigger } from './triggers/containerTrigger.js';
export { GitLabApiRoutes } from './api/gitlabApiRoutes.js';

import { GitLabIssueRepository } from './repositories/gitlabIssueRepository.js';
import { GitLabClient } from './services/gitlabClient.js';

export type {
  GitLabIssue,
  GitLabConfig,
  GitLabIssueRecord,
  ContainerCreationOptions,
  NotificationPayload
} from './types/index.js';

// Health check utilities for system integration
export const GitLabSystemHealth = {
  async checkDatabaseConnection(): Promise<boolean> {
    try {
      const repo = new GitLabIssueRepository();
      // Simple query to test database connection
      await repo.getIssueStats();
      return true;
    } catch (error) {
      console.error('Database connection failed:', error);
      return false;
    }
  },

  async checkGitLabConnection(url: string, token: string): Promise<boolean> {
    try {
      const client = new GitLabClient(url, token);
      return await client.testConnection();
    } catch (error) {
      console.error('GitLab connection failed:', error);
      return false;
    }
  },

  getSystemInfo() {
    return {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      pid: process.pid,
      cwd: process.cwd(),
      environment: {
        hasGitLabUrl: !!process.env.GITLAB_URL,
        hasGitLabToken: !!process.env.GITLAB_TOKEN,
        hasDatabaseUrl: !!process.env.DATABASE_URL,
        hasFlyApiToken: !!process.env.FLY_API_TOKEN,
        processGroup: process.env.FLY_PROCESS_GROUP || 'app'
      }
    };
  }
};
