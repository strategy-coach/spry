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

-- Expression indexes to speed up filtering without materializing:
CREATE INDEX IF NOT EXISTS idx_spry_route_root
  ON sqlpage_files (json_extract(contents, '$.roots'))
  WHERE path = 'spry/lib/routes.json';
CREATE INDEX IF NOT EXISTS idx_spry_route_path_node
  ON sqlpage_files (json_extract(contents, '$.paths'))
  WHERE path = 'spry/lib/routes.json';
CREATE INDEX IF NOT EXISTS idx_spry_route_path_crumbs
  ON sqlpage_files (json_extract(contents, '$.breadcrumbs'))
  WHERE path = 'spry/lib/routes.json';

-- Full JSON route trees grouped by root
DROP VIEW IF EXISTS spry_route_root;
CREATE VIEW spry_route_root AS
SELECT
  json_extract(r.value, '$.path') AS root,
  r.value                         AS nodes
FROM sqlpage_files f,
     json_each(f.contents, '$.roots') AS r
WHERE f.path = 'spry/lib/routes.json';

-- single node by exact path (lookup via the "paths" object)
DROP VIEW IF EXISTS spry_route_path_node;
CREATE VIEW spry_route_path_node AS
SELECT
  p.key   AS path,
  p.value AS node
FROM sqlpage_files f,
     json_each(f.contents, '$.paths') AS p
WHERE f.path = 'spry/lib/routes.json';

DROP VIEW IF EXISTS spry_route_path;
CREATE VIEW spry_route_path AS
SELECT
  p.key                             AS parent_path,          -- parent path
  -- payload-derived convenience columns
  json_extract(pl.value, '$.path')                 AS path,
  json_extract(pl.value, '$.caption')              AS caption,
  json_extract(pl.value, '$.title')                AS title,
  json_extract(pl.value, '$.description')          AS description,
  json_extract(pl.value, '$.abbreviatedCaption')   AS abbreviated_caption,
  json_extract(pl.value, '$.url')                  AS url,
  CAST(json_extract(pl.value, '$.siblingOrder') AS INTEGER) AS sibling_order,
  -- utility columns
  CAST(ch.key AS INTEGER)           AS child_index,          -- index within parent.children
  ch.value                          AS child_node,           -- whole child node JSON
  CAST(pl.key AS INTEGER)           AS child_payload_index,  -- index within child.payloads (NULL if none)
  pl.value                          AS child_payload         -- payload JSON (NULL if none)
FROM sqlpage_files AS f,
     json_each(f.contents, '$.paths')     AS p,    -- parent nodes
     json_each(p.value, '$.children')     AS ch    -- child nodes
LEFT JOIN json_each(ch.value, '$.payloads') AS pl  -- payloads (if any)
       ON 1
WHERE f.path = 'spry/lib/routes.json'
  AND COALESCE(json_extract(ch.value, '$.virtual'), 0) = 0;

-- breadcrumbs by path (lookup via the "breadcrumbs" object)
DROP VIEW IF EXISTS spry_route_path_crumbs;
CREATE VIEW spry_route_path_crumbs AS
SELECT
  b.key   AS path,
  b.value AS breadcrumbs
FROM sqlpage_files f,
     json_each(f.contents, '$.breadcrumbs') AS b
WHERE f.path = 'spry/lib/routes.json';

-- Flattened breadcrumbs payloads by path
DROP VIEW IF EXISTS spry_route_path_crumbs_node;
CREATE VIEW spry_route_path_crumbs_node AS
SELECT
  b.key                              AS path,           -- "/some/path"
  CAST(c.key AS INTEGER)             AS crumb_index,    -- index within breadcrumbs array
  CAST(p.key AS INTEGER)             AS payload_index,  -- index within breadcrumb.payloads
  p.value                            AS payload         -- the payload object JSON
FROM sqlpage_files AS f,
     json_each(f.contents, '$.breadcrumbs') AS b       -- each path -> breadcrumbs array
     , json_each(b.value)                   AS c       -- each breadcrumb in the array
     , json_each(c.value, '$.payloads')     AS p       -- each payload in breadcrumb.payloads
WHERE f.path = 'spry/lib/routes.json';
