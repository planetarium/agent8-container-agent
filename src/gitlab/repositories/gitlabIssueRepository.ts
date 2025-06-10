import { PrismaClient } from '@prisma/client';
import { GitLabIssue, GitLabIssueRecord } from '../types/index.js';

export class GitLabIssueRepository {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = new PrismaClient();
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

  async findIssuesByProjectId(projectId: number): Promise<GitLabIssueRecord[]> {
    const issues = await this.prisma.gitlab_issues.findMany({
      where: { project_id: projectId },
      orderBy: { processed_at: 'desc' }
    });

    return issues.map(issue => ({
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
    }));
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
