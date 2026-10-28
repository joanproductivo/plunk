-- Plunk Lite: the secret each webhook step signs its requests with. A table of its own, with no
-- foreign key to "workflow_steps", so that Plunk's own tables stay exactly as upstream has them and
-- going back to the official image only leaves this table unused (its webhooks then go unsigned).
-- CreateTable
CREATE TABLE "plunk_lite_webhook_secrets" (
    "stepId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plunk_lite_webhook_secrets_pkey" PRIMARY KEY ("stepId")
);

-- CreateIndex
CREATE INDEX "plunk_lite_webhook_secrets_workflowId_idx" ON "plunk_lite_webhook_secrets"("workflowId");

-- CreateIndex
CREATE INDEX "plunk_lite_webhook_secrets_projectId_idx" ON "plunk_lite_webhook_secrets"("projectId");
