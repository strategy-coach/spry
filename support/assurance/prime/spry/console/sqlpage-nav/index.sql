SELECT 'dynamic' AS component, sqlpage.run_sql('spry/shell.sql') AS properties;
SELECT 'dynamic' AS component, sqlpage.run_sql('spry/nav-breadcrumbs.sql') AS properties;

SELECT 'title' AS component, 'Spry BaaS navigation in spry_navigation table' AS contents;
SELECT 'table' AS component, TRUE as sort, TRUE as search;
SELECT namespace as 'NS', path, caption, description FROM spry_navigation ORDER BY namespace, parent_path, path, sibling_order;
