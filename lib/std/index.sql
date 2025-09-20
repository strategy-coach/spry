-- @route.title 'Spry Backend-as-a-Service (BaaS)' @route.caption "Spry BaaS"
-- @route.description 'Welcome to Spry Backend-as-a-Service (BaaS) Database' 
SELECT 'dynamic' AS component, sqlpage.run_sql('spry/shell.sql') AS properties;

SELECT 'list' AS component;
SELECT caption || ' ' || sqlpage.path() as title, COALESCE(url, path_href) as link, description
  FROM spry_route_child
 WHERE parent_path_href = sqlpage.path()
 ORDER BY sibling_order;