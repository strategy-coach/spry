-- #include shahid -f ./bad.sql
-- NotFound: No such file or directory (os error 2): readfile '/home/snshah/workspaces/github.com/strategy-coach/spry/lib/std/bad.sql'
-- #includeEnd shahid

-- @route.title 'Spry Backend-as-a-Service (BaaS)' @route.caption "Spry BaaS"
-- @route.description 'Welcome to Spry Backend-as-a-Service (BaaS) Database' 
SELECT 'dynamic' AS component, sqlpage.run_sql('spry/shell.sql') AS properties;

SELECT
   'title' AS component,
   'Resources annotated with @spry.* or @route.* tags in comments' AS contents,
   1 AS level;

SET resources_json = sqlpage.read_file_as_text('spry.d/auto/resource/resources.auto.json');
SET resources_json_safe = COALESCE(NULLIF($resources_json, ''), '[]');

SELECT 'big_number' as component;
WITH items AS (
  SELECT j.value AS item
  FROM (SELECT $resources_json_safe AS resources_json)
  CROSS JOIN json_each(resources_json) AS j
)
SELECT
  COALESCE(item ->> '$.nature', '(none)') AS title,
  COUNT(*) AS value
FROM items
GROUP BY title
ORDER BY title, title;

SELECT
  'table' AS component,
  'Resource' AS title,
  true AS striped_rows;

WITH json_src AS (
  SELECT j.value AS item
  FROM (SELECT $resources_json AS resources_json)
  CROSS JOIN json_each(COALESCE(NULLIF(resources_json, ''), '[]')) AS j
)
SELECT
  item ->> '$.isSystemGenerated'   AS "Sys?",
  item ->> '$.nature'              AS "Nature",
  item ->> '$.route.caption'       AS "Route Caption",
  item ->> '$.webPath'             AS "SQLPage Path",
  item ->> '$.relFsPath'           AS "Project Path"
FROM json_src
ORDER BY "Nature";
