-- expects `name` as query param (used as $name)

SELECT 'dynamic' AS component, sqlpage.run_sql('spry/shell.sql') AS properties;
SELECT 'dynamic' AS component, sqlpage.run_sql('spry/nav-breadcrumbs.sql') AS properties;

SELECT $name || ' View' AS title, '#' AS link;

SELECT 'title' AS component, $name AS contents;
SELECT 'table' AS component;
SELECT
    column_name AS "Column",
    data_type AS "Type"
FROM spry_console_info_schema_view
WHERE view_name = $name;

SELECT 'title' AS component, 'SQL DDL' as contents, 2 as level;
SELECT 'code' AS component;
SELECT 'sql' as language, (SELECT sql_ddl FROM spry_console_info_schema_view WHERE view_name = $name) as contents;
