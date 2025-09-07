-- @spry.nature api
SELECT 'dynamic' AS component, sqlpage.run_sql('spry/console/lib/populate-spry-table-info.sql') AS properties;

SELECT 'redirect' AS component, COALESCE(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX'), '') || '/spry/console/info-schema/index.sql' as link WHERE $redirect is NULL;
SELECT 'redirect' AS component, COALESCE(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX'), '') || $redirect as link WHERE $redirect is NOT NULL;