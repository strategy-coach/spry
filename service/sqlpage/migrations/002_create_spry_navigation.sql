-- Drop and create the table for storing navigation entries
-- for testing only: DROP TABLE IF EXISTS spry_navigation;
CREATE TABLE IF NOT EXISTS "spry_navigation" (
    path TEXT NOT NULL, -- the "primary key" within namespace
    caption TEXT NOT NULL, -- for human-friendly general-purpose name
    namespace TEXT NOT NULL, -- if more than one navigation tree is required
    parent_path TEXT, -- for defining hierarchy
    sibling_order INTEGER, -- orders children within their parent(s)
    url TEXT, -- for supplying links, if different from path
    title TEXT, -- for full titles when elaboration is required, default to caption if NULL
    abbreviated_caption TEXT, -- for breadcrumbs and other "short" form, default to caption if NULL
    description TEXT, -- for elaboration or explanation
    elaboration TEXT, -- optional attributes for e.g. { "target": "__blank", "lang": { "fr": { "caption": "hello" } } }
    -- TODO: figure out why Rusqlite does not allow this but sqlite3 does
    -- CONSTRAINT fk_parent_path FOREIGN KEY (namespace, parent_path) REFERENCES spry_navigation(namespace, path),
    CONSTRAINT unq_ns_path UNIQUE (namespace, parent_path, path)
);
DELETE FROM spry_navigation WHERE namespace = 'spry';

-- all @navigation decorated entries are automatically added to this.navigation
INSERT INTO spry_navigation (namespace, parent_path, sibling_order, path, url, caption, abbreviated_caption, title, description, elaboration)
VALUES
('spry', NULL, 1, '/spry/index.sql', NULL, 'Home', NULL, 'Spry BaaS Database', 'Welcome to Spry Backend-as-a-Service (BaaS) Database', NULL),
('spry', '/spry/index.sql', 999, '/spry/console/index.sql', NULL, 'Spry Console', 'Console', 'Spry BaaS Console', 'Explore Spry BaaS Database information schema and and SQLPage files', NULL),
('spry', '/spry/console/index.sql', 1, '/spry/console/info-schema/index.sql', NULL, 'Spry DB Information Schema', 'Info Schema', NULL, 'Explore Spry DB tables, columns, views, and other information schema documentation', NULL),
('spry', '/spry/console/index.sql', 3, '/spry/console/sqlpage-files/index.sql', NULL, 'Spry SQLPage Files', 'SQLPage Files', NULL, 'Explore Spry SQLPage Files which govern the content of the web-UI', NULL),
('spry', '/spry/console/index.sql', 3, '/spry/console/sqlpage-files/content.sql', NULL, 'Spry Data Tables Content SQLPage Files', 'Content SQLPage Files', NULL, 'Explore auto-generated Spry SQLPage Files which display content within tables', NULL),
('spry', '/spry/console/index.sql', 3, '/spry/console/sqlpage-nav/index.sql', NULL, 'Spry SQLPage Navigation', 'SQLPage Navigation', NULL, 'See all the navigation entries for the web-UI; TODO: need to improve this to be able to get details for each navigation entry as a table', NULL)
ON CONFLICT (namespace, parent_path, path)
DO UPDATE SET title = EXCLUDED.title, abbreviated_caption = EXCLUDED.abbreviated_caption, description = EXCLUDED.description, url = EXCLUDED.url, sibling_order = EXCLUDED.sibling_order;
