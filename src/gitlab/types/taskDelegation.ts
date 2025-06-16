export interface TaskDelegationOptions {
  containerUrl?: string;
  authToken?: string;
  targetServerUrl?: string;
  promptId?: string;
  contextOptimization?: boolean;
  timeout?: number;
}

export interface TaskDelegationResult {
  taskId: string;
  containerId: string;
  status: "pending" | "started" | "completed" | "failed";
  error?: string;
  result?: any;
  startTime: Date;
  endTime?: Date;
}

export interface TaskStatusResult {
  success: boolean;
  task?: AgentTask;
  error?: string;
}

export interface AgentTask {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  progress?: number;
  result?: {
    executedActions: number;
    failedActions: number;
    artifacts: any[];
    textChunks: string;
  };
  error?: string;
  createdAt: Date;
  completedAt?: Date;
}

export interface ApiResponse {
  success: boolean;
  taskId?: string;
  message?: string;
  error?: string;
  data?: any;
}
