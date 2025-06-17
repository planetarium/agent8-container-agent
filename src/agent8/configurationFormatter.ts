import type { McpTransferData } from "../types/mcpMetadata.js";

export class ConfigurationFormatter {
  /**
   * Format MCP server configuration for LLM server transfer
   */
  static formatMcpConfiguration(mcpData: McpTransferData): string {
    const configValue = encodeURIComponent(JSON.stringify(mcpData.servers));
    return `mcpServers=${configValue}`;
  }

  /**
   * Parse MCP configuration string back to configuration object
   */
  static parseMcpConfiguration(configString: string): McpTransferData | null {
    try {
      const match = configString.match(/mcpServers=([^;]+)/);
      if (!match) return null;

      const decoded = decodeURIComponent(match[1]);
      const servers = JSON.parse(decoded);

      return { servers };
    } catch (error) {
      console.error('[MCP] Failed to parse MCP configuration:', error);
      return null;
    }
  }
}
