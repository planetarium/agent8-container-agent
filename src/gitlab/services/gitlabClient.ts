import { Gitlab } from "@gitbeaker/rest";
import type { GitLabIssue, GitLabProject, GitLabUser } from "../types/index.js";
import type { MergeRequestCreationOptions, GitLabMergeRequest } from "../types/git.js";
import type { GitLabComment } from "../types/index.js";

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
        scope: "all",
        state: "opened",
        orderBy: "created_at",
        sort: "desc",
        createdAfter: lastCheckTime.toISOString(),
        labels: labels?.join(","),
        perPage: 100,
      });

      return issues as unknown as GitLabIssue[];
    } catch (error) {
      console.error("GitLab API error:", error);
      throw error;
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      // Test connection by fetching current user projects
      const _projects = await this.gitlab.Projects.all({ owned: true, perPage: 1 });
      console.log("Connected to GitLab successfully");
      return true;
    } catch (error) {
      console.error("GitLab connection failed:", error);
      return false;
    }
  }

  /**
   * Fetch project details from GitLab API
   */
  async getProject(projectId: number): Promise<GitLabProject> {
    try {
      console.log(`[GitLab] Fetching project details for ID: ${projectId}`);

      const response = await this.gitlab.Projects.show(projectId);

      console.log(`[GitLab] Successfully fetched project: ${response.name}`);
      return response as unknown as GitLabProject;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[GitLab] Failed to fetch project ${projectId}: ${errorMessage}`);
      throw new Error(`Failed to fetch project details: ${errorMessage}`);
    }
  }

  /**
   * Fetch user details by user ID
   */
  async getUserById(userId: number): Promise<GitLabUser> {
    try {
      console.log(`[GitLab] Fetching user details for ID: ${userId}`);

      const response = await this.gitlab.Users.show(userId);

      console.log(`[GitLab] Successfully fetched user: ${response.username}`);
      return response as unknown as GitLabUser;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[GitLab] Failed to fetch user ${userId}: ${errorMessage}`);
      throw new Error(`Failed to fetch user details: ${errorMessage}`);
    }
  }

  /**
   * Fetch group details by group ID
   */
  async getGroup(groupId: number): Promise<{ id: number; name: string; owner_id?: number }> {
    try {
      console.log(`[GitLab] Fetching group details for ID: ${groupId}`);

      const response = await this.gitlab.Groups.show(groupId);

      console.log(`[GitLab] Successfully fetched group: ${response.name}`);
      return response as { id: number; name: string; owner_id?: number };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[GitLab] Failed to fetch group ${groupId}: ${errorMessage}`);
      throw new Error(`Failed to fetch group details: ${errorMessage}`);
    }
  }

  async addIssueComment(projectId: number, issueIid: number, note: string) {
    return await this.gitlab.IssueNotes.create(projectId, issueIid, note);
  }

  async fetchRecentlyUpdatedIssues(lastCheckTime: Date): Promise<GitLabIssue[]> {
    try {
      const issues = await this.gitlab.Issues.all({
        scope: "all",
        state: "opened",
        orderBy: "updated_at",
        sort: "desc",
        updatedAfter: lastCheckTime.toISOString(),
        perPage: 100,
      });

      return issues as unknown as GitLabIssue[];
    } catch (error) {
      console.error("GitLab API error (fetchRecentlyUpdatedIssues):", error);
      throw error;
    }
  }

  async updateIssueLabels(projectId: number, issueIid: number, labels: string[]): Promise<void> {
    try {
      await this.gitlab.Issues.edit(projectId, issueIid, {
        labels: labels.join(","),
      });

      console.log(`[GitLab] Updated labels for issue #${issueIid}: ${labels.join(", ")}`);
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
          "PRIVATE-TOKEN": this.token,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const issue = await response.json();
      return issue as GitLabIssue;
    } catch (error) {
      console.error(
        `[GitLab] Failed to fetch issue #${issueIid} from project ${projectId}:`,
        error,
      );
      throw error;
    }
  }

  async createMergeRequest(options: MergeRequestCreationOptions): Promise<GitLabMergeRequest> {
    try {
      console.log(
        `[GitLab-API] Creating merge request: ${options.sourceBranch} -> ${options.targetBranch}`,
      );

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
        },
      );

      console.log(`[GitLab-API] Merge request created successfully: !${mergeRequest.iid}`);
      return mergeRequest as GitLabMergeRequest;
    } catch (error) {
      console.error(`[GitLab-API] Failed to create merge request:`, error);
      throw error;
    }
  }

  /**
   * Get user email address by user ID (requires admin token for private emails)
   */
  async getUserEmail(userId: number, username: string): Promise<string> {
    try {
      console.log(`[GitLab] Fetching user email for ID: ${userId}`);

      const response = await fetch(`${this.baseUrl}/api/v4/users/${userId}`, {
        headers: {
          "PRIVATE-TOKEN": this.token,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch user details: ${response.status} ${response.statusText}`);
      }

      const user = await response.json() as { email?: string; public_email?: string };
      const userEmail = user.email || user.public_email;

      if (!userEmail) {
        throw new Error(`Could not retrieve email address for user ${username} (ID: ${userId}). Email is required for container authentication. Please ensure the user has a public email or the GitLab token has admin privileges.`);
      }

      console.log(`[GitLab] Successfully fetched user email: ${userEmail}`);
      return userEmail;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[GitLab] Failed to fetch user email ${userId}: ${errorMessage}`);
      throw new Error(`Failed to fetch user email: ${errorMessage}`);
    }
  }

  /**
   * Get group owner email
   */
  async getGroupOwner(groupId: number): Promise<string> {
    try {
      console.log(`[GitLab] Getting group owner for group: ${groupId}`);

      const group = await this.getGroup(groupId);

      if (group.owner_id) {
        const owner = await this.getUserById(group.owner_id);
        const ownerEmail = owner.email || owner.public_email;

        if (ownerEmail) {
          console.log(`[GitLab] Found group owner email: ${ownerEmail}`);
          return ownerEmail;
        }
      }

      console.log("[GitLab] No direct owner found, looking for maintainers");
      throw new Error("No suitable group owner or maintainer found");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[GitLab] Failed to get group owner: ${errorMessage}`);
      throw new Error(`Failed to get group owner: ${errorMessage}`);
    }
  }

  /**
   * Get project owner email for authentication
   */
  async getProjectOwnerEmail(projectId: number): Promise<string> {
    try {
      console.log(`[GitLab] Getting project owner email for project: ${projectId}`);

      const project = await this.getProject(projectId);

      if (project.namespace.kind === "user") {
        const ownerId = project.namespace.owner?.id ?? project.owner?.id;

        if (!ownerId) {
          throw new Error("Project owner ID not found");
        }

        return await this.getUserEmail(ownerId, project.namespace.path);
      }

      if (project.namespace.kind === "group") {
        return await this.getGroupOwner(project.namespace.id);
      }

      throw new Error(`Unsupported namespace kind: ${project.namespace.kind}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[GitLab] Failed to get project owner email: ${errorMessage}`);
      throw new Error(`Failed to get project owner email: ${errorMessage}`);
    }
  }

  async getIssueComments(projectId: number, issueIid: number): Promise<GitLabComment[]> {
    try {
      const url = `${this.baseUrl}/api/v4/projects/${projectId}/issues/${issueIid}/notes`;
      const response = await fetch(url, {
        headers: {
          "PRIVATE-TOKEN": this.token,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const comments = (await response.json()) as GitLabComment[];
      return comments.filter((comment: GitLabComment) => !comment.system);
    } catch (error) {
      console.error(`[GitLab] Failed to fetch comments for issue #${issueIid}:`, error);
      throw error;
    }
  }
}
