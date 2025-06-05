export interface BoltArtifactData {
  id: string;
  title: string;
  type: "folder" | "file";
  content?: string;
  template?: string;
  dependencies?: string[];
}

export interface ArtifactCallbacks {
  onOpen?: (artifact: BoltArtifactData) => void;
  onClose?: (artifact: BoltArtifactData) => void;
  onUpdate?: (artifact: BoltArtifactData) => void;
}
