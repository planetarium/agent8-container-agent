import { Agent8Client } from '../agent8Client.js';
import { UseChatAdapter } from '../utils/useChatAdapter.js';
import { AuthManager } from '../../auth/index.js';
import { parseCookies } from '../../cookieParser.js';
import type { TaskRequest, TaskResponse } from '../types/api.js';

export class Agent8ApiRoutes {
  private agent8Client: Agent8Client;
  private authManager: AuthManager;

  constructor(agent8Client: Agent8Client, authManager: AuthManager) {
    this.agent8Client = agent8Client;
    this.authManager = authManager;
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

      if (path === '/api/agent8/task' && method === 'POST') {
        return await this.handleTaskCreateApi(req, corsHeaders);
      }

      if (path.startsWith('/api/agent8/task/') && method === 'GET') {
        const taskId = path.split('/').pop();
        if (taskId) {
          return await this.handleTaskStatusApi(req, taskId, corsHeaders);
        }
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

  private async handleTaskCreateApi(req: Request, corsHeaders: Record<string, string>): Promise<Response> {
    const token = this.authManager.extractTokenFromHeader(req.headers.get("authorization"));
    if (!token) {
      return Response.json({ error: "Missing authorization token" }, { status: 401 });
    }

    const userInfo = await this.authManager.verifyToken(token);
    if (!userInfo) {
      return Response.json({ error: "Invalid authorization token" }, { status: 401 });
    }

    try {
      const body = await req.json() as TaskRequest;

      // Validate required fields
      if (!body.targetServerUrl) {
        return Response.json({ error: "targetServerUrl is required" }, { status: 400 });
      }
      if (!(body.messages && Array.isArray(body.messages)) || body.messages.length === 0) {
        return Response.json(
          { error: "messages array is required and cannot be empty" },
          { status: 400 },
        );
      }

      // Extract cookies from request headers and merge with body apiKeys
      const cookieHeader = req.headers.get("cookie");
      let cookieApiKeys = {};

      if (cookieHeader) {
        try {
          const cookies = parseCookies(cookieHeader);
          cookieApiKeys = JSON.parse(cookies.apiKeys || "{}");
        } catch (error) {
          console.warn("Failed to parse apiKeys from cookies:", error);
        }
      }

      // Merge cookie apiKeys with body apiKeys (body takes precedence)
      const finalApiKeys = { ...cookieApiKeys, ...(body.apiKeys || {}) };

      const taskId = await this.agent8Client.createTask({
        userId: userInfo.userUid,
        token: token,
        targetServerUrl: body.targetServerUrl,
        id: body.id || `req-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
        messages: body.messages,
        apiKeys: finalApiKeys,
        files: body.files || {},
        promptId: body.promptId || "agent8",
        contextOptimization: body.contextOptimization ?? true,
        cookies: cookieHeader || undefined,
        gitlabInfo: body.gitlabInfo,
      });

      return Response.json({
        success: true,
        taskId: taskId,
        message: "Background task created successfully",
      });
    } catch (error) {
      console.error("Background task creation failed:", error);
      return Response.json(
        {
          error:
            error instanceof Error ? error.message : "Failed to create background task",
        },
        { status: 500 },
      );
    }
  }

  private async handleTaskStatusApi(req: Request, taskId: string, corsHeaders: Record<string, string>): Promise<Response> {
    const token = this.authManager.extractTokenFromHeader(req.headers.get("authorization"));
    if (!token) {
      return Response.json({ error: "Missing authorization token" }, { status: 401 });
    }

    const userInfo = await this.authManager.verifyToken(token);
    if (!userInfo) {
      return Response.json({ error: "Invalid authorization token" }, { status: 401 });
    }

    const taskStatus = await this.agent8Client.getTaskStatus(
      taskId,
      userInfo.userUid,
    );

    if (!taskStatus) {
      return Response.json({ error: "Task not found" }, { status: 404 });
    }

    return Response.json({ success: true, task: taskStatus });
  }
}
