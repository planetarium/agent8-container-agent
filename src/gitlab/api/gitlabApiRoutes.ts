import { PrismaClient } from "@prisma/client";
import { GitLabIssueRepository } from "../repositories/gitlabIssueRepository.js";

const CONTAINER_GITLAB_ISSUE_REGEX = /^\/api\/containers\/[^\/]+\/gitlab-issue$/;

export class GitLabApiRoutes {
  private prisma: PrismaClient;
  private issueRepository: GitLabIssueRepository;

  constructor() {
    this.prisma = new PrismaClient();
    this.issueRepository = new GitLabIssueRepository();
  }

  async handleRequest(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // Only handle GitLab API paths
    if (!this.isGitLabApiPath(path)) {
      return null;
    }

    // CORS headers for all GitLab API responses
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Content-Type": "application/json",
    };

    if (method === "OPTIONS") {
      return new Response(null, { status: 200, headers: corsHeaders });
    }

    try {
      if (path === "/api/gitlab/stats" && method === "GET") {
        return await this.handleStats(corsHeaders);
      }

      if (path === "/api/gitlab/lifecycle/stats" && method === "GET") {
        return await this.handleLifecycleStats(corsHeaders);
      }

      if (path === "/api/gitlab/issues" && method === "GET") {
        return await this.handleIssuesList(req, corsHeaders);
      }

      if (path.startsWith("/api/gitlab/issues/") && method === "GET") {
        const issueId = Number.parseInt(path.split("/")[4]);
        return await this.handleIssueDetail(issueId, corsHeaders);
      }

      if (CONTAINER_GITLAB_ISSUE_REGEX.test(path) && method === "GET") {
        const containerId = path.split("/")[3];
        return await this.handleContainerIssue(containerId, corsHeaders);
      }

      return new Response(JSON.stringify({ error: "GitLab API endpoint not found" }), {
        status: 404,
        headers: corsHeaders,
      });
    } catch (error) {
      console.error("GitLab API error:", error);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  }

  private isGitLabApiPath(path: string): boolean {
    return path.startsWith("/api/gitlab") || CONTAINER_GITLAB_ISSUE_REGEX.test(path);
  }

  private async handleStats(corsHeaders: Record<string, string>): Promise<Response> {
    const stats = await this.prisma.gitlab_issues.groupBy({
      by: ["project_id"],
      _count: { id: true },
      where: { processed_at: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
    });

    const containersCreated = await this.prisma.gitlab_issues.count({
      where: { container_id: { not: null } },
    });

    const totalProcessed = await this.prisma.gitlab_issues.count();

    const result = {
      totalIssuesProcessed: totalProcessed,
      projectBreakdown: stats,
      containersCreated: containersCreated,
      weeklyStats: stats.reduce((acc, stat) => acc + stat._count.id, 0),
    };

    return new Response(JSON.stringify(result), { headers: corsHeaders });
  }

  private async handleLifecycleStats(corsHeaders: Record<string, string>): Promise<Response> {
    try {
      const lifecycleStats = await this.issueRepository.getLifecycleStats();

      const result = {
        ...lifecycleStats,
        lastUpdated: new Date().toISOString(),
        summary: {
          totalIssues: lifecycleStats.total,
          completedIssues: lifecycleStats.byStatus.DONE || 0,
          inProgressIssues: lifecycleStats.byStatus.WIP || 0,
          pendingConfirmation: lifecycleStats.byStatus["CONFIRM NEEDED"] || 0,
          rejectedIssues: lifecycleStats.byStatus.REJECT || 0,
          todoIssues: lifecycleStats.byStatus.TODO || 0,
          unlabledIssues: lifecycleStats.byStatus.NO_LABEL || 0,
          completionRate: `${lifecycleStats.completionRate.toFixed(1)}%`,
        },
      };

      return new Response(JSON.stringify(result), { headers: corsHeaders });
    } catch (error) {
      console.error("[API] Error fetching lifecycle stats:", error);
      return new Response(
        JSON.stringify({
          error: "Failed to fetch lifecycle statistics",
          details: error instanceof Error ? error.message : "Unknown error",
        }),
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }
  }

  private async handleIssuesList(
    req: Request,
    corsHeaders: Record<string, string>,
  ): Promise<Response> {
    const url = new URL(req.url);
    const page = Number.parseInt(url.searchParams.get("page") || "1");
    const limit = Number.parseInt(url.searchParams.get("limit") || "50");
    const skip = (page - 1) * limit;

    const issues = await this.prisma.gitlab_issues.findMany({
      orderBy: { processed_at: "desc" },
      skip: skip,
      take: limit,
    });

    const total = await this.prisma.gitlab_issues.count();

    const result = {
      issues: issues.map((issue) => ({
        ...issue,
        id: issue.id.toString(),
        gitlab_issue_id: issue.gitlab_issue_id.toString(),
        gitlab_iid: issue.gitlab_iid.toString(),
        project_id: issue.project_id.toString(),
        labels: JSON.parse(issue.labels),
      })),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };

    return new Response(JSON.stringify(result), { headers: corsHeaders });
  }

  private async handleIssueDetail(
    issueId: number,
    corsHeaders: Record<string, string>,
  ): Promise<Response> {
    const issue = await this.prisma.gitlab_issues.findUnique({
      where: { gitlab_issue_id: issueId },
    });

    if (!issue) {
      return new Response(JSON.stringify({ error: "Issue not found" }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    let containerInfo = null;
    if (issue.container_id) {
      containerInfo = await this.prisma.machine_pool.findFirst({
        where: { machine_id: issue.container_id },
        select: {
          machine_id: true,
          assigned_to: true,
          created_at: true,
          is_available: true,
          ipv6: true,
        },
      });
    }

    const result = {
      ...issue,
      id: issue.id.toString(),
      gitlab_issue_id: issue.gitlab_issue_id.toString(),
      gitlab_iid: issue.gitlab_iid.toString(),
      project_id: issue.project_id.toString(),
      labels: JSON.parse(issue.labels),
      container: containerInfo,
    };

    return new Response(JSON.stringify(result), { headers: corsHeaders });
  }

  private async handleContainerIssue(
    containerId: string,
    corsHeaders: Record<string, string>,
  ): Promise<Response> {
    const issue = await this.prisma.gitlab_issues.findFirst({
      where: { container_id: containerId },
    });

    if (!issue) {
      return new Response(JSON.stringify({ error: "No GitLab issue found for this container" }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    const result = {
      ...issue,
      id: issue.id.toString(),
      gitlab_issue_id: issue.gitlab_issue_id.toString(),
      gitlab_iid: issue.gitlab_iid.toString(),
      project_id: issue.project_id.toString(),
      labels: JSON.parse(issue.labels),
    };

    return new Response(JSON.stringify(result), { headers: corsHeaders });
  }
}
