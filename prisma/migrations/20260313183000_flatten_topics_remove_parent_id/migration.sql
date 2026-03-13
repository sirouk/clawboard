CREATE TABLE "new_Topic" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "tags" TEXT,
  "color" TEXT,
  "status" TEXT,
  "priority" TEXT,
  "dueDate" DATETIME,
  "snoozedUntil" DATETIME,
  "createdAt" DATETIME NOT NULL,
  "updatedAt" DATETIME NOT NULL
);

INSERT INTO "new_Topic" (
  "id",
  "name",
  "description",
  "tags",
  "color",
  "status",
  "priority",
  "dueDate",
  "snoozedUntil",
  "createdAt",
  "updatedAt"
)
SELECT
  "id",
  "name",
  "description",
  "tags",
  "color",
  "status",
  "priority",
  "dueDate",
  "snoozedUntil",
  "createdAt",
  "updatedAt"
FROM "Topic";

DROP TABLE "Topic";
ALTER TABLE "new_Topic" RENAME TO "Topic";
