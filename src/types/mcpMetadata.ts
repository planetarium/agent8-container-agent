/**
 * MCP Tool Metadata Types
 *
 * Compatible with external writing guide specifications while supporting
 * internal extensions for LLM server communication.
 */

export interface McpServerConfig {
  name: string;
  url: string;
}

export interface McpToolMetadata {
  servers: McpServerConfig[];
}

export interface McpServerConfigExtended extends McpServerConfig {
  enabled: boolean;
  v8AuthIntegrated: boolean;
  description: string;
}

export interface McpTransferData {
  servers: McpServerConfigExtended[];
}
