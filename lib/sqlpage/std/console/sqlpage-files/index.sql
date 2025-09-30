-- @route.title 'SQLPage Files Table' @route.caption "SQLPage Files"
SELECT 'dynamic' AS component, sqlpage.run_sql('spry/shell.sql') AS properties;
SELECT 'dynamic' AS component, sqlpage.run_sql('spry/nav-breadcrumbs.sql') AS properties;          

SELECT 'title' AS component, 'SQLPage pages in sqlpage_files table' AS contents;
SELECT 'table' AS component,
      'Path' as markdown,
      'Size' as align_right,
      TRUE as sort,
      TRUE as search;
   SELECT
  '[🚀](' || COALESCE(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX'), '') || '/' || path || ') [📄 ' || path || '](sqlpage-file.sql?path=' || path || ')' AS "Path",
  nature, LENGTH(contents) as "Size", last_modified
FROM sqlpage_files
ORDER BY path;            