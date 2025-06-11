export interface GitLabIssue {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string | null;
  state: 'opened' | 'closed';
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  closed_by: {
    id: number;
    username: string;
    name: string;
    state: string;
    avatar_url: string;
    web_url: string;
  } | null;
  author: {
    id: number;
    username: string;
    name: string;
    state: string;
    avatar_url: string;
    web_url: string;
  };
  assignees: Array<{
    id: number;
    username: string;
    name: string;
    state: string;
    avatar_url: string;
    web_url: string;
  }>;
  assignee: {
    id: number;
    username: string;
    name: string;
    state: string;
    avatar_url: string;
    web_url: string;
  } | null;
  labels: string[];
  milestone: {
    id: number;
    title: string;
    description: string;
    state: string;
    created_at: string;
    updated_at: string;
    group_id: number;
    project_id: number;
    web_url: string;
  } | null;
  web_url: string;
  references: {
    short: string;
    relative: string;
    full: string;
  };
  time_stats: {
    time_estimate: number;
    total_time_spent: number;
    human_time_estimate: string | null;
    human_total_time_spent: string | null;
  };
  confidential: boolean;
  discussion_locked: boolean;
  issue_type: string;
  severity: string;
  task_completion_status: {
    count: number;
    completed_count: number;
  };
}

export interface GitLabConfig {
  url: string;
  token: string;
  pollInterval: number; // minutes
}

export interface GitLabIssueRecord {
  id: bigint;
  gitlab_issue_id: number;
  gitlab_iid: number;
  project_id: number;
  title: string;
  description: string | null;
  labels: string; // JSON string
  author_username: string;
  web_url: string;
  created_at: Date;
  processed_at: Date;
  container_id: string | null;
}

export interface ContainerCreationOptions {
  userId: string;
  gitlabIssue: GitLabIssue;
  customEnv?: Record<string, string>;
}

export interface NotificationPayload {
  text: string;
  attachments?: Array<{
    color: string;
    fields: Array<{
      title: string;
      value: string;
      short: boolean;
    }>;
  }>;
}

// Task Delegation Types
export * from './taskDelegation.js';
