-- @route.title 'Spry BaaS Console' @route.caption "Spry Console"
-- @route.description 'Spry Backend-as-a-Service (BaaS) Console' 
SELECT 'dynamic' AS component, sqlpage.run_sql('spry/shell.sql') AS properties;
SELECT 'dynamic' AS component, sqlpage.run_sql('spry/nav-breadcrumbs.sql') AS properties;

WITH console_navigation_cte AS (
    SELECT title, description
      FROM spry_route
     WHERE path_href = sqlpage.path()
)
SELECT 'list' AS component, title || ' ' || sqlpage.path() as title, description
  FROM console_navigation_cte;
SELECT caption as title, COALESCE(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX'), '') || COALESCE(url, path_href) as link, description
  FROM spry_route_child
 WHERE parent_path_href = sqlpage.path()
 ORDER BY sibling_order;
            