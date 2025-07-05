import type {
  McpServerConfigExtended,
  McpToolMetadata,
  McpTransferData,
} from "../../types/mcpMetadata.js";
import type { GitLabClient } from "./gitlabClient.js";

export class McpConfigurationService {
  private gitlabClient: GitLabClient;
  private readonly METADATA_MARKER = "<!-- MCP_METADATA -->";

  constructor(gitlabClient: GitLabClient) {
    this.gitlabClient = gitlabClient;
  }

  /**
   * Read MCP server configuration from internal notes and format for LLM server
   */
  async formatMcpConfiguration(projectId: number, issueIid: number): Promise<string | null> {
    console.log(
      `[MCP-Debug] Starting formatMcpConfiguration for project ${projectId}, issue #${issueIid}`,
    );

    try {
      const mcpData = await this.retrieveMcpConfiguration(projectId, issueIid);
      if (!mcpData) {
        console.log(`[MCP-Debug] No MCP data retrieved for issue #${issueIid}`);
        return null;
      }

      console.log(
        `[MCP-Debug] Successfully retrieved MCP data for issue #${issueIid}, formatting...`,
      );
      const configValue = encodeURIComponent(JSON.stringify(mcpData.servers));
      const formattedConfig = `mcpServers=${configValue}`;

      console.log(
        `[MCP-Debug] Formatted MCP config for issue #${issueIid}: ${formattedConfig.substring(0, 100)}...`,
      );
      return formattedConfig;
    } catch (error) {
      console.error(`[MCP-Debug] ERROR in formatMcpConfiguration for issue #${issueIid}:`, error);
      return null;
    }
  }

  /**
   * Read raw MCP metadata from internal notes
   */
  async retrieveMcpConfiguration(
    projectId: number,
    issueIid: number,
  ): Promise<McpTransferData | null> {
    console.log(
      `[MCP-Debug] Starting retrieveMcpConfiguration for project ${projectId}, issue #${issueIid}`,
    );

    try {
      console.log(
        `[MCP-Debug] Fetching internal notes for project ${projectId}, issue #${issueIid}...`,
      );
      const internalNotes = await this.gitlabClient.getInternalNotes(projectId, issueIid);

      console.log(
        `[MCP-Debug] Retrieved ${internalNotes.length} internal notes for issue #${issueIid}`,
      );

      if (internalNotes.length === 0) {
        console.log(`[MCP-Debug] No internal notes found for issue #${issueIid}`);
        return null;
      }

      // Log each note for debugging
      internalNotes.forEach((note, index) => {
        console.log(
          `[MCP-Debug] Internal note ${index + 1}/${internalNotes.length} for issue #${issueIid}:`,
        );
        console.log(`[MCP-Debug]   - Note ID: ${note.id}`);
        console.log(`[MCP-Debug]   - Author: ${note.author.username}`);
        console.log(`[MCP-Debug]   - Created: ${note.created_at}`);
        console.log(
          `[MCP-Debug]   - Contains MCP marker: ${note.body.includes(this.METADATA_MARKER)}`,
        );
        console.log(`[MCP-Debug]   - Body preview: ${note.body.substring(0, 200)}...`);
      });

      for (const note of internalNotes) {
        if (note.body.includes(this.METADATA_MARKER)) {
          console.log(
            `[MCP-Debug] Found MCP metadata marker in note ${note.id} for issue #${issueIid}`,
          );
          const result = this.deserializeAndTransformConfiguration(note.body);

          if (result) {
            console.log(
              `[MCP-Debug] Successfully parsed MCP configuration for issue #${issueIid}:`,
              result,
            );
            return result;
          }
          console.log(
            `[MCP-Debug] Failed to parse MCP configuration from note ${note.id} for issue #${issueIid}`,
          );
        }
      }

      console.log(
        `[MCP-Debug] No MCP configuration marker found in any internal notes for issue #${issueIid}`,
      );
      return null;
    } catch (error) {
      console.error(`[MCP-Debug] ERROR in retrieveMcpConfiguration for issue #${issueIid}:`, error);
      return null;
    }
  }

  /**
   * Check if MCP configuration exists for an issue
   */
  async hasMcpConfiguration(projectId: number, issueIid: number): Promise<boolean> {
    console.log(
      `[MCP-Debug] Checking if MCP configuration exists for project ${projectId}, issue #${issueIid}`,
    );
    const config = await this.retrieveMcpConfiguration(projectId, issueIid);
    const hasConfig = config !== null;
    console.log(`[MCP-Debug] MCP configuration exists for issue #${issueIid}: ${hasConfig}`);
    return hasConfig;
  }

  /**
   * Transform external guide spec to transfer format
   */
  private deserializeAndTransformConfiguration(noteBody: string): McpTransferData | null {
    console.log("[MCP-Debug] Starting deserialization of MCP configuration...");
    console.log(`[MCP-Debug] Looking for marker: ${this.METADATA_MARKER}`);

    const regex = new RegExp(`${this.METADATA_MARKER}\\s*([\\s\\S]*?)\\s*${this.METADATA_MARKER}`);
    const match = noteBody.match(regex);

    if (!match) {
      console.log("[MCP-Debug] No regex match found for MCP metadata markers");
      console.log(`[MCP-Debug] Note body length: ${noteBody.length}`);
      console.log(`[MCP-Debug] Note body: ${noteBody}`);
      return null;
    }

    console.log("[MCP-Debug] Found MCP metadata match, extracting JSON...");
    console.log(`[MCP-Debug] Extracted content: ${match[1]}`);

    try {
      const externalMetadata: McpToolMetadata = JSON.parse(match[1]);
      console.log("[MCP-Debug] Successfully parsed external metadata:", externalMetadata);

      const extendedServers: McpServerConfigExtended[] = externalMetadata.servers.map((server) => ({
        name: server.name,
        url: server.url,
        enabled: true,
        v8AuthIntegrated: true,
        description: `MCP server: ${server.name}`,
      }));

      const result = {
        servers: extendedServers,
      };

      console.log("[MCP-Debug] Successfully transformed to transfer format:", result);
      return result;
    } catch (error) {
      console.error("[MCP-Debug] ERROR parsing MCP configuration JSON:", error);
      console.error("[MCP-Debug] Raw content that failed to parse:", match[1]);
      return null;
    }
  }
}
