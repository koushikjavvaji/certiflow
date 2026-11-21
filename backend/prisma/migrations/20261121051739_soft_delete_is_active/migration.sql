-- Soft delete changes from a timestamp (deletedAt) to a flag (isActive).
-- Written by hand instead of using Prisma's generated "drop column, add column" so that
-- existing rows keep their state: a row that was deleted stays deleted.

-- 1) Add the flag, fill it from the old column.
ALTER TABLE "District"     ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Centre"       ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User"         ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Setting"      ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "WorkflowStep" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;

UPDATE "District"     SET "isActive" = ("deletedAt" IS NULL);
UPDATE "Centre"       SET "isActive" = ("deletedAt" IS NULL);
UPDATE "User"         SET "isActive" = ("deletedAt" IS NULL);
UPDATE "Setting"      SET "isActive" = ("deletedAt" IS NULL);
UPDATE "WorkflowStep" SET "isActive" = ("deletedAt" IS NULL);

-- 2) Rebuild the "unique among ACTIVE rows" indexes on the new column.
DROP INDEX "District_name_active_key";
DROP INDEX "Setting_key_active_key";
DROP INDEX "WorkflowStep_version_position_active_key";
DROP INDEX "WorkflowStep_version_key_active_key";

CREATE UNIQUE INDEX "District_name_active_key" ON "District" ("name") WHERE "isActive";
CREATE UNIQUE INDEX "Setting_key_active_key" ON "Setting" ("key") WHERE "isActive";
CREATE UNIQUE INDEX "WorkflowStep_version_position_active_key"
  ON "WorkflowStep" ("workflowVersion", "position") WHERE "isActive";
CREATE UNIQUE INDEX "WorkflowStep_version_key_active_key"
  ON "WorkflowStep" ("workflowVersion", "key") WHERE "isActive";

-- 3) Remove the old column.
ALTER TABLE "District"     DROP COLUMN "deletedAt";
ALTER TABLE "Centre"       DROP COLUMN "deletedAt";
ALTER TABLE "User"         DROP COLUMN "deletedAt";
ALTER TABLE "Setting"      DROP COLUMN "deletedAt";
ALTER TABLE "WorkflowStep" DROP COLUMN "deletedAt";
