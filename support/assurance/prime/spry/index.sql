SELECT 'dynamic' AS component, sqlpage.run_sql('spry/shell.sql') AS properties;

SELECT 'list' AS component;
SELECT caption || ' ' || sqlpage.path() as title, COALESCE(url, path) as link, description
  FROM spry_navigation
 WHERE parent_path = sqlpage.path()
 ORDER BY sibling_order;