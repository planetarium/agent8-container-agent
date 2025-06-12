export interface GitCheckoutOptions {
  projectId: number;
  issueIid: number;
  targetDirectory: string;
}

export interface GitCheckoutResult {
  success: boolean;
  clonedRepository: string;
  createdBranch: string;
  createdMergeRequest?: GitLabMergeRequest;
  error?: string;
}

export interface GitRepositoryInfo {
  httpUrl: string;
  sshUrl: string;
  defaultBranch: string;
  pathWithNamespace: string;
}

export interface GitBranchInfo {
  name: string;
  baseBranch: string;
  created: boolean;
}

export interface MergeRequestCreationOptions {
  projectId: number;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
  issueIid: number;
}

export interface MergeRequestCreationResult {
  success: boolean;
  mergeRequest?: GitLabMergeRequest;
  error?: string;
}

export interface GitLabMergeRequest {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string;
  state: 'opened' | 'closed' | 'merged';
  draft: boolean;
  source_branch: string;
  target_branch: string;
  web_url: string;
  created_at: string;
}

// Commit and push related type definitions
export interface GitCommitResult {
  success: boolean;
  commitHash?: string;
  message?: string;
  error?: string;
}

export interface GitPushResult {
  success: boolean;
  pushedBranch?: string;
  error?: string;
}

export interface GitCommitPushResult {
  success: boolean;
  commitResult: GitCommitResult;
  pushResult: GitPushResult;
  error?: string;
}
