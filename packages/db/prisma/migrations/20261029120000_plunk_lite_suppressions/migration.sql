-- Plunk Lite: addresses a project must not email again after a permanent bounce or a complaint.
-- A table of its own, with no foreign key to "projects", so that Plunk's own tables stay exactly
-- as upstream has them and going back to the official image only leaves this table unused.
-- CreateTable
CREATE TABLE "plunk_lite_suppressions" (
    "projectId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "emailId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plunk_lite_suppressions_pkey" PRIMARY KEY ("projectId","email")
);

-- Seed it with the bounces and complaints already recorded, for contacts that are unsubscribed
-- today. A contact subscribed again since its bounce was resubscribed on purpose and is left
-- alone; so are emails to a workflow's custom recipient (not the contact) and simulator emails.
INSERT INTO "plunk_lite_suppressions" ("projectId", "email", "reason", "emailId", "createdAt")
SELECT DISTINCT ON (e."projectId", c."email")
    e."projectId",
    c."email",
    CASE WHEN e."complainedAt" IS NOT NULL OR e."status" = 'COMPLAINED' THEN 'COMPLAINT' ELSE 'BOUNCE' END,
    e."id",
    COALESCE(e."complainedAt", e."bouncedAt", e."updatedAt")
FROM "emails" e
JOIN "contacts" c ON c."id" = e."contactId"
WHERE c."subscribed" = false
  AND (e."bouncedAt" IS NOT NULL OR e."complainedAt" IS NOT NULL OR e."status" IN ('BOUNCED', 'COMPLAINED'))
  AND NOT e."simulated"
  AND NOT (COALESCE(e."headers", '{}'::jsonb) ? 'X-Plunk-Recipient-Override')
ORDER BY e."projectId", c."email",
    (e."complainedAt" IS NOT NULL OR e."status" = 'COMPLAINED') DESC,
    e."updatedAt" DESC;
