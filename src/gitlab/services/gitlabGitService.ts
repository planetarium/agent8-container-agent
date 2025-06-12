import type { GitLabClient } from './gitlabClient.js';
import type { GitCheckoutResult, GitRepositoryInfo, GitBranchInfo, MergeRequestCreationResult, GitLabMergeRequest } from '../types/git.js';
import type { GitLabIssue } from '../types/index.js';
import simpleGit, { type SimpleGit } from 'simple-git';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

// Regular expression for masking Git clone URLs in logs
const GIT_URL_MASK_REGEX = /\/\/.*@/;

export class GitLabGitService {
  private gitlabClient: GitLabClient;
  private workdir: string;
  private git: SimpleGit;

  constructor(gitlabClient: GitLabClient, workdir: string) {
    this.gitlabClient = gitlabClient;
    this.workdir = workdir;
    // Initialize git instance only when needed to avoid directory not exist error
    this.git = simpleGit();
  }

  async checkoutRepositoryForIssue(
    projectId: number,
    issueIid: number
  ): Promise<GitCheckoutResult> {
    try {
      console.log(`[GitLab-Git] Starting checkout for project ${projectId}, issue #${issueIid}`);

      // 1. Fetch project and issue information in parallel via GitLab API
      const [project, issue] = await Promise.all([
        this.gitlabClient.getProject(projectId),
        this.gitlabClient.getIssue(projectId, issueIid)
      ]);

      const repoInfo = this.extractRepositoryInfo(project);

      // 2. Clean working directory
      await this.cleanWorkDirectory();

      // 3. Set git working directory and clone repository
      this.git = simpleGit(this.workdir);
      await this.cloneRepository(repoInfo.httpUrl);

      // 4. Create and checkout issue branch from default branch
      const branchName = `issue-${issueIid}`;
      await this.createIssueBranch(branchName, repoInfo.defaultBranch);

      // 5. Configure Git settings
      await this.configureGitSettings();

      // 6. Create Draft MR (new step)
      const mrResult = await this.createDraftMergeRequest({
        projectId,
        sourceBranch: branchName,
        targetBranch: repoInfo.defaultBranch,
        issue,
        issueIid
      });

      console.log(`[GitLab-Git] Git checkout completed successfully`);
      console.log(`[GitLab-Git] Repository: ${repoInfo.pathWithNamespace}, Branch: ${branchName}`);

      if (mrResult.success && mrResult.mergeRequest) {
        console.log(`[GitLab-Git] Draft MR created: !${mrResult.mergeRequest.iid} (${mrResult.mergeRequest.web_url})`);
      } else if (mrResult.error) {
        console.warn(`[GitLab-Git] MR creation failed: ${mrResult.error}`);
      }

      return {
        success: true,
        clonedRepository: repoInfo.pathWithNamespace,
        createdBranch: branchName,
        createdMergeRequest: mrResult.mergeRequest
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[GitLab-Git] Checkout failed: ${errorMessage}`);
      return {
        success: false,
        clonedRepository: '',
        createdBranch: '',
        error: errorMessage
      };
    }
  }

  private extractRepositoryInfo(project: Record<string, unknown>): GitRepositoryInfo {
    return {
      httpUrl: project.http_url_to_repo as string,
      sshUrl: project.ssh_url_to_repo as string,
      defaultBranch: project.default_branch as string,
      pathWithNamespace: project.path_with_namespace as string
    };
  }

  private async cloneRepository(cloneUrl: string): Promise<void> {
    const token = process.env.GITLAB_TOKEN;
    if (!token) {
      throw new Error('GITLAB_TOKEN environment variable is required');
    }

    // Create authenticated clone URL
    const authenticatedUrl = cloneUrl.replace(
      'https://',
      `https://oauth2:${token}@`
    );

    console.log(`[GitLab-Git] Cloning repository from ${cloneUrl.replace(GIT_URL_MASK_REGEX, '//***@')}`);
    await this.git.clone(authenticatedUrl, '.');
  }

  private async createIssueBranch(branchName: string, baseBranch: string): Promise<GitBranchInfo> {
    try {
      console.log(`[GitLab-Git] Creating and checking out branch: ${branchName} from ${baseBranch}`);

      // Create and checkout new branch from base branch
      await this.git.checkoutLocalBranch(branchName);

      return {
        name: branchName,
        baseBranch: baseBranch,
        created: true
      };
        } catch (_error) {
      console.warn(`[GitLab-Git] Failed to create branch ${branchName}, using existing branch or default`);

      // If branch creation fails, try to checkout existing branch
      try {
        await this.git.checkout(branchName);
        return {
          name: branchName,
          baseBranch: baseBranch,
          created: false
        };
      } catch (_checkoutError) {
        // If checkout also fails, stay on default branch
        console.warn(`[GitLab-Git] Using default branch ${baseBranch}`);
        return {
          name: baseBranch,
          baseBranch: baseBranch,
          created: false
        };
      }
    }
  }

  private async configureGitSettings(): Promise<void> {
    try {
      // Set basic git configuration for commits
      await this.git.addConfig('user.name', 'Agent8 Container');
      await this.git.addConfig('user.email', 'agent8@verse8.io');
      console.log('[GitLab-Git] Git configuration set successfully');
    } catch (error) {
      console.warn(`[GitLab-Git] Failed to configure git settings: ${error}`);
    }
  }

  private async cleanWorkDirectory(): Promise<void> {
    try {
      console.log(`[GitLab-Git] Cleaning work directory: ${this.workdir}`);

      // Ensure work directory exists
      await mkdir(this.workdir, { recursive: true });

      // Remove all files and directories except hidden files
      const files = await readdir(this.workdir);
      for (const file of files) {
        if (!file.startsWith('.')) {
          const filePath = join(this.workdir, file);
          try {
            const stats = await stat(filePath);
            if (stats.isDirectory()) {
              await rm(filePath, { recursive: true, force: true });
            } else {
              await rm(filePath, { force: true });
            }
          } catch (fileError) {
            console.warn(`[GitLab-Git] Failed to remove ${filePath}: ${fileError}`);
          }
        }
      }

      console.log('[GitLab-Git] Work directory cleaned successfully');
    } catch (error) {
      console.warn(`[GitLab-Git] Failed to clean work directory: ${error}`);
      throw error;
    }
  }

  // Additional utility methods
  async getCurrentBranch(): Promise<string> {
    try {
      const result = await this.git.branch();
      return result.current;
    } catch (error) {
      console.warn(`[GitLab-Git] Failed to get current branch: ${error}`);
      return 'unknown';
    }
  }

  async getRepositoryStatus(): Promise<unknown> {
    try {
      return await this.git.status();
    } catch (error) {
      console.warn(`[GitLab-Git] Failed to get repository status: ${error}`);
      return null;
    }
  }

  async isRepositoryCloned(): Promise<boolean> {
    try {
      const status = await this.getRepositoryStatus();
      return status !== null;
    } catch (_error) {
      return false;
    }
  }

  private async createDraftMergeRequest(options: {
    projectId: number;
    sourceBranch: string;
    targetBranch: string;
    issue: GitLabIssue;
    issueIid: number;
  }): Promise<MergeRequestCreationResult> {
    try {
      console.log(`[GitLab-Git] Creating draft merge request for issue #${options.issueIid}`);

      const title = this.generateMergeRequestTitle(options.issue, options.issueIid);
      const description = this.generateMergeRequestDescription(options.issue, options.issueIid);

      const mergeRequest = await this.gitlabClient.createMergeRequest({
        projectId: options.projectId,
        sourceBranch: options.sourceBranch,
        targetBranch: options.targetBranch,
        title,
        description,
        issueIid: options.issueIid
      });

      return {
        success: true,
        mergeRequest
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // MR creation failure is not critical - Git checkout has completed successfully
      return {
        success: false,
        error: errorMessage
      };
    }
  }

  private generateMergeRequestTitle(issue: GitLabIssue, issueIid: number): string {
    // Remove existing Draft/WIP prefixes and add new one
    const cleanTitle = issue.title.replace(/^(Draft:|WIP:)\s*/i, '');
    return `Draft: [Issue #${issueIid}] ${cleanTitle}`;
  }

  private generateMergeRequestDescription(issue: GitLabIssue, issueIid: number): string {
    const issueDescription = issue.description || 'No description provided.';

    return `## 🔗 Related Issue

Closes #${issueIid}

## 📝 Work Description

${issueDescription}

## ✅ Checklist

- [ ] Feature implementation completed
- [ ] Test code written
- [ ] Documentation updated
- [ ] Code review completed

## 🤖 Auto-generated Information

- **Branch**: \`issue-${issueIid}\`
- **Created at**: ${new Date().toISOString()}
- **Agent8 Container**: Development in progress in work environment

---
*This Merge Request was automatically generated by Agent8 system.*`;
  }
}

