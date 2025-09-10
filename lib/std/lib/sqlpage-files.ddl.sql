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
      - annotations   → JSON metadata for navigation, captions, namespaces, etc.

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
              "namespace": "spry",
              "parentPath": "/spry/console/index.sql",
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
  "annotations" TEXT CHECK (json_valid("annotations") OR NULL)
);

/*------------------------------------------------------------------------------
View: spry_route
Purpose:
  Normalize navigation metadata embedded in sqlpage_files.annotations (JSON)
  into a relational shape that Spry can query directly for menus, breadcrumbs,
  and trees.

Source:
  sqlpage_files (
    path TEXT PRIMARY KEY,
    contents TEXT,
    last_modified TIMESTAMPTZ,
    nature TEXT,
    annotations TEXT  -- JSON
  )

Row eligibility:
  - annotations IS NOT NULL
  - annotations is valid JSON
  - annotations has a "route" object (json_type(..., '$.route') = 'object')

Column mapping:
  - path                  := json_extract(annotations, '$.route.path')
  - caption               := json_extract(annotations, '$.route.caption')
  - namespace             := json_extract(annotations, '$.route.namespace')
  - parent_path           := json_extract(annotations, '$.route.parentPath')
  - sibling_order         := CAST(json_extract(annotations, '$.route.siblingOrder') AS INTEGER)
  - url                   := COALESCE($.route.url, $.route.path)
  - title                 := COALESCE($.route.title, $.route.caption)
  - abbreviated_caption   := COALESCE($.route.abbreviatedCaption, $.route.caption)
  - description           := json_extract(annotations, '$.route.description')
  - elaboration           := json_extract(annotations, '$.route.elaboration')

Notes & semantics:
  - Keys use the camelCase names shown above to match the JSON schema
    (e.g., parentPath, siblingOrder, abbreviatedCaption).
  - The view supplies sensible fallbacks:
      url → path, title → caption, abbreviated_caption → caption.
    Other fields (e.g., caption) will be NULL if absent in JSON; a view
    cannot enforce NOT NULL/UNIQUE constraints from your illustrative table.
  - Intended uniqueness is (namespace, parent_path, path); enforce via app logic
    or triggers if you materialize into a table.

Common queries:
  -- Children of a given parent (ordered)
  SELECT *
  FROM spry_route
  WHERE namespace = 'spry'
    AND parent_path = '/spry/console/index.sql'
  ORDER BY sibling_order, caption;

  -- Root nodes (no parent)
  SELECT *
  FROM spry_route
  WHERE namespace = 'spry'
    AND (parent_path IS NULL OR parent_path = '')
  ORDER BY sibling_order, caption;
------------------------------------------------------------------------------*/

-- Expression indexes to speed up filtering without materializing:
CREATE INDEX IF NOT EXISTS idx_sf_route_ns
  ON sqlpage_files (json_extract(annotations, '$.route.namespace'));
CREATE INDEX IF NOT EXISTS idx_sf_route_parent
  ON sqlpage_files (json_extract(annotations, '$.route.parentPath'));
CREATE INDEX IF NOT EXISTS idx_sf_route_path
  ON sqlpage_files (json_extract(annotations, '$.route.path'));

DROP VIEW IF EXISTS spry_route;
CREATE VIEW IF NOT EXISTS spry_route AS
SELECT
  json_extract(annotations, '$.route.path')                          AS path,
  json_extract(annotations, '$.route.caption')                       AS caption,
  json_extract(annotations, '$.route.namespace')                     AS namespace,
  json_extract(annotations, '$.route.parentPath')                    AS parent_path,
  CAST(json_extract(annotations, '$.route.siblingOrder') AS INTEGER) AS sibling_order,
  COALESCE(
    json_extract(annotations, '$.route.url'),
    json_extract(annotations, '$.route.path')
  )                                                                  AS url,
  COALESCE(
    json_extract(annotations, '$.route.title'),
    json_extract(annotations, '$.route.caption')
  )                                                                  AS title,
  COALESCE(
    json_extract(annotations, '$.route.abbreviatedCaption'),
    json_extract(annotations, '$.route.caption')
  )                                                                  AS abbreviated_caption,
  json_extract(annotations, '$.route.description')                   AS description,
  json_extract(annotations, '$.route.elaboration')                   AS elaboration
FROM sqlpage_files
WHERE annotations IS NOT NULL
  AND json_valid(annotations)
  AND json_type(annotations, '$.route') = 'object';
