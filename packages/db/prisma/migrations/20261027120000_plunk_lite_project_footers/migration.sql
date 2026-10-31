-- Plunk Lite: a project's own unsubscribe footers, by language. A table of its own, with no
-- foreign key to "projects", so that Plunk's own tables stay exactly as upstream has them and
-- going back to the official image only leaves this table unused.
-- CreateTable
CREATE TABLE "plunk_lite_project_footers" (
    "projectId" TEXT NOT NULL,
    "footers" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plunk_lite_project_footers_pkey" PRIMARY KEY ("projectId")
);

