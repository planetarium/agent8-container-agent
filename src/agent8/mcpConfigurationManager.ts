import type { McpConfigurationService } from "../gitlab/services/mcpConfigurationService.js";
import type { McpTransferData } from "../types/mcpMetadata.js";

export class McpConfigurationManager {
  private configService: McpConfigurationService;

  constructor(configService: McpConfigurationService) {
    this.configService = configService;
  }

  /**
   * Prepare MCP configuration for LLM server communication
   */
  async prepareMcpConfigurationForIssue(
    projectId: number,
    issueIid: number,
  ): Promise<string | null> {
    console.log(
      `[MCP-Manager] Preparing MCP configuration for project ${projectId}, issue #${issueIid}`,
    );

    try {
      const configString = await this.configService.formatMcpConfiguration(projectId, issueIid);

      if (!configString) {
        console.log(`[MCP-Manager] No MCP configuration generated for issue #${issueIid}`);
        return null;
      }

      console.log(
        `[MCP-Manager] ✅ Successfully prepared MCP configuration for issue #${issueIid}`,
      );
      console.log(`[MCP-Manager] Configuration string length: ${configString.length}`);
      return configString;
    } catch (error) {
      console.error(
        `[MCP-Manager] Error preparing MCP configuration for issue #${issueIid}:`,
        error,
      );
      return null;
    }
  }

  /**
   * Get MCP server configuration for current container
   */
  async getMcpConfiguration(projectId: number, issueIid: number): Promise<McpTransferData | null> {
    console.log(
      `[MCP-Manager] Getting raw MCP configuration for project ${projectId}, issue #${issueIid}`,
    );

    try {
      const result = await this.configService.retrieveMcpConfiguration(projectId, issueIid);

      if (result) {
        console.log(
          `[MCP-Manager] ✅ Retrieved MCP configuration with ${result.servers.length} servers`,
        );
      } else {
        console.log("[MCP-Manager] ❌ No MCP configuration found");
      }

      return result;
    } catch (error) {
      console.error(`[MCP-Manager] Error getting MCP configuration for issue #${issueIid}:`, error);
      return null;
    }
  }
}
