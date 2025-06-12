/**
 * GitLab API Types
 *
 * This file contains type definitions for GitLab-related API requests and responses.
 */

export interface GitLabInfo {
  projectId: number;
  issueIid: number;
  issueUrl: string;
  issueTitle: string;
  issueAuthor: string;
  containerId: string;
}

export interface GitLabTaskDelegationRequest {
  issue: GitLabInfo;
  containerId: string;
  targetServerUrl?: string;
  authToken?: string;
  promptId?: string;
  contextOptimization?: boolean;
}

export interface GitLabTaskDelegationResponse {
  success: boolean;
  taskId?: string;
  containerId: string;
  message?: string;
  error?: string;
}
