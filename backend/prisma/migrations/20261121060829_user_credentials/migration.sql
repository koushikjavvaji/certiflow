-- AlterTable
ALTER TABLE "User" ADD COLUMN     "email" TEXT,
ADD COLUMN     "passwordHash" TEXT;

-- Hand-written: one ACTIVE account per email (case-insensitive). A soft-deleted user does
-- not block the address from being used again.
CREATE UNIQUE INDEX "User_email_active_key" ON "User" (lower("email")) WHERE "isActive" AND "email" IS NOT NULL;
