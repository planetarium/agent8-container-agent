-- CreateTable
CREATE TABLE "gitlab_issues" (
    "id" BIGSERIAL NOT NULL,
    "gitlab_issue_id" INTEGER NOT NULL,
    "gitlab_iid" INTEGER NOT NULL,
    "project_id" INTEGER NOT NULL,
    "title" VARCHAR NOT NULL,
    "description" TEXT,
    "labels" TEXT NOT NULL,
    "author_username" VARCHAR NOT NULL,
    "web_url" VARCHAR NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "container_id" VARCHAR,

    CONSTRAINT "gitlab_issues_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gitlab_issues_gitlab_issue_id_key" ON "gitlab_issues"("gitlab_issue_id");

-- CreateIndex
CREATE INDEX "gitlab_issues_project_id_idx" ON "gitlab_issues"("project_id");

-- CreateIndex
CREATE INDEX "gitlab_issues_processed_at_idx" ON "gitlab_issues"("processed_at");

-- CreateIndex
CREATE INDEX "gitlab_issues_container_id_idx" ON "gitlab_issues"("container_id");
