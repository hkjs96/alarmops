-- D-45: retention of terminated customers' data. Legal hold on Customer, the purge log (certificate data), the
-- once-per-KST-day claim of the retention job, and the columns of the pseudonymized SLA record on Incident.
-- CloudAccount keeps its rows after offboarding (residual events must still map to the customer); the secrets are
-- emptied and `disabled` is set instead.
-- Generated part (prisma migrate diff); the CHECKs and the RLS block at the end are hand-written (D-40: every table, no policies, not FORCEd).

-- CreateEnum
CREATE TYPE "RetentionStage" AS ENUM ('CONNECTIONS', 'RETURN_PERIOD', 'AUDIT_EXPIRY', 'SLA_EXPIRY', 'LEGAL_HOLD_SET', 'LEGAL_HOLD_RELEASED');

-- CreateEnum
CREATE TYPE "PagingOutcome" AS ENUM ('DELIVERED', 'FAILED', 'NOT_PAGED');

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "legalHold" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "legalHoldAt" TIMESTAMPTZ(3),
ADD COLUMN     "legalHoldByUserId" TEXT,
ADD COLUMN     "legalHoldReason" TEXT;

-- AlterTable
ALTER TABLE "CloudAccount" ADD COLUMN     "connectionPurgedAt" TIMESTAMPTZ(3),
ADD COLUMN     "disabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Incident" ADD COLUMN     "purgedAt" TIMESTAMPTZ(3),
ADD COLUMN     "pagingOutcome" "PagingOutcome";

-- CreateTable
CREATE TABLE "RetentionPurgeLog" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "stage" "RetentionStage" NOT NULL,
    "counts" JSONB NOT NULL,
    "actor" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RetentionPurgeLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetentionClaim" (
    "day" TEXT NOT NULL,
    "claimedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RetentionClaim_pkey" PRIMARY KEY ("day")
);

-- CreateIndex
CREATE INDEX "RetentionPurgeLog_customerId_at_idx" ON "RetentionPurgeLog"("customerId", "at");

-- AddForeignKey
ALTER TABLE "RetentionPurgeLog" ADD CONSTRAINT "RetentionPurgeLog_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written: a purged incident has a paging outcome; a hold has its reason, time and author.
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_purged_outcome_chk" CHECK (("purgedAt" IS NULL) = ("pagingOutcome" IS NULL));
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_legal_hold_chk" CHECK (NOT "legalHold" OR ("legalHoldAt" IS NOT NULL AND "legalHoldReason" IS NOT NULL AND "legalHoldByUserId" IS NOT NULL));

-- D-40: ROW LEVEL SECURITY on the new tables, no policies, not FORCEd (the owner bypasses it).
ALTER TABLE "RetentionPurgeLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RetentionClaim" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', current_schema(), r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I', current_schema(), r);
    END IF;
  END LOOP;
END $$;
