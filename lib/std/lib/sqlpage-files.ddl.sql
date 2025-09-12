-- @spry.nature sql @spry.sqlImpact ddl

-- See https://github.com/sqlpage/SQLPage#hosting-sql-files-directly-inside-the-database
-- TODO: generate this using Drizzle Kit

/*------------------------------------------------------------------------------
Table: sqlpage_files

Purpose:
  Stores SQL-based page definitions and related metadata for both SQLPage
  and Spry. This is the canonical source of truth for all SQL-driven pages,
  partials, and components.

  TODO: consider generating sqlpage_files using Drizzle ORM?

Usage:
  • SQLPage uses:
      - path          → maps files to URLs
      - contents      → SQL code executed to render the page
      - last_modified → detects when pages change for caching or live reload
  • Spry uses:
      - nature        → classifies file type (e.g. 'page', 'partial', 'component')
      - annotations   → JSON metadata for navigation, captions, etc.
      - elaboration   → JSON custom data field for anything that's useful

Columns:
  path            VARCHAR  PRIMARY KEY, NOT NULL
      • Unique identifier for the file (usually relative path).
      • Used by SQLPage to map routes.
  contents        TEXT, NOT NULL
      • Stores the raw SQL code for rendering the page.
  last_modified   TIMESTAMPTZ, DEFAULT CURRENT_TIMESTAMP
      • Auto-updated when inserted; can be used for cache invalidation.
  nature          TEXT, NOT NULL, DEFAULT 'page'
      • Categorizes the file’s role in the app:
          'page'      → regular page
          'partial'   → reusable snippet
          'component' → custom UI element
          'data'      → data provider
  annotations     TEXT, JSON (nullable)
      • Optional metadata for Spry in JSON format.
      • Must be either NULL or valid JSON (enforced by CHECK constraint).
      • Typical structure:
          {
            "isRouteAnnotated": true,
            "route": {
              "path": "/spry/console/info-schema/index.sql",
              "caption": "Spry Schema",
              "title": "Spry BaaS Info Schema"
            }
          }

Notes:
  • All SQLPage pages and components are stored here, enabling dynamic routing.
  • Spry builds navigation trees, breadcrumbs, and titles based on annotations.
  • Combine with views like `spry_route` to expose structured navigation data.
------------------------------------------------------------------------------*/
CREATE TABLE IF NOT EXISTS "sqlpage_files" (
  "path" VARCHAR PRIMARY KEY NOT NULL,
  "contents" TEXT NOT NULL,
  "last_modified" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

  -- path, contents, and lastModified are used by SQLPage
  -- the remainder of the fields below are for Spry

  "nature" TEXT NOT NULL DEFAULT 'page',
  "annotations" TEXT CHECK (json_valid("annotations") OR NULL),
  "elaboration" TEXT CHECK (json_valid("elaboration") OR NULL)
);

-- should match `contents.ts` SpryRouteAnnotation shape;
-- if the same path should be able to arrive from multiple routes then
-- create a common partial liked `partial-content.sql` and then two or
-- more separate *.sql files with different routes that `include` 
-- `partial-content.sql`. 
DROP VIEW IF EXISTS "spry_route";
CREATE VIEW "spry_route" AS
SELECT
  f.path AS spf_path,
  f.last_modified AS spf_last_modified,
  annotations ->> '$.route.path'               AS "path",
  annotations ->> '$.route.pathBasename'       AS "path_basename",
  annotations ->> '$.route.pathBasenameNoExtn' AS "path_basename_no_extn",
  annotations ->> '$.route.pathDirname'        AS "path_dirname",
  annotations ->> '$.route.pathExtnTerminal'   AS "path_extn_terminal",
  annotations ->> '$.route.pathExtns'          AS "path_extns",
  annotations ->> '$.route.caption'            AS "caption",
  annotations ->> '$.route.siblingOrder'       AS "sibling_order",
  annotations ->> '$.route.url'                AS "url",
  annotations ->> '$.route.title'              AS "title",
  annotations ->> '$.route.abbreviatedCaption' AS "abbreviated_caption",
  annotations ->> '$.route.description'        AS "description",
  annotations ->  '$.route.elaboration'        AS "elaboration"
FROM sqlpage_files AS f
WHERE
  annotations IS NOT NULL
  AND json_type(annotations, '$.route') = 'object'
  AND annotations ->> '$.route.path' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_spry_route
  ON sqlpage_files (json_extract(annotations, '$.route'))
  WHERE annotations -> '$.route' IS NOT NULL;

-- Accelerate lookups of route details by path
CREATE INDEX IF NOT EXISTS idx_spry_route_path
  ON sqlpage_files (json_extract(annotations, '$.route.path'))
  WHERE json_type(annotations, '$.route') = 'object';

-- Flattened breadcrumbs, joined to per-route metadata
DROP VIEW IF EXISTS spry_route_crumb;
CREATE VIEW spry_route_crumb AS
WITH files AS (
  SELECT
    f.path         AS src_path,
    f.last_modified AS src_last_modified,
    f.contents
  FROM sqlpage_files AS f
  WHERE f.path GLOB 'spry/lib/route/breadcrumbs.d/*.json'
    AND json_valid(f.contents)
),
raw AS (
  SELECT
    src_path,
    src_last_modified,
    b.key                    AS active_path,     -- top-level map key
    CAST(c.key AS INTEGER)   AS crumb_index,     -- index within breadcrumb array
    c.value                  AS crumb            -- the { node, hrefs } object
  FROM files,
       json_each(contents) AS b,                 -- iterate map: active_path -> array
       json_each(b.value)  AS c                  -- iterate array elements
),
link AS (
  SELECT
    src_path,
    src_last_modified,
    active_path,
    crumb_index,
    CASE
      WHEN json_type(crumb, '$.hrefs.index') = 'text'
        THEN crumb ->> '$.hrefs.index'
      WHEN json_type(crumb, '$.node.payloads[0].path') = 'text'
        THEN crumb ->> '$.node.payloads[0].path'
      WHEN json_type(crumb, '$.hrefs.canonical') = 'text'
           AND (substr(crumb ->> '$.hrefs.canonical', -1) = '/' OR instr(crumb ->> '$.hrefs.canonical', '.') = 0)
        THEN (crumb ->> '$.hrefs.canonical') || 'index.sql'
      ELSE crumb ->> '$.hrefs.canonical'
    END AS join_path
  FROM raw
),
-- If multiple files provide the same crumb, prefer the most recently modified
ranked AS (
  SELECT
    active_path,
    crumb_index,
    join_path,
    src_path,
    src_last_modified,
    ROW_NUMBER() OVER (
      PARTITION BY active_path, crumb_index, join_path
      ORDER BY src_last_modified DESC, src_path DESC
    ) AS rn
  FROM link
)
SELECT
  r.active_path,
  r.crumb_index,
  r.src_path       AS breadcrumbs_source_path,
  r.src_last_modified AS breadcrumbs_source_last_modified,
  s.*
FROM ranked AS r
JOIN spry_route AS s
  ON s."path" = r.join_path
WHERE r.rn = 1;

-- Here’s a single view, **`spry_route_child`**, that lists every child route for every parent in your `contents` JSON. It includes:

-- * `parent_path` – the node’s own path (e.g. `/spry/console`)
-- * `parent_path_ts` – **trailing-slash** version of the parent path (e.g. `/spry/console/`)
-- * `parent_path_index` – **index.sql** version of the parent path (e.g. `/spry/console/index.sql`)
-- * `sr.*` – all columns from `spry_route` for each **child payload** (so you get full route details for children)

-- This view scans the canonical routes JSON row at `sqlpage_files.path = 'spry/lib/routes.auto.json'`. Adjust that path if your file is elsewhere.

DROP VIEW IF EXISTS spry_route_child;

CREATE VIEW spry_route_child AS
WITH
-- All valid forest files: each file is a top-level array of roots
files AS (
  SELECT
    f.path          AS src_path,
    f.last_modified AS src_last_modified,
    f.contents
  FROM sqlpage_files AS f
  WHERE f.path GLOB 'spry/lib/route/forests.d/*.json'
    AND json_valid(f.contents)
),

-- Each array element is a root node
roots AS (
  SELECT
    src_path,
    src_last_modified,
    r.value AS node
  FROM files,
       json_each(contents) AS r
),

-- Flatten trees via children
all_nodes(src_path, src_last_modified, node) AS (
  SELECT src_path, src_last_modified, node
  FROM roots
  UNION ALL
  SELECT an.src_path, an.src_last_modified, c.value
  FROM all_nodes AS an,
       json_each(an.node, '$.children') AS c
),

-- Parent → direct child pairs
parent_child AS (
  SELECT
    an.src_path,
    an.src_last_modified,
    an.node AS parent,
    c.value AS child
  FROM all_nodes AS an,
       json_each(an.node, '$.children') AS c
),

-- Only children that actually have payloads
child_payloads AS (
  SELECT
    pc.src_path,
    pc.src_last_modified,
    pc.parent,
    pc.child,
    p.value AS payload
  FROM parent_child AS pc,
       json_each(pc.child, '$.payloads') AS p
)

SELECT
  -- parent path
  pc.parent ->> '$.path' AS parent_path,

  -- trailing-slash form
  CASE
    WHEN (pc.parent ->> '$.path') LIKE '%/' THEN pc.parent ->> '$.path'
    WHEN lower(pc.parent ->> '$.path') LIKE '%/index.sql'
      THEN substr(pc.parent ->> '$.path', 1, length(pc.parent ->> '$.path') - 10) || '/'
    WHEN (pc.parent ->> '$.path') LIKE '%.sql'
      THEN substr(
             pc.parent ->> '$.path',
             1,
             length(pc.parent ->> '$.path') - length(coalesce(pc.parent ->> '$.basename',''))
           )
    ELSE (pc.parent ->> '$.path') || '/'
  END AS parent_path_ts,

  -- index.sql form
  CASE
    WHEN (pc.parent ->> '$.path') LIKE '%/'    THEN (pc.parent ->> '$.path') || 'index.sql'
    WHEN (pc.parent ->> '$.path') LIKE '%.sql' THEN (pc.parent ->> '$.path')
    ELSE (pc.parent ->> '$.path') || '/index.sql'
  END AS parent_path_index,

  -- provenance
  pc.src_path          AS forest_source_path,
  pc.src_last_modified AS forest_source_last_modified,

  -- child route details (payload path)
  sr.*
FROM child_payloads AS cp
JOIN parent_child  AS pc
  ON pc.src_path = cp.src_path
 AND pc.parent   = cp.parent
 AND pc.child    = cp.child
LEFT JOIN spry_route AS sr
  ON sr."path" = (cp.payload ->> '$.path')
ORDER BY parent_path, sr."path";

CREATE INDEX IF NOT EXISTS idx_route_forests_dir
  ON sqlpage_files (path)
  WHERE path GLOB 'spry/lib/route/forests.d/*.json';

CREATE INDEX IF NOT EXISTS idx_route_forests_json
  ON sqlpage_files (json_extract(contents))
  WHERE path GLOB 'spry/lib/route/forests.d/*.json';

