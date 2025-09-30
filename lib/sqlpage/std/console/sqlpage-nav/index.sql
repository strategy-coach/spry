-- @route.title 'Spry Navigation Routes' @route.caption "Spry Routes"
-- @route.description 'Spry Backend-as-a-Service (BaaS) Navigation Routes' 
SELECT 'dynamic' AS component, sqlpage.run_sql('spry/shell.sql') AS properties;
SELECT 'dynamic' AS component, sqlpage.run_sql('spry/nav-breadcrumbs.sql') AS properties;

SELECT 'title' AS component, 'Spry BaaS navigation in spry_route table' AS contents;
SELECT 'table' AS component, TRUE as sort, TRUE as search;
SELECT * FROM spry_route ORDER BY path, sibling_order;
