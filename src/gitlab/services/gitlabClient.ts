import { Gitlab } from '@gitbeaker/rest';
import { GitLabIssue } from '../types/index.js';
import type { MergeRequestCreationOptions, GitLabMergeRequest } from '../types/git.js';
import type { GitLabComment } from '../types/index.js';

export class GitLabClient {
  private gitlab: InstanceType<typeof Gitlab>;
  private baseUrl: string;
  private token: string;

  constructor(url: string, token: string) {
    this.baseUrl = url;
    this.token = token;
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

  async fetchRecentlyUpdatedIssues(lastCheckTime: Date): Promise<GitLabIssue[]> {
    try {
      const issues = await this.gitlab.Issues.all({
        scope: 'all',
        state: 'opened',
        orderBy: 'updated_at',
        sort: 'desc',
        updatedAfter: lastCheckTime.toISOString(),
        perPage: 100,
      });

      return issues as unknown as GitLabIssue[];
    } catch (error) {
      console.error('GitLab API error (fetchRecentlyUpdatedIssues):', error);
      throw error;
    }
  }

  async updateIssueLabels(projectId: number, issueIid: number, labels: string[]): Promise<void> {
    try {
      await this.gitlab.Issues.edit(projectId, issueIid, {
        labels: labels.join(',')
      });

      console.log(`[GitLab] Updated labels for issue #${issueIid}: ${labels.join(', ')}`);
    } catch (error) {
      console.error(`[GitLab] Failed to update labels for issue #${issueIid}:`, error);
      throw error;
    }
  }

    async getIssue(projectId: number, issueIid: number): Promise<GitLabIssue> {
    try {
      // Use GitLab REST API directly since GitBeaker API has inconsistencies
      const url = `${this.baseUrl}/api/v4/projects/${projectId}/issues/${issueIid}`;
      const response = await fetch(url, {
        headers: {
          'PRIVATE-TOKEN': this.token
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const issue = await response.json();
      return issue as GitLabIssue;
    } catch (error) {
      console.error(`[GitLab] Failed to fetch issue #${issueIid} from project ${projectId}:`, error);
      throw error;
    }
  }

  async createMergeRequest(options: MergeRequestCreationOptions): Promise<GitLabMergeRequest> {
    try {
      console.log(`[GitLab-API] Creating merge request: ${options.sourceBranch} -> ${options.targetBranch}`);

      const mergeRequest = await this.gitlab.MergeRequests.create(
        options.projectId,
        options.sourceBranch,
        options.targetBranch,
        options.title,
        {
          description: options.description,
          removeSourceBranch: true,
          squash: false,
          allowCollaboration: true,
        }
      );

      console.log(`[GitLab-API] Merge request created successfully: !${mergeRequest.iid}`);
      return mergeRequest as GitLabMergeRequest;
    } catch (error) {
      console.error(`[GitLab-API] Failed to create merge request:`, error);
      throw error;
    }
  }

  async getIssueComments(projectId: number, issueIid: number): Promise<GitLabComment[]> {
    try {
      const url = `${this.baseUrl}/api/v4/projects/${projectId}/issues/${issueIid}/notes`;
      const response = await fetch(url, {
        headers: {
          'PRIVATE-TOKEN': this.token
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const comments = await response.json() as GitLabComment[];
      return comments.filter((comment: GitLabComment) => !comment.system);
    } catch (error) {
      console.error(`[GitLab] Failed to fetch comments for issue #${issueIid}:`, error);
      throw error;
    }
  }
}
