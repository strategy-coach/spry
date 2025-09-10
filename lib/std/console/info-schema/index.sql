-- @route.title "Spry BaaS Info Schema" @route.caption Spry Schema
SELECT 'dynamic' AS component, sqlpage.run_sql('spry/shell.sql') AS properties;
SELECT 'dynamic' AS component, sqlpage.run_sql('spry/nav-breadcrumbs.sql') AS properties;

select 
    'text' as component,
    '**NOTE**: the content here depends on `spry_table_info` table which _manually_ does what `pragma_table_info` does. ' ||
    'We cannot use `pragma_table_info` because it is not allowed in SQLite views. ' ||
    'Regenerate `spry_table_info` if something does not look right. Last generated: ' || (SELECT oldest_row_age from spry_table_info_gen_stats) || ' ago.' as contents_md;

SELECT 'button' AS component, 'center' AS justify;
SELECT COALESCE(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX'), '') || '/spry/console/action/populate-spry-table-info.sql' AS link, 'info' AS color, 'Rebuild spry_table_info table' AS title;

SELECT 'title' AS component, 'Tables' as contents;
SELECT 'table' AS component,
      'Table' AS markdown,
      'Column Count' as align_right,
      'Content' as markdown,
      TRUE as sort,
      TRUE as search;
SELECT
    '[' || table_name || '](table.sql?name=' || table_name || ')' AS "Table",
    COUNT(column_name) AS "Column Count",
    REPLACE(content_web_ui_link_abbrev_md,'$SITE_PREFIX_URL', COALESCE(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX'), '')) as "Content"
FROM spry_console_info_schema_table
GROUP BY table_name;

SELECT 'title' AS component, 'Views' as contents;
SELECT 'table' AS component,
      'View' AS markdown,
      'Column Count' as align_right,
      'Content' as markdown,
      TRUE as sort,
      TRUE as search;
SELECT
    '[' || view_name || '](view.sql?name=' || view_name || ')' AS "View",
    COUNT(column_name) AS "Column Count",
    REPLACE(content_web_ui_link_abbrev_md,'$SITE_PREFIX_URL', COALESCE(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX'), '')) as "Content"
FROM spry_console_info_schema_view
GROUP BY view_name;