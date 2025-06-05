import type { BoltActionData } from "./actions";
import type { BoltArtifactData } from "./artifact";

export interface ParserCallbacks {
  onArtifactOpen?: (artifact: Partial<BoltArtifactData>) => void;
  onArtifactClose?: (artifact: BoltArtifactData) => void;
  onActionOpen?: (action: Partial<BoltActionData>) => void;
  onActionStream?: (chunk: string) => void;
  onActionClose?: (action: BoltActionData) => void;
  onTextChunk?: (text: string) => void;
}

export interface ParserOptions {
  callbacks?: ParserCallbacks;
  enableStreaming?: boolean;
  bufferSize?: number;
}

export type ParsingState =
  | "idle"
  | "artifact_tag"
  | "artifact_content"
  | "action_tag"
  | "action_content";

export interface StreamingMessageParserOptions {
  enableDebug?: boolean;
  bufferSize?: number;
}

export interface ParserState {
  isInArtifact: boolean;
  isInAction: boolean;
  currentArtifact?: BoltArtifactData;
  currentAction?: BoltActionData;
  buffer: string;
  position: number;
}

export interface TagMatch {
  tag: string;
  startIndex: number;
  endIndex: number;
  attributes: Record<string, string>;
  content?: string;
}
