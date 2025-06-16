import type {
  ReasoningUIPart,
  SourceUIPart,
  StepStartUIPart,
  TextUIPart,
  ToolInvocationUIPart,
  UIMessage,
} from "@ai-sdk/ui-utils";

/**
 * Convert messages to UI format
 */
export function convertToUIMessages(messages: any[]): UIMessage[] {
  return messages.map((msg) => {
    const role = msg.role || "user";
    const id = msg.id || generateMessageId();

    let content = "";
    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (msg.text) {
      content = msg.text;
    } else if (msg.message) {
      content = msg.message;
    } else if (Array.isArray(msg.content)) {
      content = msg.content
        .filter((part: any) => part.type === "text")
        .map((part: any) => part.text || "")
        .join("");
    }

    const parts: Array<
      TextUIPart | ReasoningUIPart | ToolInvocationUIPart | SourceUIPart | StepStartUIPart
    > = msg.parts || [
      {
        type: "text",
        text: content,
      },
    ];

    const convertedMessage: UIMessage = {
      id,
      role: role as "system" | "user" | "assistant" | "data",
      content,
      parts,
      ...(msg.annotations && { annotations: msg.annotations }),
      ...(msg.createdAt && { createdAt: msg.createdAt }),
      ...(msg.experimental_attachments && {
        experimental_attachments: msg.experimental_attachments,
      }),
    };

    return convertedMessage;
  });
}

/**
 * Generate unique message ID
 */
export function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}
