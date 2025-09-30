-- @route.title 'Application' @route.caption "App Home"
-- @route.description 'Welcome to Spry Application' 
SELECT 'dynamic' AS component, sqlpage.run_sql('spry/shell.sql') AS properties;

SELECT 'text' AS component, sqlpage.path() as contents;

SELECT 'list' AS component;
SELECT caption as title, COALESCE(url, path_href) as link, description
  FROM spry_route
 WHERE path_href = sqlpage.path();

select 
    'text' as component,
    'This is a default primary end-to-end (`e2e-prime`) landing page, replace `index.sql` to add your content.' as contents_md;
