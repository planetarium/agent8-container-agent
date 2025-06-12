export interface GitCheckoutOptions {
  projectId: number;
  issueIid: number;
  targetDirectory: string;
}

export interface GitCheckoutResult {
  success: boolean;
  clonedRepository: string;
  createdBranch: string;
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
