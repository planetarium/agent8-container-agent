import { PrismaClient } from "@prisma/client";
import { GitLabClient } from "../services/gitlabClient.js";
import type { GitLabIssue, GitLabIssueRecord } from "../types/index.js";

export class GitLabIssueRepository {
  private prisma: PrismaClient;
  private gitlabClient: GitLabClient;

  constructor(gitlabClient?: GitLabClient) {
    this.prisma = new PrismaClient();
    this.gitlabClient =
      gitlabClient ||
      new GitLabClient(process.env.GITLAB_URL || "", process.env.GITLAB_TOKEN || "");
  }

  async getProcessedIssueIds(): Promise<Set<number>> {
    const issues = await this.prisma.gitlab_issues.findMany({
      select: { gitlab_issue_id: true, labels: true },
    });

    // Exclude TODO issues to allow reprocessing
    const processedIssues = issues.filter((issue) => {
      const labels = JSON.parse(issue.labels) as string[];
      const lifecycleLabel = labels.find((label) =>
        ["TODO", "WIP", "CONFIRM NEEDED", "DONE", "REJECT"].includes(label),
      );

      return lifecycleLabel !== "TODO";
    });

    return new Set(processedIssues.map((issue) => issue.gitlab_issue_id));
  }

  async markIssueProcessed(issue: GitLabIssue, containerId?: string): Promise<void> {
    await this.prisma.gitlab_issues.upsert({
      where: { gitlab_issue_id: issue.id },
      update: {
        container_id: containerId,
        processed_at: new Date(),
      },
      create: {
        gitlab_issue_id: issue.id,
        gitlab_iid: issue.iid,
        project_id: issue.project_id,
        title: issue.title,
        description: issue.description || "",
        labels: JSON.stringify(issue.labels),
        author_username: issue.author.username,
        web_url: issue.web_url,
        created_at: new Date(issue.created_at),
        container_id: containerId,
      },
    });
  }

  async getLastCheckTime(): Promise<Date | null> {
    const lastIssue = await this.prisma.gitlab_issues.findFirst({
      orderBy: { processed_at: "desc" },
      select: { processed_at: true },
    });

    return lastIssue?.processed_at || null;
  }

  async getIssueStats(): Promise<{ total: number; lastWeek: number }> {
    const total = await this.prisma.gitlab_issues.count();

    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    const lastWeek = await this.prisma.gitlab_issues.count({
      where: { processed_at: { gte: weekAgo } },
    });

    return { total, lastWeek };
  }

  async findIssueByContainerId(containerId: string): Promise<GitLabIssueRecord | null> {
    const issue = await this.prisma.gitlab_issues.findFirst({
      where: { container_id: containerId },
    });

    if (!issue) {
      return null;
    }

    return {
      id: issue.id,
      gitlab_issue_id: issue.gitlab_issue_id,
      gitlab_iid: issue.gitlab_iid,
      project_id: issue.project_id,
      title: issue.title,
      description: issue.description,
      labels: issue.labels,
      author_username: issue.author_username,
      web_url: issue.web_url,
      created_at: issue.created_at,
      processed_at: issue.processed_at,
      container_id: issue.container_id,
    };
  }

  async findByGitLabIssueId(gitlabIssueId: number): Promise<GitLabIssueRecord | null> {
    const issue = await this.prisma.gitlab_issues.findUnique({
      where: { gitlab_issue_id: gitlabIssueId },
    });

    if (!issue) {
      return null;
    }

    return {
      id: issue.id,
      gitlab_issue_id: issue.gitlab_issue_id,
      gitlab_iid: issue.gitlab_iid,
      project_id: issue.project_id,
      title: issue.title,
      description: issue.description,
      labels: issue.labels,
      author_username: issue.author_username,
      web_url: issue.web_url,
      created_at: issue.created_at,
      processed_at: issue.processed_at,
      container_id: issue.container_id,
    };
  }

  async updateIssueLabels(gitlabIssueId: number, labels: string[]): Promise<void> {
    await this.prisma.gitlab_issues.update({
      where: { gitlab_issue_id: gitlabIssueId },
      data: {
        labels: JSON.stringify(labels),
        processed_at: new Date(),
      },
    });
  }

  async getLifecycleStats(): Promise<{
    total: number;
    byStatus: Record<string, number>;
    completionRate: number;
  }> {
    const issues = await this.prisma.gitlab_issues.findMany({
      select: { labels: true },
    });

    const lifecycleLabels = ["TODO", "WIP", "CONFIRM NEEDED", "DONE", "REJECT"];
    const statusCounts: Record<string, number> = {};

    for (const label of lifecycleLabels) {
      statusCounts[label] = 0;
    }

    statusCounts.NO_LABEL = 0;

    let completedCount = 0;

    for (const issue of issues) {
      const labels = JSON.parse(issue.labels) as string[];
      const lifecycleLabel = labels.find((label) => lifecycleLabels.includes(label));

      if (lifecycleLabel) {
        statusCounts[lifecycleLabel]++;
        if (lifecycleLabel === "DONE") {
          completedCount++;
        }
      } else {
        statusCounts.NO_LABEL++;
      }
    }

    const total = issues.length;
    const completionRate = total > 0 ? (completedCount / total) * 100 : 0;

    return {
      total,
      byStatus: statusCounts,
      completionRate,
    };
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }

  /**
   * Reset processed_at to created_at and clear container_id for reprocessing
   */
  async resetProcessedTime(gitlabIssueId: number): Promise<void> {
    try {
      const issue = await this.prisma.gitlab_issues.findUnique({
        where: { gitlab_issue_id: gitlabIssueId },
        select: { created_at: true, container_id: true },
      });

      if (issue) {
        await this.prisma.gitlab_issues.update({
          where: { gitlab_issue_id: gitlabIssueId },
          data: {
            processed_at: issue.created_at,
            container_id: null, // Clear previous container ID
          },
        });
      } else {
        console.warn(`[Repository] Issue ${gitlabIssueId} not found for processed_at reset`);
      }
    } catch (error) {
      console.error(`[Repository] Failed to reset processed_at for issue ${gitlabIssueId}:`, error);
      throw error;
    }
  }

  async getProjectBlockingCount(projectId: number): Promise<number> {
    const allProjectIssues = await this.prisma.gitlab_issues.findMany({
      select: { labels: true },
      where: {
        project_id: projectId,
        OR: [
          { labels: { contains: '"WIP"' } },
          { labels: { contains: '"CONFIRM NEEDED"' } }
        ]
      },
    });

    let blockingCount = 0;
    for (const issue of allProjectIssues) {
      const labels = JSON.parse(issue.labels) as string[];
      if (labels.includes("WIP") || labels.includes("CONFIRM NEEDED")) {
        blockingCount++;
      }
    }

    return blockingCount;
  }

  async revertProcessingMark(issueId: number): Promise<void> {
    const issue = await this.prisma.gitlab_issues.findUnique({
      where: { id: issueId },
      select: { created_at: true },
    });

    if (issue) {
      await this.prisma.gitlab_issues.update({
        where: { id: issueId },
        data: { processed_at: issue.created_at },
      });
    }
  }

  async getProjectIssueStats(): Promise<
    Map<number, { todo: number; wip: number; confirmNeeded: number; others: number }>
  > {
    const allIssues = await this.prisma.gitlab_issues.findMany({
      select: { project_id: true, labels: true },
    });

    const projectStats = new Map<number, { todo: number; wip: number; confirmNeeded: number; others: number }>();

    for (const issue of allIssues) {
      const labels = JSON.parse(issue.labels) as string[];
      const projectId = issue.project_id;

      if (!projectStats.has(projectId)) {
        projectStats.set(projectId, { todo: 0, wip: 0, confirmNeeded: 0, others: 0 });
      }

      const stats = projectStats.get(projectId);
      if (!stats) {
        continue;
      }

      if (labels.includes("TODO")) {
        stats.todo++;
      } else if (labels.includes("WIP")) {
        stats.wip++;
      } else if (labels.includes("CONFIRM NEEDED")) {
        stats.confirmNeeded++;
      } else {
        stats.others++;
      }
    }

    return projectStats;
  }

    async selectProcessableIssuesWithLock(): Promise<GitLabIssueRecord[]> {
    return await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '10s'`;

        // Step 1: Lock ALL relevant issues first (TODO + WIP + CONFIRM NEEDED)
        const allRelevantIssues = await tx.$queryRaw<
          Array<{
            id: bigint;
            gitlab_issue_id: number;
            gitlab_iid: number;
            project_id: number;
            title: string;
            description: string | null;
            labels: string;
            author_username: string;
            web_url: string;
            created_at: Date;
            processed_at: Date;
            container_id: string | null;
          }>
        >`
        SELECT
          id, gitlab_issue_id, gitlab_iid, project_id, title, description,
          labels, author_username, web_url, created_at, processed_at, container_id
        FROM gitlab_issues
        WHERE labels::jsonb ? 'TODO' OR labels::jsonb ? 'WIP' OR labels::jsonb ? 'CONFIRM NEEDED'
        ORDER BY project_id ASC, created_at ASC
        FOR UPDATE NOWAIT
      `;

        // Step 2: Analyze in memory to find processable issues
        const projectStats = new Map<number, { blockingCount: number; todoIssues: typeof allRelevantIssues }>();

        // Group issues by project and count blocking issues (WIP + CONFIRM NEEDED)
        for (const issue of allRelevantIssues) {
          const labels = JSON.parse(issue.labels) as string[];
          const projectId = issue.project_id;

          if (!projectStats.has(projectId)) {
            projectStats.set(projectId, { blockingCount: 0, todoIssues: [] });
          }

          const stats = projectStats.get(projectId)!;

          if (labels.includes("WIP") || labels.includes("CONFIRM NEEDED")) {
            stats.blockingCount++;
          } else if (labels.includes("TODO")) {
            stats.todoIssues.push(issue);
          }
        }

        // Step 3: Select oldest TODO from projects with no blocking issues
        const processableIssues: typeof allRelevantIssues = [];

        for (const [, stats] of projectStats.entries()) {
          if (stats.blockingCount === 0 && stats.todoIssues.length > 0) {
            // Sort by created_at and take the oldest
            stats.todoIssues.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
            processableIssues.push(stats.todoIssues[0]);
          }
        }

        // Step 4: Update selected issues
        if (processableIssues.length > 0) {
          const issueIds = processableIssues.map((issue) => issue.id);
          await tx.$executeRaw`
          UPDATE gitlab_issues
          SET processed_at = NOW()
          WHERE id = ANY(${issueIds})
        `;
        }

        return processableIssues.map((issue) => ({
          id: issue.id,
          gitlab_issue_id: issue.gitlab_issue_id,
          gitlab_iid: issue.gitlab_iid,
          project_id: issue.project_id,
          title: issue.title,
          description: issue.description,
          labels: issue.labels,
          author_username: issue.author_username,
          web_url: issue.web_url,
          created_at: issue.created_at,
          processed_at: issue.processed_at,
          container_id: issue.container_id,
        }));
      },
      {
        timeout: 15000,
        isolationLevel: "ReadCommitted",
      },
    );
  }
}
