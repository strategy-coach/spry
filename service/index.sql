-- @route.title 'Application' @route.caption "App Home"
-- @route.description 'Welcome to Spry Application' 
SELECT 'dynamic' AS component, sqlpage.run_sql('spry/shell.sql') AS properties;

SELECT 'list' AS component;
SELECT caption as title, COALESCE(url, path) as link, description
  FROM spry_navigation
 WHERE parent_path = '/spry/index.sql'
 ORDER BY sibling_order;

select 
    'text' as component,
    'This is a default landing page, replace `index.sql` to add your content.' as contents_md;
