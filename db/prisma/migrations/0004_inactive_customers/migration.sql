-- D-43: customers that are not ACTIVE. Suspended customers' incidents are recorded but never paged
-- (Incident.pagingSuppressed); terminated customers get an offboarding checklist (CustomerOffboarding) and the
-- events that still arrive are only counted (OffboardResidual).
-- Generated part (prisma migrate diff); the RLS block at the end is hand-written (D-40: every table, no policies, not FORCEd).

-- CreateEnum
CREATE TYPE "PagingSuppressedReason" AS ENUM ('CUSTOMER_SUSPENDED');

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "statusChangedAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Incident" ADD COLUMN     "pagingSuppressed" "PagingSuppressedReason";

-- CreateTable
CREATE TABLE "CustomerOffboarding" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "startedByUserId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "CustomerOffboarding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OffboardResidual" (
    "customerId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "firstAt" TIMESTAMPTZ(3) NOT NULL,
    "lastAt" TIMESTAMPTZ(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "lastNotifiedAt" TIMESTAMPTZ(3),

    CONSTRAINT "OffboardResidual_pkey" PRIMARY KEY ("customerId","sourceKey")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerOffboarding_customerId_key" ON "CustomerOffboarding"("customerId");

-- AddForeignKey
ALTER TABLE "CustomerOffboarding" ADD CONSTRAINT "CustomerOffboarding_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OffboardResidual" ADD CONSTRAINT "OffboardResidual_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- D-40: ROW LEVEL SECURITY on the new tables, no policies, not FORCEd (the owner bypasses it).
ALTER TABLE "CustomerOffboarding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OffboardResidual" ENABLE ROW LEVEL SECURITY;

-- Repeat the REVOKE for Supabase's Data API roles (only where they exist, so plain postgres:16 works).
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
