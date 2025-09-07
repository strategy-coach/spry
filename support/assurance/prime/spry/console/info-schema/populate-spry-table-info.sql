DELETE FROM spry_table_info;
INSERT INTO spry_table_info
SELECT tbl.name AS table_name,
       x.*,
       datetime('now') AS generated_on
FROM sqlite_schema AS tbl,
     pragma_table_xinfo(tbl.name) AS x;

-- SELECT 'table' AS component;
-- SELECT *
-- FROM spry_table_info;

SELECT 'redirect' AS component, COALESCE(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX'), '') || '/spry/console/info-schema/index.sql' as link WHERE $redirect is NULL;
SELECT 'redirect' AS component, COALESCE(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX'), '') || $redirect as link WHERE $redirect is NOT NULL;