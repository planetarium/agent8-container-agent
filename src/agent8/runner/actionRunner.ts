import { spawn } from "node:child_process";
import { rm, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ContainerServer } from "../../server";
import { ensureSafePath } from "../../server";
import type {
  ActionCallbacks,
  ActionResult,
  BoltAction,
  FileAction,
  ShellAction,
} from "../types/actions.ts";

export class ActionRunner {
  private readonly containerServer: ContainerServer;
  private readonly callbacks: ActionCallbacks;
  private readonly workdir: string;

  constructor(containerServer: ContainerServer, workdir: string, callbacks: ActionCallbacks = {}) {
    this.containerServer = containerServer;
    this.workdir = workdir;
    this.callbacks = callbacks;
  }

  /**
   * Execute a parsed action
   */
  async executeAction(action: BoltAction): Promise<ActionResult> {
    try {
      this.callbacks.onStart?.(action);

      let result: ActionResult;

      switch (action.type) {
        case "file": {
          // Validate file action has required fields
          if (!action.filePath) {
            throw new Error("File path is required for file actions");
          }
          if (!action.operation) {
            throw new Error("Operation is required for file actions");
          }

          const fileAction: FileAction = {
            type: "file",
            filePath: action.filePath,
            operation: action.operation as "create" | "update" | "delete",
            content: action.content || "",
          };

          result = await this.executeFileAction(fileAction);
          break;
        }
        case "shell": {
          // Validate shell action has required fields
          if (!action.command) {
            throw new Error("Command is required for shell actions");
          }

          const shellAction: ShellAction = {
            type: "shell",
            command: action.command,
            content: action.content || "",
          };

          result = await this.executeShellAction(shellAction);
          break;
        }
        default:
          throw new Error(`Unsupported action type: ${action.type}`);
      }

      this.callbacks.onComplete?.(action, result);
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";

      const errorResult: ActionResult = {
        success: false,
        error: errorMessage,
      };

      this.callbacks.onError?.(action, errorMessage);
      return errorResult;
    }
  }

  /**
   * Execute file operations (create, update, delete)
   */
  private async executeFileAction(action: FileAction): Promise<ActionResult> {
    const { filePath, operation, content } = action;

    if (!filePath) {
      throw new Error("File path is required for file actions");
    }

    try {
      const _safePath = ensureSafePath(this.workdir, filePath);

      switch (operation) {
        case "create":
        case "update": {
          // Direct file system operation using ensureSafePath for security
          const safePath = ensureSafePath(this.workdir, filePath);

          // Ensure parent directory exists
          const parentDir = dirname(safePath);
          await mkdir(parentDir, { recursive: true });

          await writeFile(safePath, content, { encoding: "utf-8" });

          return {
            success: true,
            output: `File ${operation === "create" ? "created" : "updated"}: ${filePath}`,
          };
        }

        case "delete": {
          // Direct file system operation using ensureSafePath for security
          const safePath = ensureSafePath(this.workdir, filePath);
          await rm(safePath, { recursive: false });

          return {
            success: true,
            output: `File deleted: ${filePath}`,
          };
        }

        default:
          throw new Error(`Unsupported file operation: ${operation}`);
      }
    } catch (error) {
      throw new Error(
        `File operation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Execute shell commands with simplified non-interactive approach
   */
  private async executeShellAction(action: ShellAction): Promise<ActionResult> {
    const { command, content } = action;

    if (!command) {
      throw new Error("Command is required for shell actions");
    }

    try {
      // For ActionRunner, we need a simplified execution approach
      // that doesn't require WebSocket connection
      return await this.executeSimpleCommand(command);
    } catch (error) {
      throw new Error(
        `Shell command failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Execute a simple shell command without PTY wrapper
   * This is a simplified version for ActionRunner use
   */
  private async executeSimpleCommand(command: string): Promise<ActionResult> {
    return new Promise((resolve) => {
      // Parse command and arguments
      const args = command.split(" ");
      const cmd = args.shift() || "";

      const childProcess = spawn(cmd, args, {
        cwd: this.workdir,
        stdio: ["pipe", "pipe", "pipe"],
        shell: true,
      });

      let stdout = "";
      let stderr = "";

      childProcess.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      childProcess.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      childProcess.on("close", (code) => {
        if (code === 0) {
          resolve({
            success: true,
            output: stdout.trim() || "Command executed successfully",
          });
        } else {
          resolve({
            success: false,
            error: stderr.trim() || `Command failed with exit code ${code}`,
            output: stdout.trim(),
          });
        }
      });

      childProcess.on("error", (error) => {
        resolve({
          success: false,
          error: `Failed to execute command: ${error.message}`,
        });
      });

      // Set timeout for command execution (30 seconds)
      setTimeout(() => {
        if (!childProcess.killed) {
          childProcess.kill();
          resolve({
            success: false,
            error: "Command execution timed out",
            output: stdout.trim(),
          });
        }
      }, 30000);
    });
  }
}
