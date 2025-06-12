export type ActionType = "file" | "shell";

export interface BoltActionData {
  type: ActionType;
  content?: string;
  filePath?: string;
  operation?: "create" | "update" | "delete";
  command?: string;
}

export interface BoltAction extends BoltActionData {
  type: ActionType;
  content: string;
  filePath?: string;
  operation?: "create" | "update" | "delete";
  command?: string;
}

export interface FileAction extends BoltAction {
  type: "file";
  filePath: string;
  operation: "create" | "update" | "delete";
  content: string;
}

export interface ShellAction extends BoltAction {
  type: "shell";
  command: string;
  content: string;
}

export interface ActionResult {
  success: boolean;
  output?: string;
  error?: string;
}

export interface ActionCallbacks {
  onStart?: (action: BoltAction) => void;
  onProgress?: (action: BoltAction, progress: number) => void;
  onComplete?: (action: BoltAction, result: ActionResult) => void;
  onError?: (action: BoltAction, error: string) => void;
}
