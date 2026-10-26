-- Plunk Lite: a project's brand, which new emails are written in. A table of its own, with no
-- foreign key to "projects", so that Plunk's own tables stay exactly as upstream has them and
-- going back to the official image only leaves this table unused.
-- CreateTable
CREATE TABLE "plunk_lite_project_brands" (
    "projectId" TEXT NOT NULL,
    "brand" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plunk_lite_project_brands_pkey" PRIMARY KEY ("projectId")
);

