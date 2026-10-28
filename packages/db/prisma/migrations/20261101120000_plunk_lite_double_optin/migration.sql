-- Plunk Lite: double opt-in. A project's switch, sender and confirmation texts, and one request per
-- contact asked to confirm a sign-up. Tables of their own, with no foreign keys to "projects" or
-- "contacts", so that Plunk's own tables stay exactly as upstream has them and going back to the
-- official image only leaves these tables unused (its contacts still waiting stay unsubscribed).
-- CreateTable
CREATE TABLE "plunk_lite_optin_settings" (
    "projectId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "fromEmail" TEXT,
    "fromName" TEXT,
    "texts" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plunk_lite_optin_settings_pkey" PRIMARY KEY ("projectId")
);

-- CreateTable
CREATE TABLE "plunk_lite_optin_requests" (
    "contactId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "segmentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "emailId" TEXT,
    "sends" INTEGER NOT NULL DEFAULT 0,
    "windowStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unanswered" INTEGER NOT NULL DEFAULT 0,
    "lastSentAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plunk_lite_optin_requests_pkey" PRIMARY KEY ("contactId")
);

-- CreateIndex
CREATE UNIQUE INDEX "plunk_lite_optin_requests_tokenHash_key" ON "plunk_lite_optin_requests"("tokenHash");

-- CreateIndex
CREATE INDEX "plunk_lite_optin_requests_projectId_lastSentAt_idx" ON "plunk_lite_optin_requests"("projectId", "lastSentAt");

-- CreateIndex
CREATE INDEX "plunk_lite_optin_requests_projectId_confirmedAt_idx" ON "plunk_lite_optin_requests"("projectId", "confirmedAt");
