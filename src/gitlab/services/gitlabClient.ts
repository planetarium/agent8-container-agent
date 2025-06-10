import { Gitlab } from '@gitbeaker/rest';
import { GitLabIssue } from '../types/index.js';

export class GitLabClient {
  private gitlab: InstanceType<typeof Gitlab>;

  constructor(url: string, token: string) {
    this.gitlab = new Gitlab({
      host: url,
      token: token,
    });
  }

    async fetchRecentIssues(lastCheckTime: Date, labels?: string[]): Promise<GitLabIssue[]> {
    try {
      const issues = await this.gitlab.Issues.all({
        scope: 'all',
        state: 'opened',
        orderBy: 'created_at',
        sort: 'desc',
        createdAfter: lastCheckTime.toISOString(),
        labels: labels?.join(','),
        perPage: 100,
      });

      return issues as unknown as GitLabIssue[];
    } catch (error) {
      console.error('GitLab API error:', error);
      throw error;
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      // Test connection by fetching current user projects
      const projects = await this.gitlab.Projects.all({ owned: true, perPage: 1 });
      console.log(`Connected to GitLab successfully`);
      return true;
    } catch (error) {
      console.error('GitLab connection failed:', error);
      return false;
    }
  }

  async getProject(projectId: number) {
    return await this.gitlab.Projects.show(projectId);
  }

  async addIssueComment(projectId: number, issueIid: number, note: string) {
    return await this.gitlab.IssueNotes.create(projectId, issueIid, note);
  }
}
