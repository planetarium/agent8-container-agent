import { PrismaClient } from '@prisma/client';
import { GitLabIssue, GitLabIssueRecord } from '../types/index.js';
import { GitLabClient } from '../services/gitlabClient.js';

export class GitLabIssueRepository {
  private prisma: PrismaClient;
  private gitlabClient: GitLabClient;

  constructor(gitlabClient?: GitLabClient) {
    this.prisma = new PrismaClient();
    this.gitlabClient = gitlabClient || new GitLabClient(
      process.env.GITLAB_URL || '',
      process.env.GITLAB_TOKEN || ''
    );
  }

  async getProcessedIssueIds(): Promise<Set<number>> {
    const issues = await this.prisma.gitlab_issues.findMany({
      select: { gitlab_issue_id: true }
    });

    return new Set(issues.map(issue => issue.gitlab_issue_id));
  }

  async markIssueProcessed(issue: GitLabIssue, containerId?: string): Promise<void> {
    await this.prisma.gitlab_issues.upsert({
      where: { gitlab_issue_id: issue.id },
      update: {
        container_id: containerId,
        processed_at: new Date()
      },
      create: {
        gitlab_issue_id: issue.id,
        gitlab_iid: issue.iid,
        project_id: issue.project_id,
        title: issue.title,
        description: issue.description || '',
        labels: JSON.stringify(issue.labels),
        author_username: issue.author.username,
        web_url: issue.web_url,
        created_at: new Date(issue.created_at),
        container_id: containerId,
      }
    });
  }

  async getLastCheckTime(): Promise<Date | null> {
    const lastIssue = await this.prisma.gitlab_issues.findFirst({
      orderBy: { processed_at: 'desc' },
      select: { processed_at: true }
    });

    return lastIssue?.processed_at || null;
  }

  async getIssueStats(): Promise<{ total: number; lastWeek: number }> {
    const total = await this.prisma.gitlab_issues.count();

    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    const lastWeek = await this.prisma.gitlab_issues.count({
      where: { processed_at: { gte: weekAgo } }
    });

    return { total, lastWeek };
  }

  async findIssueByContainerId(containerId: string): Promise<GitLabIssueRecord | null> {
    const issue = await this.prisma.gitlab_issues.findFirst({
      where: { container_id: containerId }
    });

    if (!issue) return null;

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
      container_id: issue.container_id
    };
  }

  async findByGitLabIssueId(gitlabIssueId: number): Promise<GitLabIssueRecord | null> {
    const issue = await this.prisma.gitlab_issues.findUnique({
      where: { gitlab_issue_id: gitlabIssueId }
    });

    if (!issue) return null;

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
      container_id: issue.container_id
    };
  }

  async updateIssueLabels(gitlabIssueId: number, labels: string[]): Promise<void> {
    await this.prisma.gitlab_issues.update({
      where: { gitlab_issue_id: gitlabIssueId },
      data: {
        labels: JSON.stringify(labels),
        processed_at: new Date()
      }
    });
  }

  async getLifecycleStats(): Promise<{
    total: number;
    byStatus: Record<string, number>;
    completionRate: number;
  }> {
    const issues = await this.prisma.gitlab_issues.findMany({
      select: { labels: true }
    });

    const LIFECYCLE_LABELS = ['TODO', 'WIP', 'CONFIRM NEEDED', 'DONE', 'REJECT'];
    const statusCounts: Record<string, number> = {};

    LIFECYCLE_LABELS.forEach(label => {
      statusCounts[label] = 0;
    });
    statusCounts['NO_LABEL'] = 0;

    let completedCount = 0;

    for (const issue of issues) {
      const labels = JSON.parse(issue.labels) as string[];
      const lifecycleLabel = labels.find(label =>
        LIFECYCLE_LABELS.includes(label)
      );

      if (lifecycleLabel) {
        statusCounts[lifecycleLabel]++;
        if (lifecycleLabel === 'DONE') {
          completedCount++;
        }
      } else {
        statusCounts['NO_LABEL']++;
      }
    }

    const total = issues.length;
    const completionRate = total > 0 ? (completedCount / total) * 100 : 0;

    return {
      total,
      byStatus: statusCounts,
      completionRate
    };
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
