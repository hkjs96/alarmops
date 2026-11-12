-- D-42: Customer.status. A customer that is not ACTIVE keeps its data; its portal users get no session (401).
-- MSP staff are unaffected. Ingest does not read this column (open question in DECISIONS.md).
-- Generated part (prisma migrate diff); no new table, so the RLS of 0002_rls is unchanged.

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'TERMINATED');

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "status" "CustomerStatus" NOT NULL DEFAULT 'ACTIVE';
