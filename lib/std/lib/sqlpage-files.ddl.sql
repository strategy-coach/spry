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

-- should match `contents.ts` SpryRouteAnnotation shape
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
SELECT
  -- the path of the active/linked page inside each breadcrumb payload
  p.value ->> '$.path'        AS active_path,
  -- index within the breadcrumbs array for a given page
  CAST(c.key AS INTEGER)      AS crumb_index,
  -- bring every column from spry_route for that active path
  s.*
FROM sqlpage_files AS f,
     json_each(f.contents, '$.breadcrumbs') AS b,   -- each page -> breadcrumbs array
     json_each(b.value)                     AS c,   -- each breadcrumb in the array
     json_each(c.value, '$.payloads')       AS p    -- each payload in breadcrumb.payloads
JOIN spry_route AS s
  ON s."path" = (p.value ->> '$.path')
WHERE f.path = 'spry/lib/routes.auto.json';

CREATE INDEX IF NOT EXISTS idx_spry_route_crumbs
  ON sqlpage_files (json_extract(contents, '$.breadcrumbs'))
  WHERE path = 'spry/lib/routes.auto.json';

-- Here’s a single view, **`spry_route_child`**, that lists every child route for every parent in your `contents` JSON. It includes:

-- * `parent_path` – the node’s own path (e.g. `/spry/console`)
-- * `parent_path_ts` – **trailing-slash** version of the parent path (e.g. `/spry/console/`)
-- * `parent_path_index` – **index.sql** version of the parent path (e.g. `/spry/console/index.sql`)
-- * `sr.*` – all columns from `spry_route` for each **child payload** (so you get full route details for children)

-- This view scans the canonical routes JSON row at `sqlpage_files.path = 'spry/lib/routes.auto.json'`. Adjust that path if your file is elsewhere.

DROP VIEW IF EXISTS spry_route_child;
CREATE VIEW spry_route_child AS
WITH
-- 0) Pick the routes JSON safely (adjust the path if needed)
routes_doc AS (
  SELECT f.contents
  FROM sqlpage_files AS f
  WHERE f.path = 'spry/lib/routes.auto.json'
    AND json_valid(f.contents)
    AND json_type(f.contents, '$.roots') = 'array'
),
-- 1) Roots from the validated document
roots AS (
  SELECT r.value AS node
  FROM routes_doc d,
       json_each(d.contents, '$.roots') AS r
),
-- 2) Flatten the whole tree
all_nodes AS (
  SELECT node FROM roots
  UNION ALL
  SELECT c.value
  FROM all_nodes a,
       json_each(a.node, '$.children') AS c
),
-- 3) Parent → direct child pairs
parent_child AS (
  SELECT a.node AS parent, c.value AS child
  FROM all_nodes a,
       json_each(a.node, '$.children') AS c
),
-- 4) Expand each child to its payloads (only children that actually have payloads)
child_payloads AS (
  SELECT
    pc.parent,
    pc.child,
    p.value AS payload
  FROM parent_child AS pc,
       json_each(pc.child, '$.payloads') AS p
)
SELECT
  -- parent path
  pc.parent ->> '$.path' AS parent_path,

  -- parent_path_ts: trailing-slash form
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

  -- parent_path_index: index.sql form
  CASE
    WHEN (pc.parent ->> '$.path') LIKE '%/'    THEN (pc.parent ->> '$.path') || 'index.sql'
    WHEN (pc.parent ->> '$.path') LIKE '%.sql' THEN (pc.parent ->> '$.path')
    ELSE (pc.parent ->> '$.path') || '/index.sql'
  END AS parent_path_index,

  -- child route details
  sr.*
FROM child_payloads cp
JOIN parent_child pc
  ON pc.parent = cp.parent AND pc.child = cp.child
LEFT JOIN spry_route AS sr
  ON sr."path" = (cp.payload ->> '$.path')
ORDER BY parent_path, sr."path";

-- Fast access to the routes document (partial index)
CREATE INDEX IF NOT EXISTS idx_routes_roots
  ON sqlpage_files (json_extract(contents, '$.roots'))
  WHERE path = 'spry/lib/routes.auto.json' AND json_valid(contents);

