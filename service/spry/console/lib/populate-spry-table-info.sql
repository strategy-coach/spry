-- @spry.nature sql-sp

-- REFRESH STEP (run as a separate statement, not inside the view):
-- Rebuild the snapshot so it reflects the current schema at the moment of run.
-- This is necessary because we cannot select pragma_table_xinfo() on-the-fly in views.
DELETE FROM spry_table_info;

-- Repopulate the snapshot from the current schema.
INSERT INTO spry_table_info
SELECT tbl.name AS table_name,
       x.*,
       datetime('now') AS generated_on
FROM sqlite_schema AS tbl,
     pragma_table_xinfo(tbl.name) AS x;
