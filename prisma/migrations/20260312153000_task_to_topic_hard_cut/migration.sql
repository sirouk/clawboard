PRAGMA foreign_keys=OFF;

-- Promote the topic shape to hold all former task metadata.
ALTER TABLE "Topic" ADD COLUMN "status" TEXT;
ALTER TABLE "Topic" ADD COLUMN "priority" TEXT;
ALTER TABLE "Topic" ADD COLUMN "dueDate" DATETIME;
ALTER TABLE "Topic" ADD COLUMN "snoozedUntil" DATETIME;
ALTER TABLE "Topic" ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false;

CREATE TEMP TABLE "__legacy_task_parent_ids" AS
SELECT DISTINCT "topicId" AS "id"
FROM "Task"
WHERE "topicId" IS NOT NULL AND TRIM("topicId") != '';

-- Former tasks become top-level topics and keep their ids.
INSERT INTO "Topic" (
  "id",
  "name",
  "description",
  "parentId",
  "tags",
  "color",
  "status",
  "priority",
  "dueDate",
  "snoozedUntil",
  "pinned",
  "createdAt",
  "updatedAt"
)
SELECT
  "Task"."id",
  COALESCE(NULLIF(TRIM("Task"."title"), ''), "Task"."id"),
  NULL,
  NULL,
  NULL,
  "Task"."color",
  COALESCE(NULLIF(TRIM("Task"."status"), ''), 'todo'),
  'medium',
  NULL,
  NULL,
  false,
  "Task"."createdAt",
  "Task"."updatedAt"
FROM "Task"
WHERE NOT EXISTS (
  SELECT 1
  FROM "Topic"
  WHERE "Topic"."id" = "Task"."id"
);

-- Drop redundant parent topics only when they carry no direct activity or meaningful metadata.
DELETE FROM "Topic"
WHERE "id" IN (SELECT "id" FROM "__legacy_task_parent_ids")
  AND NOT EXISTS (
    SELECT 1
    FROM "ActivityLog"
    WHERE "ActivityLog"."topicId" = "Topic"."id"
  )
  AND COALESCE(TRIM("description"), '') = ''
  AND COALESCE(TRIM("tags"), '') = ''
  AND "dueDate" IS NULL
  AND "snoozedUntil" IS NULL
  AND COALESCE("pinned", false) = false
  AND COALESCE(TRIM("color"), '') = ''
  AND COALESCE(TRIM("priority"), 'medium') = 'medium'
  AND COALESCE(TRIM("status"), 'active') = 'active';

DROP TABLE "__legacy_task_parent_ids";
DROP INDEX IF EXISTS "Task_topicId_idx";
DROP TABLE "Task";

PRAGMA foreign_keys=ON;
