SELECT 'dynamic' AS component, sqlpage.run_sql('spry/shell.sql') AS properties;
SELECT 'dynamic' AS component, sqlpage.run_sql('spry/nav-breadcrumbs.sql') AS properties;

SELECT $path || ' Path' AS title, '#' AS link;

      SELECT 'title' AS component, $path AS contents;
      SELECT 'text' AS component,
             '```sql
' || (select contents FROM sqlpage_files where path = $path) || '
```' as contents_md;
            