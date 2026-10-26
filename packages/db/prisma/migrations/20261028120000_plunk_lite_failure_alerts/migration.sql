-- Plunk Lite: where failure alerts go, and the failures themselves, one row per source. Tables
-- of their own, with no foreign key to "projects", so that Plunk's own tables stay exactly as
-- upstream has them and going back to the official image only leaves these tables unused.
-- CreateTable
CREATE TABLE "plunk_lite_alert_settings" (
    "projectId" TEXT NOT NULL,
    "recipients" TEXT[],
    "fromEmail" TEXT NOT NULL,
    "fromName" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plunk_lite_alert_settings_pkey" PRIMARY KEY ("projectId")
);

-- CreateTable
CREATE TABLE "plunk_lite_failures" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "projectId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "lastError" TEXT NOT NULL,
    "lastContactEmail" TEXT,
    "firstAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notifiedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "plunk_lite_failures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plunk_lite_failures_projectId_sourceKey_key" ON "plunk_lite_failures"("projectId", "sourceKey");

