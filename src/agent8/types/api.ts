/**
 * Agent8 API Types
 *
 * This file contains type definitions for Agent8-related API requests and responses.
 */

import type { GitLabInfo } from '../../gitlab/types/api.js';

export interface BackgroundTaskRequest {
  targetServerUrl: string;
  messages: any[];
  apiKeys?: Record<string, string>;
  files?: Record<string, any>;
  promptId?: string;
  contextOptimization?: boolean;
  id?: string;
  gitlabInfo?: GitLabInfo;
}

export interface BackgroundTaskResponse {
  success: boolean;
  taskId?: string;
  message?: string;
  error?: string;
}

export interface TaskStatusResponse {
  success: boolean;
  task?: {
    id: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    progress?: number;
    createdAt: Date;
    completedAt?: Date;
    result?: any;
    error?: string;
  };
  error?: string;
}

export interface TaskExecutionResult {
  success: boolean;
  executedActions: number;
  failedActions: number;
  artifacts: any[];
  textChunks: string;
  error?: string;
}
