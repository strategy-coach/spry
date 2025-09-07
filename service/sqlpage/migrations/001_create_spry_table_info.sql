-- We cannot use pragma_table_xinfo() directly in a VIEW definition because SQLite
-- disallows table-valued PRAGMAs in views (SQLite treats them as unsafe).
-- Therefore, we *materialize* the metadata by creating a real table and filling
-- it with the output of pragma_table_xinfo() for every entry in sqlite_schema.
-- This snapshot can then be queried by other views.
-- The main problem is that it needs to be refreshed in case of DDL migrations
-- or table updates.
--
-- Columns:
--   table_name  : the table (or view) name from sqlite_schema
--   x.*         : all columns reported by pragma_table_xinfo (cid, name, type,
--                 "notnull", dflt_value, pk, hidden, etc.)
--   generated_on: timestamp of when this snapshot row was produced

CREATE TABLE IF NOT EXISTS spry_table_info AS
    SELECT tbl.name AS table_name,
           x.*,
           datetime('now') AS generated_on
    FROM sqlite_schema AS tbl, 
        pragma_table_xinfo(tbl.name) AS x;

-- This VIEW reports basic "freshness" stats about the materialized metadata
-- in spry_table_info. Because the PRAGMA can't be used in a view, we operate
-- purely over the materialized table.
-- CTEs:
--   stats    : overall min/max timestamps across the snapshot
--   oldest   : the single oldest row (by generated_on) and its table name
--   youngest : the single newest row (by generated_on) and its table name
--
-- Result columns:
--   oldest_row_date  : timestamp of the oldest snapshot row
--   oldest_row_age   : human-readable age since that timestamp
--   oldest_row_name  : the table corresponding to the oldest row
--   youngest_row_date: timestamp of the newest snapshot row
--   youngest_row_age : human-readable age since that timestamp
--   youngest_row_name: the table corresponding to the newest row

CREATE VIEW spry_table_info_gen_stats AS
WITH stats AS (
    SELECT
        MIN(generated_on) AS oldest_row_date,
        MAX(generated_on) AS youngest_row_date
    FROM spry_table_info
),
oldest AS (
    SELECT
        table_name AS oldest_row_name,
        generated_on AS oldest_row_date
    FROM spry_table_info
    ORDER BY generated_on ASC
    LIMIT 1
),
youngest AS (
    SELECT
        table_name AS youngest_row_name,
        generated_on AS youngest_row_date
    FROM spry_table_info
    ORDER BY generated_on DESC
    LIMIT 1
)
SELECT
    -- Oldest row details
    oldest.oldest_row_date,
    CAST((julianday('now') - julianday(oldest.oldest_row_date)) AS INTEGER) || ' days, ' ||
    CAST(((julianday('now') - julianday(oldest.oldest_row_date)) * 24) % 24 AS INTEGER) || ' hours, ' ||
    CAST(((julianday('now') - julianday(oldest.oldest_row_date)) * 24 * 60) % 60 AS INTEGER) || ' minutes, ' ||
    CAST(ROUND(((julianday('now') - julianday(oldest.oldest_row_date)) * 24 * 60 * 60) % 60) AS INTEGER) || ' seconds'
        AS oldest_row_age,
    oldest.oldest_row_name,

    -- Youngest row details
    youngest.youngest_row_date,
    CAST((julianday('now') - julianday(youngest.youngest_row_date)) AS INTEGER) || ' days, ' ||
    CAST(((julianday('now') - julianday(youngest.youngest_row_date)) * 24) % 24 AS INTEGER) || ' hours, ' ||
    CAST(((julianday('now') - julianday(youngest.youngest_row_date)) * 24 * 60) % 60 AS INTEGER) || ' minutes, ' ||
    CAST(ROUND(((julianday('now') - julianday(youngest.youngest_row_date)) * 24 * 60 * 60) % 60) AS INTEGER) || ' seconds'
        AS youngest_row_age,
    youngest.youngest_row_name
FROM stats, oldest, youngest;
