-- Compatibility DB cleanup for compatibility-layer retention.
-- This keeps the canonical 30-day default used by shared retention policy docs.
DELETE FROM "Event"
WHERE "createdAt" < datetime('now', '-30 days');

DELETE FROM "ActivityLog"
WHERE "createdAt" < datetime('now', '-30 days');

DELETE FROM "ImportJob"
WHERE "createdAt" < datetime('now', '-30 days');

DELETE FROM "Task"
WHERE "updatedAt" < datetime('now', '-30 days');

-- Topics are retained only while they still have child rows requiring them.
DELETE FROM "Topic"
WHERE "updatedAt" < datetime('now', '-30 days')
  AND id NOT IN (SELECT DISTINCT "topicId" FROM "Task" WHERE "topicId" IS NOT NULL)
  AND id NOT IN (SELECT DISTINCT "topicId" FROM "ActivityLog" WHERE "topicId" IS NOT NULL)
  AND id NOT IN (SELECT DISTINCT "topicId" FROM "Event" WHERE "topicId" IS NOT NULL);
