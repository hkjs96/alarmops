-- Rotation writes (D-28 shift handover, D-41 roles; rotations API).
--
-- Rotation.version: If-Match / ETag of PATCH and DELETE /rotations/{id}.
-- RotationPin: who holds a stretch of time whatever the schedule says. Replaced as a whole on every handover/order change.
--   - rotation CASCADE (a deleted rotation takes its pins);
--   - contact RESTRICT: a person with a running or future pin cannot be deleted silently (the API answers IN_USE; the retention job
--     deletes the pins of a purged customer's contacts first).

-- AlterTable
ALTER TABLE "Rotation" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "RotationPin" (
    "id" TEXT NOT NULL,
    "rotationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "startAt" TIMESTAMPTZ(3) NOT NULL,
    "endAt" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RotationPin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RotationPin_rotationId_startAt_idx" ON "RotationPin"("rotationId", "startAt");

-- CreateIndex
CREATE INDEX "RotationPin_contactId_idx" ON "RotationPin"("contactId");

-- AddForeignKey
ALTER TABLE "RotationPin" ADD CONSTRAINT "RotationPin_rotationId_fkey" FOREIGN KEY ("rotationId") REFERENCES "Rotation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RotationPin" ADD CONSTRAINT "RotationPin_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written constraints (Prisma cannot express them)
ALTER TABLE "RotationPin" ADD CONSTRAINT "RotationPin_range_chk" CHECK ("startAt" < "endAt");
ALTER TABLE "RotationPin" ADD CONSTRAINT "RotationPin_reason_chk" CHECK ("reason" IS NULL OR "reason" IN ('CURRENT_SHIFT', 'KEEP_OVERRIDE'));

-- D-40: row level security like every table (no policies, not forced); db/scripts/check-rls.mjs fails CI without it.
ALTER TABLE "RotationPin" ENABLE ROW LEVEL SECURITY;
