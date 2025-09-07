-- set role = (
--     SELECT role FROM users
--     INNER JOIN sessions ON users.id = sessions.user_id
--     WHERE sessions.session_id = sqlpage.cookie('session_id')
-- ); -- Read more about how to handle user sessions in the "authentication" component documentation
-- SELECT 
--     'shell' AS component,
--     'My authenticated website' AS title,

--     -- Add an admin panel link if the user is an admin
--     CASE WHEN $role = 'admin' THEN '{"link": "admin.sql", "title": "Admin panel"}' END AS menu_item,

--     -- Add a profile page if the user is authenticated
--     CASE WHEN $role IS NOT NULL THEN '{"link": "profile.sql", "title": "My profile"}' END AS menu_item,

--     -- Add a login link if the user is not authenticated
--     CASE WHEN $role IS NULL THEN 'login' END AS menu_item
-- ;

SELECT 'shell' AS component,
       'Spry BaaS' AS title,
       NULL AS icon,
       'https://www.surveilr.com/assets/brand/favicon.ico' AS favicon,
       'https://www.surveilr.com/assets/brand/surveilr-icon.png' AS image,
       'fluid' AS layout,
       true AS fixed_top_menu,
       '/spry/index.sql' AS link,
       '{"link":"/spry/index.sql","title":"Home"}' AS menu_item,
       'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/highlight.min.js' AS javascript,
       'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/languages/sql.min.js' AS javascript,
       'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/languages/handlebars.min.js' AS javascript,
       'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/languages/json.min.js' AS javascript,
       json_object(
              'link', COALESCE(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX'), '') || '/spry/docs/index.sql',
              'title', 'Docs',
              'submenu', (
                  SELECT json_group_array(
                      json_object(
                          'title', title,
                          'link', COALESCE(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX'), '') || link,
                          'description', description
                      )
                  )
                  FROM (
                      SELECT
                          COALESCE(abbreviated_caption, caption) as title,
                          COALESCE(url, path) as link,
                          description
                      FROM spry_navigation
                      WHERE namespace = 'spry' AND parent_path = '/spry/docs/index.sql'
                      ORDER BY sibling_order
                  )
              )
          ) as menu_item,       
       json_object(
              'link', COALESCE(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX'), '') ||'/console',
              'title', 'Console',
              'submenu', (
                  SELECT json_group_array(
                      json_object(
                          'title', title,
                          'link', COALESCE(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX'), '') || link,
                          'description', description
                      )
                  )
                  FROM (
                      SELECT
                          COALESCE(abbreviated_caption, caption) as title,
                          COALESCE(url, path) as link,
                          description
                      FROM spry_navigation
                      WHERE namespace = 'spry' AND parent_path = '/spry/console/index.sql'
                      ORDER BY sibling_order
                  )
              )
          ) as menu_item,       
       'Spry v0.0.1 Web UI (v' || sqlpage.version() || ') ' || '📄 [' || substr(sqlpage.path(), 2) || '](' || COALESCE(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX'), '') || '/console/sqlpage-files/sqlpage-file.sql?path=' || substr(sqlpage.path(), LENGTH(COALESCE(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX'), '')) + 2 ) || ')' as footer;