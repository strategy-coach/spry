-- @route.title 'Application' @route.caption "App Home"
-- @route.description 'Welcome to Spry Application' 
SELECT 'dynamic' AS component, sqlpage.run_sql('spry/shell.sql') AS properties;

SELECT 'text' AS component, sqlpage.path() as contents;

SELECT 'list' AS component;
SELECT caption as title, COALESCE(url, path) as link, description
  FROM spry_route_path
 WHERE path = substr(
        sqlpage.path(),
        1,
        length(sqlpage.path()) - instr(
            replace(sqlpage.path(), '/', char(1)) || char(1),
            char(1)
        )
    );

select 
    'text' as component,
    'This is a default primary end-to-end (`e2e-prime`) landing page, replace `index.sql` to add your content.' as contents_md;
