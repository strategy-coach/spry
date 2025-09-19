-- @spry.nature sql @spry.sqlImpact ddl

-- See https://github.com/sqlpage/SQLPage#hosting-sql-files-directly-inside-the-database
-- TODO: generate this using Drizzle Kit

/*------------------------------------------------------------------------------
Table: sqlpage_files

What it stores
  One row per “file” that SQLPage/Spry can read:
    • SQL pages / partials (as text)
    • JSON control files (routes, breadcrumbs, entries, etc.)

Why it exists
  Keeps runtime-ready artifacts inside the DB so routing, nav, and content can be
  queried and transformed with SQL.

How it’s used
  • SQLPage: maps path → contents to render pages.
  • Spry: reads JSON files under spry.d/* for routes/breadcrumbs/entries, etc.

Columns
  path          PK “filename” (e.g. spry/console/index.sql.auto.json)
  contents      The raw text/JSON for the file
  last_modified For cache-invalidation and “pick newest” semantics
------------------------------------------------------------------------------*/
CREATE TABLE IF NOT EXISTS "sqlpage_files" (
  "path" VARCHAR PRIMARY KEY NOT NULL,
  "contents" TEXT NOT NULL,
  "last_modified" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Helpful general index for recency-based joins/filters and debugging
CREATE INDEX IF NOT EXISTS idx_sqlpage_files_last_modified
  ON sqlpage_files (last_modified);

-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- View: spry_annotation
-- Purpose:
--   Flatten annotations from `.source` objects found in:
--     - spry.d/route/**/*.auto.json   (path = $.path)
--     - spry.d/entry/**/*.auto.json   (path = $.webPath)
--   One row per annotation key (e.g., "title", "caption", "description").
--
-- Columns:
--   path        TEXT   -- logical path for the resource (route.path or entry.webPath)
--   namespace   TEXT   -- 'route' | 'entry'
--   annotation  TEXT   -- the key inside `.source` (e.g., 'title')
--   id          TEXT   -- $.id inside the annotation object
--   key         TEXT   -- $.key (e.g., 'route.title')
--   kind        TEXT   -- $.kind (e.g., 'tag')
--   value       TEXT   -- $.value (human string)
--   raw         TEXT   -- $.raw (original tag text)
--   source      JSON   -- $.source (raw JSON with languageId, loc, etc.)
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS spry_annotation;
CREATE VIEW spry_annotation AS
WITH route_files AS (
  SELECT
    contents,
    contents ->> '$.path' AS path
  FROM sqlpage_files
  WHERE path GLOB 'spry.d/route/**/*.auto.json'
    AND json_valid(contents)
    AND json_type(contents, '$.path') = 'text'
    AND json_type(contents, '$.".source"') = 'object'
),
entry_files AS (
  SELECT
    contents,
    contents ->> '$.webPath' AS path
  FROM sqlpage_files
  WHERE path GLOB 'spry.d/entry/**/*.auto.json'
    AND json_valid(contents)
    AND json_type(contents, '$.webPath') = 'text'
    AND json_type(contents, '$.".source"') = 'object'
),
route_ann AS (
  SELECT
    rf.path                         AS path,
    'route'                         AS namespace,
    a.key                           AS annotation,
    a.value ->> '$.id'              AS id,
    a.value ->> '$.key'             AS key,
    a.value ->> '$.kind'            AS kind,
    a.value ->> '$.value'           AS value,
    a.value ->> '$.raw'             AS raw,
    a.value ->  '$.source'          AS source
  FROM route_files rf,
       json_each(rf.contents, '$.".source"') AS a
),
entry_ann AS (
  SELECT
    ef.path                         AS path,
    'entry'                         AS namespace,
    a.key                           AS annotation,
    a.value ->> '$.id'              AS id,
    a.value ->> '$.key'             AS key,
    a.value ->> '$.kind'            AS kind,
    a.value ->> '$.value'           AS value,
    a.value ->> '$.raw'             AS raw,
    a.value ->  '$.source'          AS source
  FROM entry_files ef,
       json_each(ef.contents, '$.".source"') AS a
)
SELECT * FROM route_ann
UNION ALL
SELECT * FROM entry_ann;

CREATE INDEX IF NOT EXISTS idx_route_source_json
  ON sqlpage_files (json_extract(contents, '$.".source"'))
  WHERE path GLOB 'spry.d/route/**/*.auto.json' AND json_valid(contents);

CREATE INDEX IF NOT EXISTS idx_entry_source_json
  ON sqlpage_files (json_extract(contents, '$.".source"'))
  WHERE path GLOB 'spry.d/entry/**/*.auto.json' AND json_valid(contents);

CREATE INDEX IF NOT EXISTS idx_route_path
  ON sqlpage_files (contents ->> '$.path')
  WHERE path GLOB 'spry.d/route/**/*.auto.json';

CREATE INDEX IF NOT EXISTS idx_entry_webpath
  ON sqlpage_files (contents ->> '$.webPath')
  WHERE path GLOB 'spry.d/entry/**/*.auto.json';

/*------------------------------------------------------------------------------
View: spry_route

Purpose
  Projects one row per route from files under spry.d/route/**\/*.auto.json.

Shape (selected)
  path, title, caption, url, description, elaboration, plus provenance:
  spf_path (source file path), spf_last_modified.

Notes
  • Expects each file’s contents to be a JSON object with the route fields.
  • Filtered indexes below speed up discovery and path lookups.
------------------------------------------------------------------------------*/
DROP VIEW IF EXISTS spry_route;
CREATE VIEW spry_route AS
WITH f AS (
  SELECT
    path          AS spf_path,
    last_modified AS spf_last_modified,
    contents
  FROM sqlpage_files
  WHERE path GLOB 'spry.d/route/**/*.auto.json'
    AND json_valid(contents)
)
SELECT
  contents ->> '$.path'                AS "path",
  contents ->> '$.pathBasename'        AS "path_basename",
  contents ->> '$.pathBasenameNoExtn'  AS "path_basename_no_extn",
  contents ->> '$.pathDirname'         AS "path_dirname",
  contents ->> '$.pathExtnTerminal'    AS "path_extn_terminal",
  contents ->  '$.pathExtns'           AS "path_extns",

  contents ->> '$.caption'             AS "caption",
  contents ->> '$.siblingOrder'        AS "sibling_order",
  contents ->> '$.url'                 AS "url",
  contents ->> '$.title'               AS "title",
  contents ->> '$.abbreviatedCaption'  AS "abbreviated_caption",
  contents ->> '$.description'         AS "description",
  contents ->  '$.elaboration'         AS "elaboration",

  spf_path,
  spf_last_modified
FROM f
WHERE json_type(contents, '$.path') = 'text';

-- fast lookups by route path
CREATE INDEX IF NOT EXISTS idx_route_json_path_flat
  ON sqlpage_files (contents ->> '$.path')
  WHERE path GLOB 'spry.d/route/**/*.auto.json';

-- help queries that scan JSON content
CREATE INDEX IF NOT EXISTS idx_route_json_scan
  ON sqlpage_files (json(contents))  -- or (contents -> '$') if you prefer
  WHERE path GLOB 'spry.d/route/**/*.auto.json';

/*------------------------------------------------------------------------------
View: spry_route_crumb

Purpose
  Emits one row per breadcrumb “crumb” from files under
  spry.d/breadcrumbs/**\/*.auto.json (each file is an array of objects).

Shape (selected)
  path (derived from filename), crumb_index, href_* (canonical/index/trailingSlash),
  node_* (virtual/basename/path), plus source provenance.

Notes
  • Does not traverse children/payloads; reads only top-level keys of each array item.
  • Filtered indexes below speed up discovery and JSON scans.
------------------------------------------------------------------------------*/
DROP VIEW IF EXISTS spry_route_crumb;
CREATE VIEW spry_route_crumb AS
WITH files AS (
  SELECT
    f.path          AS src_path,
    f.last_modified AS src_last_modified,
    f.contents,
    -- filename-derived logical path (strip prefix/suffix)
    substr(
      f.path,
      length('spry.d/breadcrumbs/') + 1,
      length(f.path) - length('spry.d/breadcrumbs/') - length('.auto.json')
    ) AS rel_path
  FROM sqlpage_files AS f
  WHERE f.path GLOB 'spry.d/breadcrumbs/**/*.auto.json'
    AND json_valid(f.contents)
),
-- One row per crumb (array element)
raw AS (
  SELECT
    files.src_path,
    files.src_last_modified,
    files.rel_path,                     -- qualified to avoid json_each.path name
    CAST(c.key AS INTEGER) AS crumb_index,
    c.value                AS crumb
  FROM files
  JOIN json_each(files.contents) AS c
)
SELECT
  -- logical path derived from the filename
  rel_path AS path,
  crumb_index,

  -- hrefs.* (top-level)
  crumb ->> '$.hrefs.canonical'     AS href_canonical,
  crumb ->> '$.hrefs.index'         AS href_index,
  crumb ->> '$.hrefs.trailingSlash' AS href_trailing_slash,

  -- node.* (top-level)
  crumb ->> '$.node.virtual'  AS node_virtual,
  crumb ->> '$.node.basename' AS node_basename,
  crumb ->> '$.node.path'     AS node_path,

  -- provenance
  src_path            AS breadcrumbs_source_path,
  src_last_modified   AS breadcrumbs_source_last_modified
FROM raw
WHERE json_type(crumb, '$.node.path') = 'text'
ORDER BY src_path, crumb_index;

-- Breadcrumb discovery + JSON scan accelerators
CREATE INDEX IF NOT EXISTS idx_breadcrumbs_dir
  ON sqlpage_files (path)
  WHERE path GLOB 'spry.d/breadcrumbs/**/*.auto.json';

CREATE INDEX IF NOT EXISTS idx_breadcrumbs_json
  ON sqlpage_files (json_extract(contents))
  WHERE path GLOB 'spry.d/breadcrumbs/**/*.auto.json';

-- ---------------------------------------------------------------------------
-- View: spry_route_edge
-- Purpose: Flatten prebuilt edges (parent → child) into rows, newest-wins.
-- Inputs:  sqlpage_files where path GLOB 'spry.d/route/*edges*.auto.json'
-- Columns: parent, child, edges_source_path, edges_source_last_modified
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS spry_route_edge;
CREATE VIEW spry_route_edge AS
WITH files AS (
  SELECT
    f.path          AS src_path,
    f.last_modified AS src_last_modified,
    f.contents
  FROM sqlpage_files AS f
  WHERE f.path GLOB 'spry.d/route/*edges*.auto.json'
    AND json_valid(f.contents)
),
edges_raw AS (
  SELECT
    src_path,
    src_last_modified,
    json_extract(e.value, '$.parent') AS parent,
    json_extract(e.value, '$.child')  AS child
  FROM files, json_each(files.contents) AS e
  WHERE json_type(e.value, '$.parent') = 'text'
    AND json_type(e.value, '$.child')  = 'text'
),
ranked AS (
  SELECT
    parent,
    child,
    src_path,
    src_last_modified,
    ROW_NUMBER() OVER (
      PARTITION BY parent, child
      ORDER BY src_last_modified DESC, src_path DESC
    ) AS rn
  FROM edges_raw
)
SELECT
  parent,
  child,
  src_path          AS edges_source_path,
  src_last_modified AS edges_source_last_modified
FROM ranked
WHERE rn = 1;

-- Edges discovery + JSON scan accelerators on base table
CREATE INDEX IF NOT EXISTS idx_route_edges_dir
  ON sqlpage_files (path)
  WHERE path GLOB 'spry.d/route/*edges*.auto.json';

CREATE INDEX IF NOT EXISTS idx_route_edges_json
  ON sqlpage_files (json_extract(contents))
  WHERE path GLOB 'spry.d/route/*edges*.auto.json';

-- ---------------------------------------------------------------------------
-- View: spry_route_child
-- Purpose: Join edges to spry_route for child metadata.
-- Outputs: parent, child, c.* (all columns from spry_route for the child),
--          edges_source_path, edges_source_last_modified
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS spry_route_child;
CREATE VIEW spry_route_child AS
SELECT
  e.parent,
  c.*,
  e.edges_source_path,
  e.edges_source_last_modified
FROM spry_route_edge AS e
JOIN spry_route     AS c
  ON c."path" = e.child
ORDER BY e.parent, c."path";

-- Speed extraction of the raw ".source" annotations in entry files
CREATE INDEX IF NOT EXISTS idx_entry_source_json
  ON sqlpage_files (json_extract(contents, '$.".source"'))
  WHERE path GLOB 'spry.d/entry/**/*.auto.json'
    AND json_valid(contents);

-- Speed extraction of the raw ".source" annotations in route files
CREATE INDEX IF NOT EXISTS idx_route_source_json
  ON sqlpage_files (json_extract(contents, '$.".source"'))
  WHERE path GLOB 'spry.d/route/**/*.auto.json'
    AND json_valid(contents);

-- ---------------------------------------------------------------------------
-- View: spry_entry
-- Purpose: Surface entry metadata + annotations for files under spry.d/entry/**
-- Columns:
--   path           ← contents.webPath
--   nature         ← contents.nature
--   rel_fs_path    ← contents.relFsPath
--   entry_source_path, entry_source_last_modified (provenance)
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS spry_entry;
CREATE VIEW spry_entry AS
WITH files AS (
  SELECT
    f.path          AS src_path,
    f.last_modified AS src_last_modified,
    f.contents
  FROM sqlpage_files AS f
  WHERE f.path GLOB 'spry.d/entry/**/*.auto.json'
    AND json_valid(f.contents)
)
SELECT
  files.contents ->> '$.webPath'   AS path,
  files.contents ->> '$.nature'    AS nature,
  files.contents ->> '$.relFsPath' AS rel_fs_path,
  files.src_path            AS entry_source_path,
  files.src_last_modified   AS entry_source_last_modified
FROM files
WHERE json_type(files.contents, '$.webPath') = 'text';

-- Fast lookups by relFsPath
CREATE INDEX IF NOT EXISTS idx_entry_relfs
  ON sqlpage_files (json_extract(contents, '$.webPath'))
  WHERE path GLOB 'spry.d/entry/**/*.auto.json';
