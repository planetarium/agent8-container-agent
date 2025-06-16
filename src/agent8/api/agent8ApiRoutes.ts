import { Agent8Client } from '../agent8Client.js';
import { UseChatAdapter } from '../utils/useChatAdapter.js';

export class Agent8ApiRoutes {
  private agent8Client: Agent8Client;

  constructor(agent8Client: Agent8Client) {
    this.agent8Client = agent8Client;
  }

  async handleRequest(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (!this.isAgent8ApiPath(path)) {
      return null;
    }

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: corsHeaders });
    }

    try {
      if (path === "/api/agent8/chat" && method === "GET") {
        return await this.handleChatApi(req, corsHeaders);
      }

      if (path === '/api/agent8/responses' && method === 'GET') {
        return await this.handleCurrentResponseApi(corsHeaders);
      }

      return new Response(JSON.stringify({ error: 'Agent8 API endpoint not found' }), {
        status: 404,
        headers: corsHeaders
      });

    } catch (error) {
      console.error('[Agent8ApiRoutes] API error:', error);
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: corsHeaders
      });
    }
  }

  private isAgent8ApiPath(path: string): boolean {
    return path.startsWith('/api/agent8');
  }

  private async handleChatApi(req: Request, corsHeaders: Record<string, string>): Promise<Response> {
    const rawContent = await this.agent8Client.loadCurrentRawContent();
    if (!rawContent) {
      return new Response(JSON.stringify({ error: 'Task response not found' }), {
        status: 404,
        headers: corsHeaders
      });
    }

    const { annotations, textContent, metadata } = UseChatAdapter.parseDataStream(rawContent);

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        annotations.forEach(annotation => {
          const data = `data: ${JSON.stringify(annotation)}\n\n`;
          controller.enqueue(encoder.encode(data));
        });

        const message = {
          id: metadata.messageId || `msg_${Date.now()}`,
          role: 'assistant',
          content: textContent,
        };

        const messageData = `data: ${JSON.stringify(message)}\n\n`;
        controller.enqueue(encoder.encode(messageData));

        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    });

    return new Response(stream, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  }

  private async handleCurrentResponseApi(corsHeaders: Record<string, string>): Promise<Response> {
    const [metadata, rawContent] = await Promise.all([
      this.agent8Client.loadCurrentMetadata(),
      this.agent8Client.loadCurrentRawContent()
    ]);

    if (!metadata || !rawContent) {
      return new Response(JSON.stringify({ error: 'No task response found in this container' }), {
        status: 404,
        headers: corsHeaders
      });
    }

    const result = {
      metadata,
      rawContent,
      parsedData: UseChatAdapter.parseDataStream(rawContent),
      summary: {
        taskId: metadata.taskId,
        timestamp: metadata.timestamp,
        duration: metadata.response?.duration,
        contentLength: metadata.response?.rawContent?.length,
        artifactsCount: metadata.processing?.artifactsCount,
        actionsCount: metadata.processing?.actionsCount,
        executedActions: metadata.processing?.executedActions,
        failedActions: metadata.processing?.failedActions
      }
    };

    return new Response(JSON.stringify(result), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
}
