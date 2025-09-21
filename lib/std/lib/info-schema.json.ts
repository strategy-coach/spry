#!/usr/bin/env -S deno run -A 

// @spry.nature cap-exec @spry.dependsOn db-after-build

import { SqliteAide } from "../../engine/cap-exec/mod.ts";

const SQL = `
.mode list
.separator ""
.headers off
.nullvalue null

WITH
db AS (
  SELECT json_object(
    'sqlite_version', sqlite_version(),
    'database_list', (
      SELECT json_group_array(json_object('seq',seq,'name',name,'file',file))
      FROM pragma_database_list
      ORDER BY seq
    ),
    'encoding',       (SELECT encoding       FROM pragma_encoding),
    'page_size',      (SELECT page_size      FROM pragma_page_size),
    'auto_vacuum',    (SELECT auto_vacuum    FROM pragma_auto_vacuum),
    'journal_mode',   (SELECT journal_mode   FROM pragma_journal_mode),
    'synchronous',    (SELECT synchronous    FROM pragma_synchronous),
    'user_version',   (SELECT user_version   FROM pragma_user_version),
    'application_id', (SELECT application_id FROM pragma_application_id),
    'foreign_keys',   (SELECT foreign_keys   FROM pragma_foreign_keys),
    'schema_version', (SELECT schema_version FROM pragma_schema_version),
    -- environment: collations + compile options (sorted)
    'collations', (
      SELECT json_group_array(json_object('seq',seq,'name',name))
      FROM pragma_collation_list
      ORDER BY lower(name), seq
    ),
    'compile_options', (
      SELECT json_group_array(co)
      FROM (
        SELECT compile_options AS co
        FROM pragma_compile_options
        ORDER BY lower(compile_options)
      )
    )
  ) AS j
),

-- Parse table flags/details from raw DDL (no normalization)
table_flags AS (
  SELECT
    t.name,
    t.sql,
    lower(t.sql) AS lsql,
    CASE WHEN instr(lsql,'create virtual table')>0 THEN 1 ELSE 0 END AS is_virtual,
    -- module after USING
    trim(
      CASE
        WHEN instr(lsql,' using ')>0 THEN
          substr(
            t.sql,
            instr(lsql,' using ')+7,
            CASE
              WHEN instr(substr(lsql, instr(lsql,' using ')+7), '(') > 0
              THEN instr(substr(t.sql, instr(lsql,' using ')+7), '(') - 1
              ELSE length(t.sql)
            END
          )
        ELSE NULL
      END
    ) AS module_raw,
    -- raw "(...)" after USING <module> (best-effort; left verbatim)
    CASE
      WHEN instr(lsql,' using ')>0 AND instr(substr(lsql, instr(lsql,' using ')+7), '(') > 0 THEN
        substr(
          t.sql,
          instr(lsql,' using ')+7 + instr(substr(lsql, instr(lsql,' using ')+7), '('),
          CASE
            WHEN instr(substr(lsql,
                              instr(lsql,' using ')+7
                                + instr(substr(lsql, instr(lsql,' using ')+7), '(')
                             ), ')') > 0
            THEN instr(substr(t.sql,
                              instr(lsql,' using ')+7
                                + instr(substr(lsql, instr(lsql,' using ')+7), '(')
                             ), ')')
            ELSE 0
          END
        )
      ELSE NULL
    END AS module_args_raw,
    CASE WHEN instr(lsql,' without rowid')>0 THEN 1 ELSE 0 END AS without_rowid,
    CASE WHEN instr(lsql,' strict')>0 THEN 1 ELSE 0 END AS strict_flag,
    CASE WHEN instr(lsql,' autoincrement')>0 THEN 1 ELSE 0 END AS has_autoincrement,
    (length(lsql) - length(replace(lsql,'check',''))) / 5 AS check_count
  FROM (
    SELECT m.name, m.sql, lower(m.sql) AS lsql
    FROM sqlite_master AS m
    WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%'
  ) AS t
),

-- Tables block (everything deterministically ordered)
tables AS (
  SELECT json_group_array(
           json_object(
             'name', m.name,
             'createSql', m.sql,
             'rootpage', m.rootpage,

             -- flags
             'isVirtual', tf.is_virtual,
             'module', CASE
               WHEN tf.is_virtual=1 THEN
                 trim(coalesce(substr(tf.module_raw, 1,
                      CASE
                        WHEN instr(tf.module_raw,'(')>0 THEN instr(tf.module_raw,'(')-1
                        WHEN instr(tf.module_raw,' ')>0 THEN instr(tf.module_raw,' ')-1
                        ELSE length(tf.module_raw)
                      END), NULL))
               ELSE NULL
             END,
             'moduleArgsRaw', tf.module_args_raw,
             'withoutRowid', tf.without_rowid,
             'strict', tf.strict_flag,
             'hasAutoincrement', tf.has_autoincrement,
             'rowidTable', CASE WHEN tf.is_virtual=1 THEN NULL
                                WHEN tf.without_rowid=1 THEN 0 ELSE 1 END,
             'hasChecks', CASE WHEN tf.check_count>0 THEN 1 ELSE 0 END,
             'checkCount', tf.check_count,

             -- primary key layout (ordered by pk ordinal)
             'primaryKey', (
               SELECT json_group_array(json_object('pk', pk, 'cid', cid, 'name', name))
               FROM pragma_table_xinfo(m.name)
               WHERE pk > 0
               ORDER BY pk
             ),

             -- columns (ordered by cid; infer generated via DDL presence)
             'columns', (
               SELECT json_group_array(
                        json_object(
                          'cid', cid,
                          'name', name,
                          'type', type,
                          'notnull', "notnull",
                          'dflt_value', "dflt_value",
                          'pk', pk,
                          'hidden', hidden,
                          'generated', CASE
                            WHEN instr(lower(m.sql), lower(' '||name||' generated '))>0
                              OR instr(lower(m.sql), lower(' '||name||' generated always '))>0
                            THEN 1 ELSE 0
                          END
                        )
                      )
               FROM pragma_table_xinfo(m.name)
               ORDER BY cid
             ),

             -- foreign keys (ordered by id,seq)
             'foreignKeys', (
               SELECT json_group_array(
                        json_object(
                          'id', id, 'seq', seq, 'table', "table",
                          'from', "from", 'to', "to",
                          'on_update', on_update, 'on_delete', on_delete, 'match', "match"
                        )
                      )
               FROM pragma_foreign_key_list(m.name)
               ORDER BY id, seq
             ),

             -- indexes (ordered by name)
             'indexes', (
               SELECT json_group_array(
                        json_object(
                          'name', il.name,
                          'rootpage', (SELECT sm.rootpage FROM sqlite_master sm
                                       WHERE sm.type='index' AND sm.name=il.name),
                          'createSql', (SELECT sm.sql FROM sqlite_master sm
                                        WHERE sm.type='index' AND sm.name=il.name),
                          'unique', il."unique",
                          'origin', il.origin,      -- 'c','u','pk'
                          'partial', il.partial,
                          -- raw WHERE predicate (if present) parsed from DDL tail
                          'where', (
                            SELECT CASE
                              WHEN sm.sql IS NULL THEN NULL
                              WHEN instr(lower(sm.sql),' where ')>0
                                   THEN trim(substr(sm.sql, instr(lower(sm.sql),' where ')+7))
                              ELSE NULL
                            END
                            FROM sqlite_master sm
                            WHERE sm.type='index' AND sm.name=il.name
                          ),
                          'columns', (
                            SELECT json_group_array(
                                     json_object('seqno', seqno, 'cid', cid, 'name', name)
                                   )
                            FROM pragma_index_info(il.name)
                            ORDER BY seqno
                          ),
                          'xinfo', (
                            SELECT json_group_array(
                                     json_object(
                                       'seqno', seqno,
                                       'cid', cid,
                                       'name', name,
                                       'desc', ix."desc",
                                       'coll', coll,
                                       'key',  ix."key",
                                       'isExpr', CASE WHEN cid < 0 THEN 1 ELSE 0 END
                                     )
                                   )
                            FROM pragma_index_xinfo(il.name) AS ix
                            ORDER BY seqno
                          )
                        )
                      )
               FROM pragma_index_list(m.name) AS il
               ORDER BY lower(il.name)
             ),

             -- unique constraints (constraint-origin indexes)
             'uniqueConstraints', (
               SELECT json_group_array(
                        json_object(
                          'name', il.name,
                          'columns', (
                            SELECT json_group_array(name)
                            FROM pragma_index_info(il.name)
                            ORDER BY seqno
                          )
                        )
                      )
               FROM pragma_index_list(m.name) AS il
               WHERE il."unique"=1 AND il.origin='c'
               ORDER BY lower(il.name)
             ),

             -- table-scoped triggers (ordered by name)
             'triggers', (
               SELECT json_group_array(
                        json_object(
                          'name', t2.name,
                          'createSql', t2.sql
                        )
                      )
               FROM sqlite_master AS t2
               WHERE t2.type='trigger' AND t2.tbl_name=m.name
               ORDER BY lower(t2.name)
             )
           )
         ) AS j
  FROM sqlite_master AS m
  JOIN table_flags AS tf ON tf.name = m.name
  WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%'
  ORDER BY lower(m.name)
),

-- Views (now include column list and rootpage for symmetry)
views AS (
  SELECT json_group_array(
           json_object(
             'name', v.name,
             'createSql', v.sql,
             'rootpage', v.rootpage,
             'columns', (
               SELECT json_group_array(
                        json_object(
                          'cid', cid,
                          'name', name,
                          'type', type,
                          'notnull', "notnull",
                          'dflt_value', "dflt_value"
                        )
                      )
               FROM pragma_table_xinfo(v.name)
               ORDER BY cid
             )
           )
         ) AS j
  FROM sqlite_master AS v
  WHERE v.type='view'
  ORDER BY lower(v.name)
),

-- All triggers (top-level, ordered)
triggers AS (
  SELECT json_group_array(
           json_object('name', name, 'table', tbl_name, 'createSql', sql)
         ) AS j
  FROM sqlite_master
  WHERE type='trigger'
  ORDER BY lower(name)
)

SELECT json(
  json_object(
    'database', json((SELECT j FROM db)),
    'objects', json_object(
      'tables',   json(COALESCE((SELECT j FROM tables),  '[]')),
      'views',    json(COALESCE((SELECT j FROM views),   '[]')),
      'triggers', json(COALESCE((SELECT j FROM triggers),'[]'))
    )
  )
);`;

await SqliteAide.create()
  .sqlText(SQL)
  .toStdOutJson(true);
