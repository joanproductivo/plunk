-- Plunk Lite: what the reputation rates still count of a project's deleted emails, by the hour the
-- emails were created in. A table of its own, with no foreign key to "projects", so that Plunk's
-- own tables stay exactly as upstream has them and going back to the official image only leaves
-- this table unused.
-- CreateTable
CREATE TABLE "plunk_lite_deleted_email_counts" (
    "projectId" TEXT NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "bounced" INTEGER NOT NULL DEFAULT 0,
    "complained" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "plunk_lite_deleted_email_counts_pkey" PRIMARY KEY ("projectId","hour")
);
