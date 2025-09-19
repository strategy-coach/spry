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
WITH files AS (
  SELECT
    f.path          AS src_path,
    f.last_modified AS src_last_modified,
    f.contents
  FROM sqlpage_files AS f
  WHERE f.path GLOB 'spry.d/route/**/*.auto.json'
    AND json_valid(f.contents)
),
norm AS (
  SELECT
    src_path,
    src_last_modified,
    contents AS r
  FROM files
)
SELECT
  r ->> '$.path'               AS "path",
  r ->> '$.pathBasename'       AS "path_basename",
  r ->> '$.pathBasenameNoExtn' AS "path_basename_no_extn",
  r ->> '$.pathDirname'        AS "path_dirname",
  r ->> '$.pathExtnTerminal'   AS "path_extn_terminal",
  r ->> '$.pathExtns'          AS "path_extns",

  r ->> '$.caption'            AS "caption",
  r ->> '$.siblingOrder'       AS "sibling_order",
  r ->> '$.url'                AS "url",
  r ->> '$.title'              AS "title",
  r ->> '$.abbreviatedCaption' AS "abbreviated_caption",
  r ->> '$.description'        AS "description",
  r ->  '$.elaboration'        AS "elaboration",

  -- provenance
  src_path          AS spf_path,
  src_last_modified AS spf_last_modified
FROM norm
WHERE json_type(r, '$.path') = 'text';

-- Route discovery + JSON-path lookup accelerators
CREATE INDEX IF NOT EXISTS idx_route_dir
  ON sqlpage_files (path)
  WHERE path GLOB 'spry.d/route/**/*.auto.json';

CREATE INDEX IF NOT EXISTS idx_route_json_path_flat
  ON sqlpage_files (json_extract(contents, '$.path'))
  WHERE path GLOB 'spry.d/route/**/*.auto.json';

-- ---------------------------------------------------------------------------

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
