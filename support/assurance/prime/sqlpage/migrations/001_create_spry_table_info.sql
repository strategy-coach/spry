CREATE TABLE IF NOT EXISTS spry_table_info AS
    SELECT tbl.name AS table_name,
           x.*,
           datetime('now') AS generated_on
    FROM sqlite_schema AS tbl, 
        pragma_table_xinfo(tbl.name) AS x;

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
