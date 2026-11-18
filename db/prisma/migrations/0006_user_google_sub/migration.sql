-- Sign-in binds the Google account id (`sub`): an e-mail address can be reassigned to another person, the sub cannot.
-- Nullable (bound at the first sign-in), unique (one Google account = one user). No new table: RLS (D-40) is unchanged.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "googleSub" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_googleSub_key" ON "User"("googleSub");
