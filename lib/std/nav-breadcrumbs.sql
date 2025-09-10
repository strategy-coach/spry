-- @spry.nature partial
-- to override the path, use sqlpage.run_sql('spry/nav-breadcrumbs.sql', '{ "path": "/xyz" }')
-- for debugging use sqlpage.run_sql('spry/nav-breadcrumbs.sql', '{ "nature": "table" }')

SELECT CASE WHEN COALESCE($nature, 'breadcrumbs') = 'table' THEN 'table' ELSE 'breadcrumb' END AS component;
WITH RECURSIVE breadcrumbs AS (
    SELECT
        COALESCE(abbreviated_caption, caption) AS title,
        COALESCE(url, path) AS link,
        parent_path, 0 AS level,
        namespace
    FROM spry_navigation
    WHERE namespace = 'spry' AND path = COALESCE($path, sqlpage.path())
    UNION ALL
    SELECT
        COALESCE(nav.abbreviated_caption, nav.caption) AS title,
        COALESCE(nav.url, nav.path) AS link,
        nav.parent_path, b.level + 1, nav.namespace
    FROM spry_navigation nav
    INNER JOIN breadcrumbs b ON nav.namespace = b.namespace AND nav.path = b.parent_path
)
SELECT title, COALESCE(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX'), '') || link as link
FROM breadcrumbs ORDER BY level DESC;