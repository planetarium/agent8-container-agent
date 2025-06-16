import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";
import type { GitLabInfo } from "../types/api.js";
import type {
  GitBranchInfo,
  GitCheckoutResult,
  GitCommitPushResult,
  GitCommitResult,
  GitPushResult,
  GitRepositoryInfo,
  MergeRequestCreationResult,
} from "../types/git.js";
import type { GitLabIssue } from "../types/index.js";
import type { GitLabClient } from "./gitlabClient.js";

// Regular expression for masking Git clone URLs in logs
const _GIT_URL_MASK_REGEX = /\/\/.*@/;

export class GitLabGitService {
  private gitlabClient: GitLabClient;
  private workdir: string;
  private git: SimpleGit;
  private branch: string;

  constructor(gitlabClient: GitLabClient, workdir: string, branch: string) {
    this.gitlabClient = gitlabClient;
    this.workdir = workdir;
    this.branch = branch;
    // Initialize git instance only when needed to avoid directory not exist error
    this.git = simpleGit();
  }

  async checkoutRepositoryForIssue(
    projectId: number,
    issueIid: number,
  ): Promise<GitCheckoutResult> {
    try {
      // 1. Fetch project and issue information in parallel via GitLab API
      const [project, issue] = await Promise.all([
        this.gitlabClient.getProject(projectId),
        this.gitlabClient.getIssue(projectId, issueIid),
      ]);

      const repoInfo = this.extractRepositoryInfo(project);

      // 2. Clean working directory
      await this.cleanWorkDirectory();

      // 3. Set git working directory and clone repository
      this.git = simpleGit(this.workdir);
      await this.cloneRepository(repoInfo.httpUrl);

      // 4. Determine which branch to use as base
      const baseBranch = await this.determineBaseBranch(repoInfo.defaultBranch);

      // 5. Create and checkout issue branch from determined base branch
      const timestamp = Date.now();
      const branchName = `issue-${issueIid}-${timestamp}`;
      await this.createIssueBranch(branchName, baseBranch);

      // 6. Configure Git settings
      await this.configureGitSettings();

      // 7. Create Draft MR (with determined base branch as target)
      const mrResult = await this.createDraftMergeRequest({
        projectId,
        sourceBranch: branchName,
        targetBranch: baseBranch,
        issue,
        issueIid,
      });

      if (!(mrResult.success && mrResult.mergeRequest)) {
        console.warn(`[GitLab-Git] MR creation failed: ${mrResult.error}`);
        return {
          success: false,
          clonedRepository: "",
          createdBranch: "",
          error: mrResult.error,
        };
      }

      return {
        success: true,
        clonedRepository: repoInfo.pathWithNamespace,
        createdBranch: branchName,
        createdMergeRequest: mrResult.mergeRequest,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[GitLab-Git] Checkout failed: ${errorMessage}`);
      return {
        success: false,
        clonedRepository: "",
        createdBranch: "",
        error: errorMessage,
      };
    }
  }

  private extractRepositoryInfo(project: Record<string, unknown>): GitRepositoryInfo {
    return {
      httpUrl: project.http_url_to_repo as string,
      sshUrl: project.ssh_url_to_repo as string,
      defaultBranch: project.default_branch as string,
      pathWithNamespace: project.path_with_namespace as string,
    };
  }

  private async cloneRepository(cloneUrl: string): Promise<void> {
    const token = process.env.GITLAB_TOKEN;
    if (!token) {
      throw new Error("GITLAB_TOKEN environment variable is required");
    }

    // Create authenticated clone URL
    const authenticatedUrl = cloneUrl.replace("https://", `https://oauth2:${token}@`);
    await this.git.clone(authenticatedUrl, ".");
  }

  private async createIssueBranch(branchName: string, baseBranch: string): Promise<GitBranchInfo> {
    try {
      // Create and checkout new branch from base branch
      await this.git.checkoutLocalBranch(branchName);

      return {
        name: branchName,
        baseBranch: baseBranch,
        created: true,
      };
    } catch (_error) {
      console.warn(
        `[GitLab-Git] Failed to create branch ${branchName}, using existing branch or default`,
      );

      // If branch creation fails, try to checkout existing branch
      try {
        await this.git.checkout(branchName);
        return {
          name: branchName,
          baseBranch: baseBranch,
          created: false,
        };
      } catch (_checkoutError) {
        // If checkout also fails, stay on default branch
        console.warn(`[GitLab-Git] Using default branch ${baseBranch}`);
        return {
          name: baseBranch,
          baseBranch: baseBranch,
          created: false,
        };
      }
    }
  }

  private async configureGitSettings(): Promise<void> {
    try {
      // Set basic git configuration for commits
      await this.git.addConfig("user.name", "Agent8 Container");
      await this.git.addConfig("user.email", "agent8@verse8.io");
    } catch (error) {
      console.warn(`[GitLab-Git] Failed to configure git settings: ${error}`);
    }
  }

  private async cleanWorkDirectory(): Promise<void> {
    try {
      // Ensure work directory exists
      await mkdir(this.workdir, { recursive: true });

      // Remove all files and directories except hidden files
      const files = await readdir(this.workdir);
      for (const file of files) {
        if (!file.startsWith(".")) {
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
      return "unknown";
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
      const title = this.generateMergeRequestTitle(options.issue, options.issueIid);
      const description = this.generateMergeRequestDescription(
        options.issue,
        options.issueIid,
        options.sourceBranch,
      );

      const mergeRequest = await this.gitlabClient.createMergeRequest({
        projectId: options.projectId,
        sourceBranch: options.sourceBranch,
        targetBranch: options.targetBranch,
        title,
        description,
        issueIid: options.issueIid,
      });

      return {
        success: true,
        mergeRequest,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // MR creation failure is not critical - Git checkout has completed successfully
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  private generateMergeRequestTitle(issue: GitLabIssue, issueIid: number): string {
    // Remove existing Draft/WIP prefixes and add new one
    const cleanTitle = issue.title.replace(/^(Draft:|WIP:)\s*/i, "");
    return `Draft: [Issue #${issueIid}] ${cleanTitle}`;
  }

  private generateMergeRequestDescription(
    issue: GitLabIssue,
    issueIid: number,
    branchName: string,
  ): string {
    const issueDescription = issue.description || "No description provided.";

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

- **Branch**: \`${branchName}\`
- **Created at**: ${new Date().toISOString()}
- **Agent8 Container**: Development in progress in work environment

---
*This Merge Request was automatically generated by Agent8 system.*`;
  }

  /**
   * Ensure .gitignore file exists with TypeScript/pnpm template if not present
   */
  private async ensureGitignore(): Promise<void> {
    const gitignorePath = join(this.workdir, ".gitignore");

    try {
      await stat(gitignorePath);
      return;
    } catch {
      console.warn("[GitLab-Git] .gitignore file not found, creating template");
    }

    const gitignoreTemplate = `# Dependencies
node_modules/
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*

# TypeScript
*.tsbuildinfo
dist/
build/
out/

# Environment variables
.env
.env.local
.env.development.local
.env.test.local
.env.production.local

# IDE
.vscode/
.idea/
*.swp
*.swo

# OS generated files
.DS_Store
.DS_Store?
._*
.Spotlight-V100
.Trashes
ehthumbs.db
Thumbs.db

# Logs
logs
*.log

# Coverage directory used by tools like istanbul
coverage/
*.lcov

# Temporary folders
tmp/
temp/
`;

    try {
      await writeFile(gitignorePath, gitignoreTemplate);
    } catch (error) {
      console.warn(`[GitLab-Git] Failed to create .gitignore template: ${error}`);
    }
  }

  /**
   * Commit changes to repository
   */
  async commitChanges(commitMessage: string): Promise<GitCommitResult> {
    try {
      await this.ensureGitignore();
      const status = await this.git.status();

      if (status.files.length === 0) {
        return {
          success: true,
          message: "No changes to commit",
        };
      }

      await this.git.add(".");

      const commitResult = await this.git.commit(commitMessage);
      const commitHash = commitResult.commit;

      return {
        success: true,
        commitHash: commitHash,
        message: "Commit successful",
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[GitLab-Git] Commit failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Push current branch to remote repository
   */
  async pushToRemote(): Promise<GitPushResult> {
    try {
      const currentBranch = await this.getCurrentBranch();

      await this.git.push("origin", currentBranch);

      return {
        success: true,
        pushedBranch: currentBranch,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[GitLab-Git] Push failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Execute commit and push operations sequentially
   */
  async commitAndPush(commitMessage: string): Promise<GitCommitPushResult> {
    const commitResult = await this.commitChanges(commitMessage);

    if (!commitResult.success) {
      return {
        success: false,
        commitResult,
        pushResult: { success: false, error: "Commit failed, skipping push" },
        error: "Commit failed",
      };
    }

    if (commitResult.message === "No changes to commit") {
      return {
        success: true,
        commitResult,
        pushResult: { success: true, pushedBranch: "none" },
      };
    }

    const pushResult = await this.pushToRemote();

    const overallSuccess = commitResult.success && pushResult.success;

    return {
      success: overallSuccess,
      commitResult,
      pushResult,
      ...(overallSuccess ? {} : { error: "Commit or push failed" }),
    };
  }

  /**
   * Generate commit message based on GitLab issue information
   */
  private generateCommitMessage(gitlabInfo: GitLabInfo): string {
    const title = gitlabInfo.issueTitle;
    const description = gitlabInfo.issueDescription;

    if (!description || description.trim() === "") {
      return title;
    }

    return `${title}\n\n${description}`;
  }

  /**
   * Determine which branch to use as base branch for new issue branch
   * Priority: 1) specified branch (if exists) 2) defaultBranch
   */
  private async determineBaseBranch(defaultBranch: string): Promise<string> {
    try {
      // Check if specified branch exists in remote
      const branches = await this.git.branch(["-r"]);
      const remoteBranches = branches.all.map((branch) => branch.replace("origin/", ""));

      if (remoteBranches.includes(this.branch)) {
        // Checkout to specified branch
        await this.git.checkout(this.branch);
        return this.branch;
      }
      return defaultBranch;
    } catch (error) {
      console.warn(
        `[GitLab-Git] Failed to determine base branch, using default: ${defaultBranch}`,
        error,
      );
      return defaultBranch;
    }
  }
}
