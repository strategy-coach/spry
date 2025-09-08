-- @spry.nature sql-sp

-- TODO: explain how this file is used to generate "default" or auto-generated content for all tables
--       it's especially useful to see how to generate API endpoints, etc. automatically

-- the "auto-generated" tables will be in '*.auto.sql' with redirects
DELETE FROM sqlpage_files WHERE path like 'spry/console/content/table/%.auto.sql';
DELETE FROM sqlpage_files WHERE path like 'spry/console/content/view/%.auto.sql';
INSERT OR REPLACE INTO sqlpage_files (path, contents)
SELECT
    'spry/console/content/' || tabular_nature || '/' || tabular_name || '.auto.sql',
    'SELECT ''dynamic'' AS component, sqlpage.run_sql(''spry/shell.sql'') AS properties;

        SELECT ''breadcrumb'' AS component;
        SELECT ''Home'' as title, COALESCE(sqlpage.environment_variable(''SQLPAGE_SITE_PREFIX''), '''''') || ''/spry/index.sql'' AS link;
        SELECT ''Console'' as title, COALESCE(sqlpage.environment_variable(''SQLPAGE_SITE_PREFIX''), '''''') || ''/spry/console/index.sql'' AS link;
        SELECT ''Content'' as title, COALESCE(sqlpage.environment_variable(''SQLPAGE_SITE_PREFIX''), '''''') || ''/spry/console/content/index.sql'' AS link;
        SELECT ''' || tabular_name  || ' ' || tabular_nature || ''' as title, ''#'' AS link;

        SELECT ''title'' AS component, ''' || tabular_name || ' (' || tabular_nature || ') Content'' as contents;

        SET total_rows = (SELECT COUNT(*) FROM ' || tabular_name || ');
        SET limit = COALESCE($limit, 50);
        SET offset = COALESCE($offset, 0);
        SET total_pages = ($total_rows + $limit - 1) / $limit;
        SET current_page = ($offset / $limit) + 1;

        SELECT ''text'' AS component, ''' || info_schema_link_full_md || ''' AS contents_md
        SELECT ''text'' AS component,
        ''- Start Row: '' || $offset || ''
'' ||
        ''- Rows per Page: '' || $limit || ''
'' ||
        ''- Total Rows: '' || $total_rows || ''
'' ||
        ''- Current Page: '' || $current_page || ''
'' ||
        ''- Total Pages: '' || $total_pages as contents_md
        WHERE $stats IS NOT NULL;

        -- Display uniform_resource table with pagination
        SELECT ''table'' AS component,
            TRUE AS sort,
            TRUE AS search,
            TRUE AS hover,
            TRUE AS striped_rows,
            TRUE AS small;
    SELECT * FROM ' || tabular_name || '
    LIMIT $limit
    OFFSET $offset;

    SELECT ''text'' AS component,
        (SELECT CASE WHEN $current_page > 1 THEN ''[Previous](?limit='' || $limit || ''&offset='' || ($offset - $limit) || '')'' ELSE '' '' END) || '' '' ||
        ''(Page '' || $current_page || '' of '' || $total_pages || '') '' ||
        (SELECT CASE WHEN $current_page < $total_pages THEN ''[Next](?limit='' || $limit || ''&offset='' || ($offset + $limit) || '')'' ELSE '' '' END)
        AS contents_md;'
FROM spry_console_content_tabular;

-- if there are no overrides, create some defaults
-- `INSERT OR IGNORE` is used so that if custom pages exist, we don't touch them
INSERT OR IGNORE INTO sqlpage_files (path, contents)
SELECT
    'spry/console/content/' || tabular_nature || '/' || tabular_name || '.sql',
    'SELECT ''redirect'' AS component, COALESCE(sqlpage.environment_variable(''SQLPAGE_SITE_PREFIX''), '''''') || ''/spry/console/content/' || tabular_nature || '/' || tabular_name || '.auto.sql'' AS link WHERE $stats IS NULL;
' ||
    'SELECT ''redirect'' AS component, COALESCE(sqlpage.environment_variable(''SQLPAGE_SITE_PREFIX''), '''''') || ''/spry/console/content/' || tabular_nature || '/' || tabular_name || '.auto.sql?stats='' || $stats AS link WHERE $stats IS NOT NULL;'
FROM spry_console_content_tabular;
