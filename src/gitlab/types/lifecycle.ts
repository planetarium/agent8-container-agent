import type { GitLabIssue } from "./index.js";

export type LifecycleLabel = "TODO" | "WIP" | "CONFIRM NEEDED" | "DONE" | "REJECT";

export const LIFECYCLE_LABELS: readonly LifecycleLabel[] = [
  "TODO",
  "WIP",
  "CONFIRM NEEDED",
  "DONE",
  "REJECT",
] as const;

export const LIFECYCLE_TRANSITIONS: Record<LifecycleLabel, LifecycleLabel[]> = {
  TODO: ["WIP", "REJECT"],
  WIP: ["CONFIRM NEEDED", "REJECT"],
  "CONFIRM NEEDED": ["DONE", "WIP", "REJECT"],
  DONE: [],
  REJECT: ["TODO"],
} as const;

export interface LifecycleConfig {
  triggerLabels: string[];
  retryPolicy: {
    maxRetries: number;
    retryInterval: number;
  };
  labelCheckInterval: number;
  enabled: boolean;
}

export interface LabelChangeEvent {
  issue: GitLabIssue;
  previousLabels: string[];
  currentLabels: string[];
  changedAt: Date;
  changeType: "added" | "removed" | "modified";
}

export interface LifecycleTransition {
  from: LifecycleLabel | null;
  to: LifecycleLabel;
  reason: string;
  triggeredBy: "system" | "user" | "error";
  timestamp: Date;
}

export interface IssueRetryState {
  issueId: number;
  currentAttempt: number;
  maxAttempts: number;
  lastAttemptAt: Date;
  lastError?: string;
  nextRetryAt?: Date;
}

export interface LifecycleStats {
  total: number;
  byStatus: Record<LifecycleLabel, number>;
  transitionsToday: number;
  failureRate: number;
  averageCompletionTime: number;
}
