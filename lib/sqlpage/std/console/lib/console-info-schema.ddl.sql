-- console_information_schema_* are convenience views
-- built on top of spry_table_info (filled via pragma_table_xinfo).

-- -----------------------------------------------------------------------------
-- spry_console_info_schema_table
-- -----------------------------------------------------------------------------
-- Purpose:
--   Presents an "information schema"-style catalog for *tables* only, built on
--   top of the materialized metadata helper table `spry_table_info`.
--   We use `spry_table_info` because SQLite views cannot call table-valued
--   PRAGMAs (e.g., pragma_table_info / pragma_table_xinfo) directly.
--
-- What it shows (one row per table column):
--   - table_name     : user table name from sqlite_schema
--   - column_name    : column name for that table
--   - data_type      : declared column type
--   - is_primary_key : whether the column participates in the PK (pk > 0)
--   - is_not_null    : whether the column has a NOT NULL constraint
--   - default_value  : column default expression/value (if any)
--   - several convenience web-UI paths / Markdown links for your console
--   - sql_ddl        : the table's original CREATE TABLE DDL
--
-- Notes:
--   - Filters to real user tables (type='table' and name NOT LIKE 'sqlite_%').
--   - Filters out hidden columns that appear in xinfo (generated columns, rowid
--     aliases, etc.), i.e. IFNULL(col.hidden, 0) = 0.
--   - Orders rows by table and column id (cid) so columns appear in DDL order.

DROP VIEW IF EXISTS spry_console_info_schema_table;
CREATE VIEW spry_console_info_schema_table AS
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

-- -----------------------------------------------------------------------------
-- spry_console_info_schema_view
-- -----------------------------------------------------------------------------
-- Purpose:
--   Presents an "information schema"-style catalog for *views* only, again
--   built on `spry_table_info` so we do not invoke PRAGMAs inside this view.
--
-- What it shows (one row per view column):
--   - view_name      : user view name from sqlite_schema
--   - column_name    : column name as inferred by xinfo (via materialization)
--   - data_type      : declared/propagated type if available
--   - various console web-UI paths and Markdown links for convenience
--   - sql_ddl        : the view's original CREATE VIEW text
--
-- Notes:
--   - Filters to real user views (type='view' and name NOT LIKE 'sqlite_%').
--   - Filters out hidden xinfo columns, if any.
--   - Orders by view name and column id (cid).

DROP VIEW IF EXISTS spry_console_info_schema_view;
CREATE VIEW spry_console_info_schema_view AS
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

-- -----------------------------------------------------------------------------
-- spry_console_content_tabular
-- -----------------------------------------------------------------------------
-- Purpose:
--   Unifies the "table" and "view" information-schema rows into a single,
--   tabular catalog for navigation/UI consumption. Each row identifies whether
--   it represents a table or a view and carries the same set of link fields so
--   downstream code can render a single list.
--
-- Output columns:
--   - tabular_nature       : 'table' or 'view'
--   - tabular_name         : the table or view name
--   - info_schema_*        : console info-schema links (path + Markdown variants)
--   - content_web_ui_*     : console content links (path + Markdown variants)
--
-- Notes:
--   - Uses UNION ALL (not UNION) to retain all rows without de-duplication.

DROP VIEW IF EXISTS spry_console_content_tabular;
CREATE VIEW spry_console_content_tabular AS
SELECT 'table' as tabular_nature,
        table_name as tabular_name,
        info_schema_web_ui_path,
        info_schema_link_abbrev_md,
        info_schema_link_full_md,
        content_web_ui_path,
        content_web_ui_link_abbrev_md,
        content_web_ui_link_full_md
    FROM spry_console_info_schema_table
UNION ALL
SELECT 'view' as tabular_nature,
        view_name as tabular_name,
        info_schema_web_ui_path,
        info_schema_link_abbrev_md,
        info_schema_link_full_md,
        content_web_ui_path,
        content_web_ui_link_abbrev_md,
        content_web_ui_link_full_md
    FROM spry_console_info_schema_view;

-- -----------------------------------------------------------------------------
-- spry_console_info_schema_table_col_fkey
-- -----------------------------------------------------------------------------
-- Purpose:
--   Lists table *column-level* foreign key relationships in a concise form,
--   one row per FK column, e.g. "order.customer_id references customers.id".
--
-- Output columns:
--   - table_name : the child (referencing) table
--   - column_name: the child column that participates in the FK
--   - foreign_key: a human-readable "from → referenced" string
--
-- Implementation details:
--   - Joins user tables from sqlite_master to the table-valued
--     pragma_foreign_key_list(tbl.name) to fetch FK definitions.
--   - Filters out SQLite internal tables (name NOT LIKE 'sqlite_%').
--
-- IMPORTANT:
--   Many SQLite builds disallow table-valued PRAGMAs inside views
--   (for safety/nondeterminism reasons). If your environment blocks this,
--   you should *materialize* the FK info into a helper table (similar to
--   spry_table_info) and have this view read from that table instead.

DROP VIEW IF EXISTS spry_console_info_schema_table_col_fkey;
CREATE VIEW spry_console_info_schema_table_col_fkey AS
SELECT
    tbl.name AS table_name,
    f."from" AS column_name,
    f."from" || ' references ' || f."table" || '.' || f."to" AS foreign_key
FROM sqlite_master tbl
JOIN pragma_foreign_key_list(tbl.name) f
WHERE tbl.type = 'table' AND tbl.name NOT LIKE 'sqlite_%';

-- -----------------------------------------------------------------------------
-- spry_console_info_schema_table_col_index
-- -----------------------------------------------------------------------------
-- Purpose:
--   Lists *per-column index participation* for user tables, one row per
--   (table, column, index) triple.
--
-- Output columns:
--   - table_name : the indexed table
--   - column_name: the column covered by the index (in index position order)
--   - index_name : the index that includes the column
--
-- Implementation details:
--   - For each user table, pulls the list of indexes via pragma_index_list.
--   - For each index, expands its columns via pragma_index_info.
--   - Excludes internal SQLite objects.
--
-- IMPORTANT:
--   As with other table-valued PRAGMAs, some environments forbid using
--   pragma_index_list / pragma_index_info directly in views. If that applies
--   to you, stage the output in a materialized helper table and point this
--   view at that table instead.

DROP VIEW IF EXISTS spry_console_info_schema_table_col_index;
CREATE VIEW spry_console_info_schema_table_col_index AS
SELECT
    tbl.name AS table_name,
    pi.name AS column_name,
    idx.name AS index_name
FROM sqlite_master tbl
JOIN pragma_index_list(tbl.name) idx
JOIN pragma_index_info(idx.name) pi
WHERE tbl.type = 'table' AND tbl.name NOT LIKE 'sqlite_%'; 