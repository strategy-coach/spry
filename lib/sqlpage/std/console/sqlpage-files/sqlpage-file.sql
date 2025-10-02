SELECT 'dynamic' AS component, sqlpage.run_sql('spry/shell.sql') AS properties;
SELECT 'dynamic' AS component, sqlpage.run_sql('spry/nav-breadcrumbs.sql') AS properties;

SELECT $path || ' Path' AS title, '#' AS link;

      SELECT 'title' AS component, $path AS contents;
      SELECT 'text' AS component,
             '```sql
' || (select sqlpage.read_file_as_text('spry.d/auto/resource/resources-catalog.auto.json') as contents) || '
```' as contents_md;
            