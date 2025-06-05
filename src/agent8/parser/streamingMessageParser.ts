import { parseDataStreamPart } from "ai";
import type { ActionType, BoltActionData } from "../types/actions";
import type { BoltArtifactData } from "../types/artifact";
import type { ParserCallbacks } from "../types/parser";

// Tag constants
const ARTIFACT_TAG_OPEN = "<boltArtifact";
const ARTIFACT_TAG_CLOSE = "</boltArtifact>";
const ARTIFACT_ACTION_TAG_OPEN = "<boltAction";
const ARTIFACT_ACTION_TAG_CLOSE = "</boltAction>";

interface MessageState {
  position: number;
  insideArtifact: boolean;
  insideAction: boolean;
  currentArtifact?: BoltArtifactData;
  currentAction: BoltActionData;
  actionId: number;
}

export interface StreamingMessageParserOptions {
  callbacks?: ParserCallbacks;
}

/**
 * Agent8 streaming message parser - robust processing with position-based parsing
 */
export class StreamingMessageParser {
  private messages = new Map<string, MessageState>();

  constructor(private options: StreamingMessageParserOptions = {}) {}

  /**
   * Process AI SDK Data Stream Protocol to extract text and parse
   */
  parseDataStream(messageId: string, rawContent: string): string {
    const lines = rawContent.split("\n").filter((line) => line.trim());
    let extractedText = "";

    for (const line of lines) {
      if (line.trim()) {
        try {
          const parsedPart = parseDataStreamPart(line);

          // Extract Text Parts (0:"...")
          if (parsedPart.type === "text") {
            extractedText += parsedPart.value;
          }
        } catch (_err) {}
      }
    }

    // Parse extracted text with Agent8 parser
    if (extractedText.trim()) {
      return this.parse(messageId, extractedText);
    }
    return "";
  }

  parse(messageId: string, input: string): string {
    let state = this.messages.get(messageId);

    if (!state) {
      state = {
        position: 0,
        insideAction: false,
        insideArtifact: false,
        currentAction: { content: "" } as BoltActionData,
        actionId: 0,
      };
      this.messages.set(messageId, state);
    }

    let output = "";
    let i = state.position;
    let earlyBreak = false;

    while (i < input.length) {
      if (state.insideArtifact) {
        const currentArtifact = state.currentArtifact;
        if (!currentArtifact) {
          throw new Error("Artifact not initialized");
        }

        if (state.insideAction) {
          const closeIndex = input.indexOf(ARTIFACT_ACTION_TAG_CLOSE, i);
          const newActionOpenIndex = input.indexOf(ARTIFACT_ACTION_TAG_OPEN, i);
          const artifactCloseIndex = input.indexOf(ARTIFACT_TAG_CLOSE, i);
          const currentAction = state.currentAction;

          if (
            closeIndex !== -1 &&
            (newActionOpenIndex === -1 || closeIndex < newActionOpenIndex) &&
            (artifactCloseIndex === -1 || closeIndex < artifactCloseIndex)
          ) {
            // Complete current action
            currentAction.content = (currentAction.content || "") + input.slice(i, closeIndex);
            const content = this.cleanoutFileContent(
              currentAction.content.trim(),
              currentAction.filePath || "",
            );
            currentAction.content = content;

            this.options.callbacks?.onActionClose?.({
              ...currentAction,
              content,
            } as BoltActionData);

            state.insideAction = false;
            state.currentAction = { content: "" } as BoltActionData;
            i = closeIndex + ARTIFACT_ACTION_TAG_CLOSE.length;
          } else if (
            newActionOpenIndex !== -1 &&
            (closeIndex === -1 || newActionOpenIndex < closeIndex) &&
            (artifactCloseIndex === -1 || newActionOpenIndex < artifactCloseIndex)
          ) {
            // Start new action
            const newActionEndIndex = input.indexOf(">", newActionOpenIndex);
            if (newActionEndIndex !== -1) {
              const previousAction = state.currentAction;
              state.currentAction = this.parseActionTag(
                input,
                newActionOpenIndex,
                newActionEndIndex,
              );

              // Complete previous action
              this.options.callbacks?.onActionClose?.(previousAction);

              // Start new action
              this.options.callbacks?.onActionOpen?.(state.currentAction);
              state.actionId++;

              i = newActionEndIndex + 1;
            } else {
              break;
            }
          } else if (
            artifactCloseIndex !== -1 &&
            (closeIndex === -1 || artifactCloseIndex < closeIndex) &&
            (newActionOpenIndex === -1 || artifactCloseIndex < newActionOpenIndex)
          ) {
            // Complete artifact
            currentAction.content =
              (currentAction.content || "") + input.slice(i, artifactCloseIndex);
            const content = this.cleanoutFileContent(
              currentAction.content.trim(),
              currentAction.filePath || "",
            );
            currentAction.content = content;

            this.options.callbacks?.onActionClose?.({
              ...currentAction,
              content,
            } as BoltActionData);

            this.options.callbacks?.onArtifactClose?.(currentArtifact);

            state.insideAction = false;
            state.currentAction = { content: "" } as BoltActionData;
            state.insideArtifact = false;
            state.currentArtifact = undefined;
            i = artifactCloseIndex + ARTIFACT_TAG_CLOSE.length;
          } else {
            // Stream action content
            const streamContent = input.slice(i);
            if (streamContent && this.options.callbacks?.onActionStream) {
              this.options.callbacks.onActionStream(streamContent);
            }
            currentAction.content += streamContent;
            break;
          }
        } else {
          // Inside artifact, outside action
          const actionOpenIndex = input.indexOf(ARTIFACT_ACTION_TAG_OPEN, i);
          const artifactCloseIndex = input.indexOf(ARTIFACT_TAG_CLOSE, i);

          if (
            actionOpenIndex !== -1 &&
            (artifactCloseIndex === -1 || actionOpenIndex < artifactCloseIndex)
          ) {
            const actionEndIndex = input.indexOf(">", actionOpenIndex);
            if (actionEndIndex !== -1) {
              state.insideAction = true;
              state.currentAction = this.parseActionTag(input, actionOpenIndex, actionEndIndex);

              this.options.callbacks?.onActionOpen?.(state.currentAction);
              state.actionId++;

              i = actionEndIndex + 1;
            } else {
              break;
            }
          } else if (artifactCloseIndex !== -1) {
            this.options.callbacks?.onArtifactClose?.(currentArtifact);
            state.insideArtifact = false;
            state.currentArtifact = undefined;
            i = artifactCloseIndex + ARTIFACT_TAG_CLOSE.length;
          } else {
            break;
          }
        }
      } else if (input[i] === "<" && input[i + 1] !== "/") {
        // Check for potential artifact tag
        let j = i;
        let potentialTag = "";

        while (j < input.length && potentialTag.length < ARTIFACT_TAG_OPEN.length) {
          potentialTag += input[j];

          if (potentialTag === ARTIFACT_TAG_OPEN) {
            const nextChar = input[j + 1];
            if (nextChar && nextChar !== ">" && nextChar !== " ") {
              output += input.slice(i, j + 1);
              i = j + 1;
              break;
            }

            const openTagEnd = input.indexOf(">", j);
            if (openTagEnd !== -1) {
              const artifactTag = input.slice(i, openTagEnd + 1);

              const artifactTitle = this.extractAttribute(artifactTag, "title") || "";
              const type = this.extractAttribute(artifactTag, "type") || "";
              const artifactId = this.extractAttribute(artifactTag, "id") || "";

              state.insideArtifact = true;
              const currentArtifact: BoltArtifactData = {
                id: artifactId,
                title: artifactTitle,
                type: (type as "file" | "folder") || "file",
              };

              state.currentArtifact = currentArtifact;
              this.options.callbacks?.onArtifactOpen?.(currentArtifact);

              i = openTagEnd + 1;
            } else {
              earlyBreak = true;
            }
            break;
          }
          if (!ARTIFACT_TAG_OPEN.startsWith(potentialTag)) {
            output += input.slice(i, j + 1);
            i = j + 1;
            break;
          }
          j++;
        }

        if (j === input.length && ARTIFACT_TAG_OPEN.startsWith(potentialTag)) {
          break;
        }
      } else {
        // Regular text
        output += input[i];
        i++;
      }

      if (earlyBreak) {
        break;
      }
    }

    state.position = i;

    // Call callback if there's regular text
    if (output.trim()) {
      this.options.callbacks?.onTextChunk?.(output);
    }

    return output;
  }

    private parseActionTag(
    input: string,
    actionOpenIndex: number,
    actionEndIndex: number,
  ): BoltActionData {
    const actionTag = input.slice(actionOpenIndex, actionEndIndex + 1);

    // Log the actual tag being parsed
    console.log("[Agent8 Parser] Parsing action tag:", actionTag);

    const actionType = this.extractAttribute(actionTag, "type") as ActionType;

    const actionAttributes: Partial<BoltActionData> = {
      type: actionType,
      content: "",
    };

    if (actionType === "file") {
      const filePath = this.extractAttribute(actionTag, "filePath");
      const operation = this.extractAttribute(actionTag, "operation");

      console.log("[Agent8 Parser] File action - filePath:", filePath, "operation:", operation);

      if (filePath) {
        actionAttributes.filePath = filePath;
      }
      if (operation) {
        actionAttributes.operation = operation as "create" | "update" | "delete";
      } else {
        // Default to "create" if operation is not specified
        console.log("[Agent8 Parser] No operation specified, defaulting to 'create'");
        actionAttributes.operation = "create";
      }
    } else if (actionType === "shell") {
      const command = this.extractAttribute(actionTag, "command");

      console.log("[Agent8 Parser] Shell action - command:", command);

      if (command) {
        actionAttributes.command = command;
      } else {
        // Try to extract command from content in onActionClose
        console.log("[Agent8 Parser] No command attribute found, will extract from content");
      }
    }

    console.log("[Agent8 Parser] Parsed attributes:", actionAttributes);
    return actionAttributes as BoltActionData;
  }

  private extractAttribute(tag: string, attributeName: string): string | undefined {
    const regex = new RegExp(`${attributeName}="([^"]*)"`, "i");
    const match = tag.match(regex);
    const result = match ? match[1] : undefined;
    return result;
  }

  private cleanoutFileContent(content: string, filePath: string): string {
    let processedContent = content.trim();

    // Remove code block syntax for non-markdown files
    if (!filePath.endsWith(".md")) {
      processedContent = this.cleanoutCodeblockSyntax(processedContent);
      processedContent = this.cleanEscapedTags(processedContent);
    }

    processedContent += "\n";
    return processedContent;
  }

  private cleanoutCodeblockSyntax(content: string): string {
    const markdownCodeBlockRegex = /^\s*```\w*\n([\s\S]*?)\n\s*```\s*$/;
    const xmlCodeBlockRegex = /^\s*<!\[CDATA\[\n([\s\S]*?)\n\s*\]\]>\s*$/;

    const match = content.match(markdownCodeBlockRegex) || content.match(xmlCodeBlockRegex);
    return match ? match[1] : content;
  }

  private cleanEscapedTags(content: string): string {
    return content
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/\\n/g, "\n")
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"');
  }

  reset(): void {
    this.messages.clear();
  }

  // Convenience method for single message parsing
  processChunk(chunk: string, messageId = "default"): string {
    return this.parse(messageId, chunk);
  }
}
