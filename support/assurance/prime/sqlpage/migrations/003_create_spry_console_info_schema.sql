-- console_information_schema_* are convenience views
-- built on top of spry_table_info (filled via pragma_table_xinfo).
DROP VIEW IF EXISTS console_information_schema_table;
CREATE VIEW console_information_schema_table AS
SELECT tbl.name AS table_name,
       col.name AS column_name,
       col.type AS data_type,
       CASE WHEN col.pk > 0 THEN 'Yes' ELSE 'No' END AS is_primary_key,
       CASE WHEN col."notnull" = 1 THEN 'Yes' ELSE 'No' END AS is_not_null,
       col.dflt_value AS default_value,
       'console/info-schema/table.sql?name=' || tbl.name || '&stats=yes' as info_schema_web_ui_path,
       '[Content](console/info-schema/table.sql?name=' || tbl.name || '&stats=yes)' as info_schema_link_abbrev_md,
       '[' || tbl.name || ' (table) Schema](console/info-schema/table.sql?name=' || tbl.name || '&stats=yes)' as info_schema_link_full_md,
       'console/content/table/' || tbl.name || '.sql?stats=yes' as content_web_ui_path,
       '[Content]($SITE_PREFIX_URL/spry/console/content/table/' || tbl.name || '.sql?stats=yes)' as content_web_ui_link_abbrev_md,
       '[' || tbl.name || ' (table) Content]($SITE_PREFIX_URL/spry/console/content/table/' || tbl.name || '.sql?stats=yes)' as content_web_ui_link_full_md,
       tbl.sql as sql_ddl
FROM sqlite_schema AS tbl
JOIN spry_table_info AS col
ON col.table_name = tbl.name
WHERE tbl.type = 'table'
      AND tbl.name NOT LIKE 'sqlite_%'
      AND IFNULL(col.hidden, 0) = 0          -- show only visible columns from xinfo
ORDER BY tbl.name, col.cid;

-- Populate the view info using the helper table spry_table_info (no PRAGMAs in views)
DROP VIEW IF EXISTS console_information_schema_view;
CREATE VIEW console_information_schema_view AS
SELECT vw.name AS view_name,
       col.name AS column_name,
       col.type AS data_type,
       '/console/info-schema/view.sql?name=' || vw.name || '&stats=yes' as info_schema_web_ui_path,
       '[Content](console/info-schema/view.sql?name=' || vw.name || '&stats=yes)' as info_schema_link_abbrev_md,
       '[' || vw.name || ' (view) Schema](console/info-schema/view.sql?name=' || vw.name || '&stats=yes)' as info_schema_link_full_md,
       '/console/content/view/' || vw.name || '.sql?stats=yes' as content_web_ui_path,
       '[Content]($SITE_PREFIX_URL/spry/console/content/view/' || vw.name || '.sql?stats=yes)' as content_web_ui_link_abbrev_md,
       '[' || vw.name || ' (view) Content]($SITE_PREFIX_URL/spry/console/content/view/' || vw.name || '.sql?stats=yes)' as content_web_ui_link_full_md,
       vw.sql as sql_ddl
FROM sqlite_schema AS vw
JOIN spry_table_info AS col
ON col.table_name = vw.name
WHERE vw.type = 'view'
      AND vw.name NOT LIKE 'sqlite_%'
      AND IFNULL(col.hidden, 0) = 0
ORDER BY vw.name, col.cid;

DROP VIEW IF EXISTS console_content_tabular;
CREATE VIEW console_content_tabular AS
SELECT 'table' as tabular_nature,
        table_name as tabular_name,
        info_schema_web_ui_path,
        info_schema_link_abbrev_md,
        info_schema_link_full_md,
        content_web_ui_path,
        content_web_ui_link_abbrev_md,
        content_web_ui_link_full_md
    FROM console_information_schema_table
UNION ALL
SELECT 'view' as tabular_nature,
        view_name as tabular_name,
        info_schema_web_ui_path,
        info_schema_link_abbrev_md,
        info_schema_link_full_md,
        content_web_ui_path,
        content_web_ui_link_abbrev_md,
        content_web_ui_link_full_md
    FROM console_information_schema_view;

-- Populate the table with table column foreign keys
DROP VIEW IF EXISTS console_information_schema_table_col_fkey;
CREATE VIEW console_information_schema_table_col_fkey AS
SELECT
    tbl.name AS table_name,
    f."from" AS column_name,
    f."from" || ' references ' || f."table" || '.' || f."to" AS foreign_key
FROM sqlite_master tbl
JOIN pragma_foreign_key_list(tbl.name) f
WHERE tbl.type = 'table' AND tbl.name NOT LIKE 'sqlite_%';

-- Populate the table with table column indexes
DROP VIEW IF EXISTS console_information_schema_table_col_index;
CREATE VIEW console_information_schema_table_col_index AS
SELECT
    tbl.name AS table_name,
    pi.name AS column_name,
    idx.name AS index_name
FROM sqlite_master tbl
JOIN pragma_index_list(tbl.name) idx
JOIN pragma_index_info(idx.name) pi
WHERE tbl.type = 'table' AND tbl.name NOT LIKE 'sqlite_%'; 