-- @spry.nature partial
-- to override the path, use sqlpage.run_sql('spry/nav-breadcrumbs.sql', '{ "path": "/xyz" }')
-- for debugging use sqlpage.run_sql('spry/nav-breadcrumbs.sql', '{ "nature": "table" }')

SELECT CASE WHEN COALESCE($nature, 'breadcrumbs') = 'table' THEN 'table' ELSE 'breadcrumb' END AS component;
SELECT href_canonical as title, COALESCE(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX'), '') || href_canonical as link
FROM spry_route_crumb 
WHERE path_href = sqlpage.path()
ORDER BY crumb_index DESC;