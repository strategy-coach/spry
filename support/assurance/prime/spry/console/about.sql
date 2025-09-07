SELECT 'dynamic' AS component, sqlpage.run_sql('spry/shell.sql') AS properties;            
SELECT 'dynamic' AS component, sqlpage.run_sql('spry/nav-breadcrumbs.sql') AS properties;
              
SELECT 'text' AS component, ('Resource Surveillance v' || replace(sqlpage.exec('surveilr', '--version'), 'surveilr ', '')) AS title;

SELECT
    'text' AS component,
    'A detailed description of what is incorporated into surveilr. It informs of critical dependencies like rusqlite, sqlpage, pgwire, e.t.c, ensuring they are present and meet version requirements. Additionally, it scans for and executes capturable executables in the PATH and evaluates surveilr_doctor_* database views for more insights.'
    AS contents_md;

-- Section: Dependencies
SELECT
    'title' AS component,
    'Internal Dependencies' AS contents,
    2 AS level;
SELECT
    'table' AS component,
    TRUE AS sort;
SELECT
    "Dependency",
    "Version"
FROM (
    SELECT
        'SQLPage' AS "Dependency",
        json_extract(json_data, '$.versions.sqlpage') AS "Version"
    FROM (SELECT sqlpage.exec('surveilr', 'doctor', '--json') AS json_data)
    UNION ALL
    SELECT
        'Pgwire',
        json_extract(json_data, '$.versions.pgwire')
    FROM (SELECT sqlpage.exec('surveilr', 'doctor', '--json') AS json_data)
    UNION ALL
    SELECT
        'Rusqlite',
        json_extract(json_data, '$.versions.rusqlite')
    FROM (SELECT sqlpage.exec('surveilr', 'doctor', '--json') AS json_data)
);

-- Section: Static Extensions
SELECT
    'title' AS component,
    'Statically Linked Extensions' AS contents,
    2 AS level;
SELECT
    'table' AS component,
    TRUE AS sort;
SELECT
    json_extract(value, '$.name') AS "Extension Name",
    json_extract(value, '$.url') AS "URL",
    json_extract(value, '$.version') AS "Version"
FROM json_each(
    json_extract(sqlpage.exec('surveilr', 'doctor', '--json'), '$.static_extensions')
);

-- Section: Dynamic Extensions
SELECT
    'title' AS component,
    'Dynamically Linked Extensions' AS contents,
    2 AS level;
SELECT
    'table' AS component,
    TRUE AS sort;
SELECT
    json_extract(value, '$.name') AS "Extension Name",
    json_extract(value, '$.path') AS "Path"
FROM json_each(
    json_extract(sqlpage.exec('surveilr', 'doctor', '--json'), '$.dynamic_extensions')
);

-- Section: Environment Variables
SELECT
    'title' AS component,
    'Environment Variables' AS contents,
    2 AS level;
SELECT
    'table' AS component,
    TRUE AS sort;
SELECT
    json_extract(value, '$.name') AS "Variable",
    json_extract(value, '$.value') AS "Value"
FROM json_each(
    json_extract(sqlpage.exec('surveilr', 'doctor', '--json'), '$.env_vars')
);

-- Section: Capturable Executables
SELECT
    'title' AS component,
    'Capturable Executables' AS contents,
    2 AS level;
SELECT
    'table' AS component,
    TRUE AS sort;
SELECT
    json_extract(value, '$.name') AS "Executable Name",
    json_extract(value, '$.output') AS "Output"
FROM json_each(
    json_extract(sqlpage.exec('surveilr', 'doctor', '--json'), '$.capturable_executables')
);

SELECT 'title' AS component, 'Views' as contents;
SELECT 'table' AS component,
    'View' AS markdown,
    'Column Count' as align_right,
    'Content' as markdown,
    TRUE as sort,
    TRUE as search;

SELECT '[' || view_name || '](/console/info-schema/view.sql?name=' || view_name || ')' AS "View",
COUNT(column_name) AS "Column Count",
REPLACE(content_web_ui_link_abbrev_md, '$SITE_PREFIX_URL', COALESCE(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX'), '')) AS "Content"
FROM console_information_schema_view
WHERE view_name LIKE 'surveilr_doctor%'
GROUP BY view_name;
        