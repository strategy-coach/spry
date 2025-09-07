SELECT 'dynamic' AS component, sqlpage.run_sql('spry/shell.sql') AS properties;
SELECT 'dynamic' AS component, sqlpage.run_sql('spry/nav-breadcrumbs.sql') AS properties;           

SELECT 'title' AS component, 'SQLPage pages generated from tables and views' AS contents;
SELECT 'text' AS component, '
  - `*.auto.sql` pages are auto-generated "default" content pages for each table and view defined in the database.
  - The `*.sql` companions may be auto-generated redirects to their `*.auto.sql` pair or an app/service might override the `*.sql` to not redirect and supply custom content for any table or view.
  - [View regenerate-auto.sql](' || COALESCE(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX'), '') || '/spry/console/sqlpage-files/sqlpage-file.sql?path=/spry/console/content/action/regenerate-auto.sql' || ')
  ' AS contents_md;

SELECT 'button' AS component, 'center' AS justify;
SELECT COALESCE(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX'), '') || '/spry/console/content/action/regenerate-auto.sql' AS link, 'info' AS color, 'Regenerate all "default" table/view content pages' AS title;

SELECT 'title' AS component, 'Redirected or overriden content pages' as contents;
SELECT 'table' AS component,
      'Path' as markdown,
      'Size' as align_right,
      TRUE as sort,
      TRUE as search;
      SELECT
  '[🚀](' || COALESCE(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX'), '') || '/' || path || ')[📄 ' || path || '](sqlpage-file.sql?path=' || path || ')' AS "Path",

  LENGTH(contents) as "Size", last_modified
FROM sqlpage_files
WHERE path like 'spry/console/content/%'
      AND NOT(path like 'spry/console/content/%.auto.sql')
      AND NOT(path like 'spry/console/content/action%')
ORDER BY path;

SELECT 'title' AS component, 'Auto-generated "default" content pages' as contents;
SELECT 'table' AS component,
      'Path' as markdown,
      'Size' as align_right,
      TRUE as sort,
      TRUE as search;
    SELECT
      '[🚀](' || COALESCE(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX'), '') || '/' || path || ') [📄 ' || path || '](sqlpage-file.sql?path=' || path || ')' AS "Path",

  LENGTH(contents) as "Size", last_modified
FROM sqlpage_files
WHERE path like 'spry/console/content/%.auto.sql'
ORDER BY path;            