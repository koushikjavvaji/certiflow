-- CreateEnum
CREATE TYPE "Role" AS ENUM ('CENTRE', 'DISTRICT_OFFICER', 'QUALITY', 'STATE');

-- CreateEnum
CREATE TYPE "StepScope" AS ENUM ('DISTRICT', 'ANY');

-- CreateTable
CREATE TABLE "District" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdById" UUID,
    "updatedById" UUID,
    "meta" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "District_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Centre" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "districtId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdById" UUID,
    "updatedById" UUID,
    "meta" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "Centre_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "districtId" UUID,
    "centreId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdById" UUID,
    "updatedById" UUID,
    "meta" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdById" UUID,
    "updatedById" UUID,
    "meta" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowStep" (
    "id" UUID NOT NULL,
    "workflowVersion" INTEGER NOT NULL DEFAULT 1,
    "position" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "scope" "StepScope" NOT NULL DEFAULT 'ANY',
    "requiredApprovals" INTEGER NOT NULL DEFAULT 1,
    "slaMinutes" INTEGER,
    "condition" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdById" UUID,
    "updatedById" UUID,
    "meta" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "WorkflowStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Centre_districtId_idx" ON "Centre"("districtId");

-- CreateIndex
CREATE INDEX "User_districtId_idx" ON "User"("districtId");

-- CreateIndex
CREATE INDEX "User_centreId_idx" ON "User"("centreId");

-- CreateIndex
CREATE INDEX "WorkflowStep_workflowVersion_position_idx" ON "WorkflowStep"("workflowVersion", "position");

-- AddForeignKey
ALTER TABLE "Centre" ADD CONSTRAINT "Centre_districtId_fkey" FOREIGN KEY ("districtId") REFERENCES "District"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_districtId_fkey" FOREIGN KEY ("districtId") REFERENCES "District"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_centreId_fkey" FOREIGN KEY ("centreId") REFERENCES "Centre"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =====================================================================================
-- Hand-written (Prisma cannot express these in schema.prisma)
-- =====================================================================================

-- Uniqueness only among ACTIVE rows. A soft-deleted row must not block a new row from
-- reusing its name/key. (A plain UNIQUE would make soft delete leak into business rules.)
CREATE UNIQUE INDEX "District_name_active_key" ON "District" ("name") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "Setting_key_active_key" ON "Setting" ("key") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "WorkflowStep_version_position_active_key"
  ON "WorkflowStep" ("workflowVersion", "position") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "WorkflowStep_version_key_active_key"
  ON "WorkflowStep" ("workflowVersion", "key") WHERE "deletedAt" IS NULL;

-- A user's role decides which of districtId / centreId must be set, so bad data (e.g.
-- an officer who is also a centre user) cannot exist.
ALTER TABLE "User" ADD CONSTRAINT "User_role_scope_check" CHECK (
  ("role" = 'CENTRE'            AND "centreId"  IS NOT NULL AND "districtId" IS NULL) OR
  ("role" = 'DISTRICT_OFFICER'  AND "districtId" IS NOT NULL AND "centreId"  IS NULL) OR
  ("role" IN ('QUALITY','STATE') AND "districtId" IS NULL     AND "centreId"  IS NULL)
);

-- Config rows are edited by hand in the database, so the database itself rejects
-- nonsense instead of trusting the editor.
ALTER TABLE "WorkflowStep" ADD CONSTRAINT "WorkflowStep_requiredApprovals_check" CHECK ("requiredApprovals" >= 1);
ALTER TABLE "WorkflowStep" ADD CONSTRAINT "WorkflowStep_slaMinutes_check" CHECK ("slaMinutes" IS NULL OR "slaMinutes" > 0);
ALTER TABLE "WorkflowStep" ADD CONSTRAINT "WorkflowStep_position_check" CHECK ("position" >= 1);
ALTER TABLE "WorkflowStep" ADD CONSTRAINT "WorkflowStep_workflowVersion_check" CHECK ("workflowVersion" >= 1);
ALTER TABLE "Setting" ADD CONSTRAINT "Setting_key_check" CHECK (length(trim("key")) > 0);
