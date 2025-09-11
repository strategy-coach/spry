-- @spry.nature sql @spry.sqlImpact dml

-- Spry schema information is stored in sqlpage_files as a single-row-per-schema
-- catalog with path 'spry/lib/info-schema.json' (where 'main' is schhema).
-- Stores a prettifiedJSON graph of the entire SQLite schema (tables, columns, 
-- indexes, foreign keys, views, triggers, and derived relations). These views 
-- project that JSON back into relational form for easy querying. Filter by 
-- schema_name in WHERE clauses (e.g., WHERE s.path = 'spry/lib/info-schema.json'). 
-- Requires SQLite JSON1.

-- Populate with a comprehensive JSON graph of the current schema
INSERT OR REPLACE INTO sqlpage_files (path, contents)
VALUES (
  'spry/lib/info-schema.json',
  json_pretty(
    json_object(
      'schema_name', 'main',
      'generated_on', datetime('now'),
      'sqlite_version', sqlite_version(),

      -- Attached databases
      'databases',
      (SELECT json_group_array(json_object('seq', seq, 'db_name', name, 'db_file', file))
         FROM pragma_database_list),

      -- Available collations
      'collations',
      (SELECT json_group_array(json_object('seq', seq, 'name', name))
         FROM pragma_collation_list),

      -- Tables keyed by name, with nested columns, indexes, FKs, triggers
      'tables',
      (
        SELECT json_group_object(
                 tl.name,
                 json_object(
                   'type', tl.type,                 -- 'table'
                   'strict', tl.strict,
                   'without_rowid', 0,              -- not exposed by pragma_table_list; set 0 by default
                   'ncol', tl.ncol,
                   'sql', (SELECT s.sql FROM sqlite_schema AS s WHERE s.type='table' AND s.name=tl.name),

                   'columns',
                   (SELECT json_group_array(
                             json_object(
                               'cid', x.cid,
                               'name', x.name,
                               'type', x.type,
                               'notnull', x."notnull",
                               'dflt_value', x.dflt_value,
                               'pk', x.pk,
                               'hidden', x.hidden
                             )
                           )
                      FROM pragma_table_xinfo(tl.name) AS x),

                   'indexes',
                   (SELECT json_group_array(
                             json_object(
                               'name', il.name,
                               'origin', il.origin,          -- 'c','u','pk'
                               'unique', il."unique",
                               'partial', il.partial,
                               'where',
                                 (SELECT s.sql FROM sqlite_schema AS s
                                   WHERE s.type='index' AND s.name=il.name),
                               'columns',
                                 (SELECT json_group_array(
                                           json_object(
                                             'seqno', ixi.seqno,
                                             'cid', ixi.cid,
                                             'name', ixi.name,
                                             'desc', ixi."desc",
                                             'coll', ixi.coll,
                                             'key', ixi."key"
                                           )
                                         )
                                    FROM pragma_index_xinfo(il.name) AS ixi)
                             )
                           )
                      FROM pragma_index_list(tl.name) AS il),

                   'foreign_keys',
                   (SELECT json_group_array(
                             json_object(
                               'id', fk.id,
                               'seq', fk.seq,
                               'from', fk."from",
                               'to', fk."to",
                               'table', fk."table",
                               'on_update', fk.on_update,
                               'on_delete', fk.on_delete,
                               'match', fk."match"
                             )
                           )
                      FROM pragma_foreign_key_list(tl.name) AS fk),

                   'triggers',
                   (SELECT json_group_array(
                             json_object(
                               'name', t.name,
                               'sql',  t.sql
                             )
                           )
                      FROM sqlite_schema AS t
                     WHERE t.type='trigger' AND t.tbl_name=tl.name)
                 )
               )
          FROM pragma_table_list AS tl
         WHERE tl.type='table' AND tl.name NOT LIKE 'sqlite_%'
      ),

      -- Views keyed by name
      'views',
      (
        SELECT json_group_object(
                 v.name,
                 json_object(
                   'type', 'view',
                   'sql',  v.sql,
                   'dependencies', json('[]') -- placeholder (dependency parsing is non-trivial)
                 )
               )
          FROM sqlite_schema AS v
         WHERE v.type='view' AND v.name NOT LIKE 'sqlite_%'
      ),

      -- Virtual tables keyed by name (basic capture)
      'virtual_tables',
      (
        SELECT json_group_object(
                 tl.name,
                 json_object(
                   'type', tl.type,  -- 'virtual'
                   'sql', (SELECT s.sql FROM sqlite_schema AS s WHERE s.type='table' AND s.name=tl.name)
                 )
               )
          FROM pragma_table_list AS tl
         WHERE tl.type='virtual' AND tl.name NOT LIKE 'sqlite_%'
      ),

      -- Triggers keyed by name (top-level convenience)
      'triggers',
      (
        SELECT json_group_object(
                 t.name,
                 json_object(
                   'table', t.tbl_name,
                   'sql',   t.sql
                 )
               )
          FROM sqlite_schema AS t
         WHERE t.type='trigger' AND t.name NOT LIKE 'sqlite_%'
      ),

      -- Relations derived from all foreign keys
      'relations',
      (
        SELECT json_group_array(
                 json_object(
                   'name', printf('%s_%s_%s_%s', fk.tbl_name, fk."from", fk."table", fk."to"),
                   'from_table', fk.tbl_name,
                   'from_columns', json_array(fk."from"),
                   'to_table', fk."table",
                   'to_columns', json_array(fk."to"),
                   'type', 'many_to_one',
                   'on_update', fk.on_update,
                   'on_delete', fk.on_delete,
                   'match', fk."match"
                 )
               )
          FROM (
                 SELECT
                   tbl.name AS tbl_name,
                   fk."from",
                   fk."to",
                   fk."table",
                   fk.on_update,
                   fk.on_delete,
                   fk."match"
                 FROM sqlite_schema AS tbl,
                      pragma_foreign_key_list(tbl.name) AS fk
                 WHERE tbl.type='table' AND tbl.name NOT LIKE 'sqlite_%'
               ) AS fk
      )
    )
  )
);

-- Tables (one row per table)
DROP VIEW IF EXISTS spry_schema_info_table;
CREATE VIEW IF NOT EXISTS spry_schema_info_table AS
SELECT
  'main'                                    AS schema_name,
  t.key                                     AS table_name,
  json_extract(t.value,'$.type')            AS type,
  json_extract(t.value,'$.ncol')            AS ncol,
  json_extract(t.value,'$.strict')          AS strict,
  json_extract(t.value,'$.without_rowid')   AS without_rowid,
  json_extract(t.value,'$.sql')             AS definition_sql
FROM sqlpage_files AS s,
     json_each(s.contents, '$.tables') AS t
WHERE s.path = 'spry/lib/info-schema.json';

-- Table columns (one row per column per table)
DROP VIEW IF EXISTS spry_schema_info_table_column;
CREATE VIEW IF NOT EXISTS spry_schema_info_table_column AS
SELECT
  'main'                                        AS schema_name,
  t.key                                         AS table_name,
  json_extract(c.value,'$.cid')                 AS cid,
  json_extract(c.value,'$.name')                AS column_name,
  json_extract(c.value,'$.type')                AS column_type,
  json_extract(c.value,'$.notnull')             AS not_null,
  json_extract(c.value,'$.dflt_value')          AS dflt_value,
  json_extract(c.value,'$.pk')                  AS part_of_pk,
  json_extract(c.value,'$.hidden')              AS hidden
FROM sqlpage_files AS s,
     json_each(s.contents, '$.tables') AS t,
     json_each(t.value, '$.columns')           AS c
WHERE s.path = 'spry/lib/info-schema.json';

-- Views (one row per view)
DROP VIEW IF EXISTS spry_schema_info_view;
CREATE VIEW IF NOT EXISTS spry_schema_info_view AS
SELECT
  'main'                           AS schema_name,
  v.key                            AS view_name,
  json_extract(v.value,'$.type')   AS type,
  json_extract(v.value,'$.sql')    AS definition_sql
FROM sqlpage_files AS s,
     json_each(s.contents, '$.views') AS v
WHERE s.path = 'spry/lib/info-schema.json';

-- View columns (if your schema_graph_json includes a $.views[*].columns array)
DROP VIEW IF EXISTS spry_schema_info_view_column;
CREATE VIEW IF NOT EXISTS spry_schema_info_view_column AS
SELECT
  'main'                          AS schema_name,
  v.key                           AS view_name,
  json_extract(vc.value,'$.cid')  AS cid,
  json_extract(vc.value,'$.name') AS column_name,
  json_extract(vc.value,'$.type') AS column_type,
  json_extract(vc.value,'$.notnull') AS not_null,
  json_extract(vc.value,'$.dflt_value') AS dflt_value
FROM sqlpage_files AS s,
     json_each(s.contents, '$.views') AS v
LEFT JOIN json_each(v.value, '$.columns') AS vc ON 1=1
WHERE s.path = 'spry/lib/info-schema.json';

-- Indexes (one row per index per table)
DROP VIEW IF EXISTS spry_schema_info_index;
CREATE VIEW IF NOT EXISTS spry_schema_info_index AS
SELECT
  'main'                                       AS schema_name,
  t.key                                        AS table_name,
  json_extract(i.value,'$.name')               AS index_name,
  json_extract(i.value,'$.origin')             AS origin,      -- 'c','u','pk'
  json_extract(i.value,'$.unique')             AS is_unique,
  json_extract(i.value,'$.partial')            AS is_partial,
  json_extract(i.value,'$.where')              AS definition_sql
FROM sqlpage_files AS s,
     json_each(s.contents, '$.tables')         AS t,
     json_each(t.value, '$.indexes')           AS i
WHERE s.path = 'spry/lib/info-schema.json';

-- Index columns (one row per column per index)
DROP VIEW IF EXISTS spry_schema_info_index_column;
CREATE VIEW IF NOT EXISTS spry_schema_info_index_column AS
SELECT
  'main'                                        AS schema_name,
  t.key                                         AS table_name,
  json_extract(i.value,'$.name')                AS index_name,
  json_extract(ic.value,'$.seqno')              AS seqno,
  json_extract(ic.value,'$.cid')                AS cid,
  json_extract(ic.value,'$.name')               AS column_name,
  json_extract(ic.value,'$.desc')               AS is_desc,
  json_extract(ic.value,'$.coll')               AS collation_name,
  json_extract(ic.value,'$.key')                AS is_key_column
FROM sqlpage_files AS s,
     json_each(s.contents, '$.tables')          AS t,
     json_each(t.value, '$.indexes')            AS i,
     json_each(i.value, '$.columns')            AS ic
WHERE s.path = 'spry/lib/info-schema.json';

-- Foreign keys (one row per referencing column)
DROP VIEW IF EXISTS spry_schema_info_foreign_key;
CREATE VIEW IF NOT EXISTS spry_schema_info_foreign_key AS
SELECT
  'main'                                   AS schema_name,
  t.key                                    AS table_name,
  json_extract(fk.value,'$.id')            AS fk_id,
  json_extract(fk.value,'$.seq')           AS seq,
  json_extract(fk.value,'$.from')          AS from_column,
  json_extract(fk.value,'$.to')            AS to_column,
  json_extract(fk.value,'$.table')         AS ref_table,
  json_extract(fk.value,'$.on_update')     AS on_update,
  json_extract(fk.value,'$.on_delete')     AS on_delete,
  json_extract(fk.value,'$.match')         AS match
FROM sqlpage_files AS s,
     json_each(s.contents, '$.tables')     AS t,
     json_each(t.value, '$.foreign_keys')  AS fk
WHERE s.path = 'spry/lib/info-schema.json';

-- Table triggers (one row per trigger per table)
DROP VIEW IF EXISTS spry_schema_info_table_trigger;
CREATE VIEW IF NOT EXISTS spry_schema_info_table_trigger AS
SELECT
  'main'                                AS schema_name,
  t.key                                 AS table_name,
  json_extract(tr.value,'$.name')       AS trigger_name,
  json_extract(tr.value,'$.sql')        AS definition_sql
FROM sqlpage_files AS s,
     json_each(s.contents, '$.tables')  AS t,
     json_each(t.value, '$.triggers')   AS tr
WHERE s.path = 'spry/lib/info-schema.json';

-- Top-level triggers (if captured under $.triggers object)
DROP VIEW IF EXISTS spry_schema_info_trigger;
CREATE VIEW IF NOT EXISTS spry_schema_info_trigger AS
SELECT
  'main'                                AS schema_name,
  trg.key                               AS trigger_name,
  json_extract(trg.value,'$.table')     AS table_name,
  json_extract(trg.value,'$.sql')       AS definition_sql
FROM sqlpage_files AS s,
     json_each(s.contents, '$.triggers') AS trg
WHERE s.path = 'spry/lib/info-schema.json';

-- Relations derived in schema_graph_json (one row per relation)
DROP VIEW IF EXISTS spry_schema_info_relation;
CREATE VIEW IF NOT EXISTS spry_schema_info_relation AS
SELECT
  'main'                                  AS schema_name,
  json_extract(r.value,'$.name')          AS relation_name,
  json_extract(r.value,'$.from_table')    AS from_table,
  json_extract(r.value,'$.to_table')      AS to_table,
  json_extract(r.value,'$.type')          AS relation_type,
  json_extract(r.value,'$.on_update')     AS on_update,
  json_extract(r.value,'$.on_delete')     AS on_delete,
  json_extract(r.value,'$.match')         AS match,
  json_extract(r.value,'$.from_columns')  AS from_columns_json,
  json_extract(r.value,'$.to_columns')    AS to_columns_json
FROM sqlpage_files AS s,
     json_each(s.contents, '$.relations') AS r
WHERE s.path = 'spry/lib/info-schema.json';
