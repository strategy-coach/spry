-- @route.title 'Spry Backend-as-a-Service (BaaS)' @route.caption "Spry BaaS"
-- @route.description 'Welcome to Spry Backend-as-a-Service (BaaS) Database' 
SELECT 'dynamic' AS component, sqlpage.run_sql('spry/shell.sql') AS properties;

SELECT
   'title' AS component,
   'Entries annotated with @spry.* or @route.* tags in comments' AS contents,
   1 AS level;

SET entries_json = sqlpage.read_file_as_text('spry.d/auto/entry/entries.auto.json');
SET entries_json_safe = COALESCE(NULLIF($entries_json, ''), '[]');

SELECT 'big_number' as component;
WITH items AS (
  SELECT j.value AS item
  FROM (SELECT $entries_json_safe AS entries_json)
  CROSS JOIN json_each(entries_json) AS j
)
SELECT
  COALESCE(item ->> '$.nature', '(none)') AS title,
  COUNT(*) AS value
FROM items
GROUP BY title
ORDER BY title, title;

SELECT
  'table' AS component,
  'Entries' AS title,
  true AS striped_rows;

WITH json_src AS (
  SELECT j.value AS item
  FROM (SELECT $entries_json AS entries_json)
  CROSS JOIN json_each(COALESCE(NULLIF(entries_json, ''), '[]')) AS j
)
SELECT
  item ->> '$.isSystemGenerated'   AS "Sys?",
  item ->> '$.nature'              AS "Nature",
  item ->> '$.route.caption'       AS "Route Caption",
  item ->> '$.webPath'             AS "SQLPage Path",
  item ->> '$.relFsPath'           AS "Project Path"
FROM json_src
ORDER BY "Nature";
