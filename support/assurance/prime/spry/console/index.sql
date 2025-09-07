SELECT 'dynamic' AS component, sqlpage.run_sql('spry/shell.sql') AS properties;
SELECT 'dynamic' AS component, sqlpage.run_sql('spry/nav-breadcrumbs.sql') AS properties;

WITH console_navigation_cte AS (
    SELECT title, description
      FROM spry_navigation
     WHERE namespace = 'spry' AND path = sqlpage.path()
)
SELECT 'list' AS component, title || ' ' || sqlpage.path() as title, description
  FROM console_navigation_cte;
SELECT caption as title, COALESCE(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX'), '') || COALESCE(url, path) as link, description
  FROM spry_navigation
 WHERE namespace = 'spry' AND parent_path = sqlpage.path()
 ORDER BY sibling_order;
            