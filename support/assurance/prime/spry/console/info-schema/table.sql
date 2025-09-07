-- expects `name` as query param (used as $name)

SELECT 'dynamic' AS component, sqlpage.run_sql('spry/shell.sql') AS properties;            
SELECT 'dynamic' AS component, sqlpage.run_sql('spry/nav-breadcrumbs.sql') AS properties;

SELECT $name || ' Table' AS title, '#' AS link;

SELECT 'title' AS component, $name AS contents;
SELECT 'table' AS component;
SELECT
    column_name AS "Column",
    data_type AS "Type",
    is_primary_key AS "PK",
    is_not_null AS "Required",
    default_value AS "Default"
FROM console_information_schema_table
WHERE table_name = $name;

SELECT 'title' AS component, 'Foreign Keys' as contents, 2 as level;
SELECT 'table' AS component;
SELECT
    column_name AS "Column Name",
    foreign_key AS "Foreign Key"
FROM console_information_schema_table_col_fkey
WHERE table_name = $name;

SELECT 'title' AS component, 'Indexes' as contents, 2 as level;
SELECT 'table' AS component;
SELECT
    column_name AS "Column Name",
    index_name AS "Index Name"
FROM console_information_schema_table_col_index
WHERE table_name = $name;

SELECT 'title' AS component, 'SQL DDL' as contents, 2 as level;
SELECT 'code' AS component;
SELECT 'sql' as language, (SELECT sql_ddl FROM console_information_schema_table WHERE table_name = $name) as contents;
            