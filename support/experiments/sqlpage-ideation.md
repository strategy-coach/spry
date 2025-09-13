Awesome—SQLite + a preprocessor is a sweet combo for “SQL-only middleware.” Below are **drop-in patterns** adapted to SQLite (JSON1, FTS5, triggers, CASE-based ORDER BY), and notes on how to exploit your **.sql preprocessor** (for includes/macros). I’ll keep the snippets portable and parameter-driven for `run_sql(...)`.

---

# 1) Request context with temp table (SQLite-safe)

SQLite has no per-session `set_config`, so stash request context in a **temp table** created at the start of each page (one connection per request).

```sql
-- ctx.sql  (run first on each request)
DROP TABLE IF EXISTS temp.ctx;
CREATE TEMP TABLE temp.ctx (
  user_id     INTEGER,
  email       TEXT,
  locale      TEXT,
  roles_json  TEXT,   -- JSON array of roles
  flags_json  TEXT    -- JSON object of feature flags
);

INSERT INTO temp.ctx(user_id, email, locale, roles_json, flags_json)
SELECT u.id, u.email, COALESCE(u.locale, 'en'),
       json_group_array(r.role_name),
       json_object('new_dashboard', uf.new_dashboard, 'beta_feature', uf.beta_feature)
FROM sessions s
JOIN users u ON u.id = s.user_id
LEFT JOIN user_roles r ON r.user_id = u.id
LEFT JOIN user_flags uf ON uf.user_id = u.id
WHERE s.token = :token
GROUP BY u.id;
```

**Use anywhere**:

```sql
WITH ctx AS (SELECT * FROM temp.ctx)
SELECT ctx.user_id, ctx.locale FROM ctx;
```

> Preprocessor tip: make `@include "ctx.sql"` the first line of every page.

---

# 2) Role/flag guards that short-circuit rendering

Return a component row when blocked; otherwise nothing. Compose guards with `UNION ALL`.

```sql
-- guards/require_role.sql
WITH ctx AS (SELECT * FROM temp.ctx)
SELECT 'message' AS component,
       'Access denied' AS title,
       'Admin role required' AS description
WHERE NOT EXISTS (
  SELECT 1 FROM ctx
  WHERE json_type(ctx.roles_json) = 'array'
    AND EXISTS (
      SELECT 1
      FROM json_each(ctx.roles_json)
      WHERE value = 'admin'
    )
);
```

**Pattern to stop page when guard triggers:**

```sql
WITH guard AS (
  SELECT * FROM run_sql('guards/require_role.sql')
),
stop AS (SELECT 1 FROM guard)
SELECT * FROM guard
UNION ALL
SELECT * FROM run_sql('actual_page_content.sql')
WHERE NOT EXISTS (SELECT 1 FROM stop);
```

---

# 3) Table-driven routing (file dispatcher)

```sql
-- routes(path TEXT PRIMARY KEY, sql_file TEXT, min_role TEXT NULL)

-- dispatch.sql
WITH r AS (SELECT * FROM routes WHERE path = :path),
ctx AS (SELECT * FROM temp.ctx),
auth AS (
  SELECT 1
  FROM r, ctx
  WHERE r.min_role IS NULL
     OR EXISTS (
       SELECT 1 FROM json_each(ctx.roles_json) WHERE value = r.min_role
     )
)
SELECT * FROM run_sql((SELECT sql_file FROM r))
WHERE EXISTS (SELECT 1 FROM auth)
UNION ALL
SELECT 'message','Not authorized','Insufficient permissions'
WHERE NOT EXISTS (SELECT 1 FROM auth);
```

---

# 4) Safe sorting & pagination (no dynamic SQL needed)

```sql
-- query_opts.sql
WITH raw AS (
  SELECT
    COALESCE(NULLIF(:sort,''),'created_at') AS sort,
    IIF(:page_size IS NULL OR :page_size < 1, 20, :page_size) AS page_size,
    IIF(:page IS NULL OR :page < 1, 1, :page) AS page
),
san AS (
  SELECT
    CASE sort
      WHEN 'created_at' THEN 'created_at'
      WHEN 'name'       THEN 'name'
      WHEN 'email'      THEN 'email'
      ELSE 'created_at'
    END AS sort_col,
    page_size,
    (page-1)*page_size AS offset_val
  FROM raw
)
SELECT sort_col, page_size, offset_val FROM san;
```

**Use:**

```sql
WITH q AS (SELECT * FROM run_sql('query_opts.sql', json_object('sort', :sort, 'page', :page, 'page_size', :page_size)))
SELECT id, name, email, created_at
FROM users
ORDER BY
  CASE (SELECT sort_col FROM q)
    WHEN 'name' THEN name
    WHEN 'email' THEN email
    ELSE created_at
  END
LIMIT (SELECT page_size FROM q)
OFFSET (SELECT offset_val FROM q);
```

---

# 5) Declarative validation (JSON1 + simple checks)

SQLite lacks native `REGEXP` (unless you added an extension). Prefer presence, length, numeric bounds.

```sql
-- validations(entity TEXT, field TEXT, required INT, min_num REAL, max_num REAL, min_len INT, max_len INT, like TEXT)

-- validate.sql
WITH payload AS (SELECT :payload AS j), rules AS (
  SELECT * FROM validations WHERE entity = :entity
), tests AS (
  SELECT
    field,
    CASE
      WHEN required=1 AND COALESCE(json_extract((SELECT j FROM payload), '$.'||field),'') = '' THEN 'required'
      WHEN min_len IS NOT NULL AND length(COALESCE(json_extract((SELECT j FROM payload), '$.'||field),'')) < min_len THEN 'min_len'
      WHEN max_len IS NOT NULL AND length(COALESCE(json_extract((SELECT j FROM payload), '$.'||field),'')) > max_len THEN 'max_len'
      WHEN min_num IS NOT NULL AND CAST(json_extract((SELECT j FROM payload), '$.'||field) AS REAL) < min_num THEN 'min_num'
      WHEN max_num IS NOT NULL AND CAST(json_extract((SELECT j FROM payload), '$.'||field) AS REAL) > max_num THEN 'max_num'
      WHEN like IS NOT NULL AND COALESCE(json_extract((SELECT j FROM payload), '$.'||field),'') NOT LIKE like THEN 'like'
      ELSE NULL
    END AS reason
  FROM rules
)
SELECT 'message' AS component,
       'Invalid input' AS title,
       group_concat(field||': '||reason, char(10)) AS description
FROM tests WHERE reason IS NOT NULL;
```

---

# 6) Auditing & soft permissions

Use triggers for audit; emulate ownership with WHERE clauses + guards.

```sql
CREATE TABLE audit_log(
  id INTEGER PRIMARY KEY,
  table_name TEXT,
  row_id TEXT,
  action TEXT,
  actor_id INTEGER,
  at DATETIME DEFAULT CURRENT_TIMESTAMP,
  snapshot TEXT
);

CREATE TRIGGER projects_audit_ins AFTER INSERT ON projects
BEGIN
  INSERT INTO audit_log(table_name,row_id,action,actor_id,snapshot)
  VALUES('projects', NEW.id, 'INSERT',
         (SELECT user_id FROM temp.ctx),
         json_object('row', json(NEW)));
END;

CREATE TRIGGER projects_audit_upd AFTER UPDATE ON projects
BEGIN
  INSERT INTO audit_log(table_name,row_id,action,actor_id,snapshot)
  VALUES('projects', NEW.id, 'UPDATE',
         (SELECT user_id FROM temp.ctx),
         json_object('old', json(OLD), 'new', json(NEW)));
END;

CREATE TRIGGER projects_audit_del AFTER DELETE ON projects
BEGIN
  INSERT INTO audit_log(table_name,row_id,action,actor_id,snapshot)
  VALUES('projects', OLD.id, 'DELETE',
         (SELECT user_id FROM temp.ctx),
         json_object('old', json(OLD)));
END;
```

**Ownership guard** (before showing/editing a row):

```sql
-- guards/require_owner.sql
WITH ctx AS (SELECT * FROM temp.ctx)
SELECT 'message','Access denied','You are not the owner'
WHERE NOT EXISTS (
  SELECT 1 FROM projects p, ctx
  WHERE p.id = :project_id AND p.owner_id = ctx.user_id
);
```

---

# 7) Partial templates via `run_sql` + preprocessor includes

**Component partial:**

```sql
-- partials/user_card.sql
SELECT 'card' AS component,
       json_extract(:user,'$.name')  AS title,
       json_extract(:user,'$.email') AS description;
```

**Use it:**

```sql
WITH u AS (SELECT json_object('name', name, 'email', email) AS user FROM users WHERE id = :id)
SELECT * FROM run_sql('partials/user_card.sql', (SELECT user FROM u));
```

> Preprocessor: define `@macro USER_CARD(json)` → `run_sql('partials/user_card.sql', json)`

---

# 8) Command bus for form actions (write middleware)

```sql
-- command_handlers(name TEXT PRIMARY KEY, sql_file TEXT)

-- process_command.sql
WITH h AS (SELECT sql_file FROM command_handlers WHERE name = :command)
SELECT * FROM run_sql((SELECT sql_file FROM h), json_object('payload', :payload))
UNION ALL
SELECT 'message','Unknown command','No handler found'
WHERE NOT EXISTS (SELECT 1 FROM h);
```

**Example handler (creates project with validation + audit happens via trigger):**

```sql
-- handlers/create_project.sql
WITH val AS (
  SELECT * FROM run_sql('validate.sql', json_object('entity','project','payload',:payload))
),
stop AS (SELECT 1 FROM val)
SELECT * FROM val
UNION ALL
INSERT INTO projects(name, owner_id)
SELECT json_extract(:payload,'$.name'), (SELECT user_id FROM temp.ctx)
WHERE NOT EXISTS (SELECT 1 FROM stop)
RETURNING 'message' AS component, 'Created' AS title, 'Project created.' AS description;
```

---

# 9) Feature flags / A/B via JSON1

```sql
-- choose which dashboard partial to render
WITH ctx AS (SELECT * FROM temp.ctx)
SELECT * FROM run_sql(
  CASE
    WHEN json_extract((SELECT flags_json FROM ctx),'$.new_dashboard') = 1
      THEN 'dashboards/new.sql'
    ELSE 'dashboards/old.sql'
  END
);
```

---

# 10) Simple parameter cache with TTL

```sql
CREATE TABLE cache(
  cache_key TEXT PRIMARY KEY,
  payload   TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- cache_fetch.sql
WITH k AS (
  SELECT lower(hex(sha1(COALESCE(:params,'')))) AS k  -- If you compiled a sha1 ext; else md5 via extension or fallback to params text.
),
hit AS (
  SELECT payload FROM cache
  WHERE cache_key = (SELECT k FROM k)
    AND julianday('now') - julianday(created_at) < (10.0/1440.0)  -- 10 minutes
)
SELECT 'raw' AS component, payload FROM hit;
```

**Cache-or-compute pattern (compute only when no hit):**

```sql
WITH existing AS (SELECT * FROM run_sql('cache_fetch.sql', json_object('params', :filters))),
miss AS (SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM existing)),
fresh AS (
  SELECT json_group_array(json_object('id', id, 'name', name)) AS payload
  FROM expensive_view ev
  WHERE :filters IS NULL OR ev.name LIKE '%'||:filters||'%'
)
SELECT * FROM existing
UNION ALL
INSERT INTO cache(cache_key, payload)
SELECT lower(hex(sha1(COALESCE(:filters,'')))), (SELECT payload FROM fresh)
WHERE EXISTS (SELECT 1 FROM miss)
RETURNING 'raw' AS component, payload;
```

> If you don’t have a SHA/MD5 extension, store `cache_key = :filters` (works fine if params are short) or roll your own key in the preprocessor.

---

# 11) Search middleware (FTS5 with ranking)

```sql
-- One-time setup
CREATE VIRTUAL TABLE users_fts USING fts5(name, email, content='users', content_rowid='id');
CREATE TRIGGER users_ai AFTER INSERT ON users BEGIN
  INSERT INTO users_fts(rowid,name,email) VALUES (NEW.id, NEW.name, NEW.email);
END;
CREATE TRIGGER users_au AFTER UPDATE ON users BEGIN
  INSERT INTO users_fts(users_fts, rowid, name, email) VALUES('delete', OLD.id, OLD.name, OLD.email);
  INSERT INTO users_fts(rowid,name,email) VALUES (NEW.id, NEW.name, NEW.email);
END;
CREATE TRIGGER users_ad AFTER DELETE ON users BEGIN
  INSERT INTO users_fts(users_fts, rowid, name, email) VALUES('delete', OLD.id, OLD.name, OLD.email);
END;

-- middleware/search_users.sql
WITH q AS (SELECT COALESCE(NULLIF(:q,''), '*') AS q)
SELECT u.id, u.name, u.email, bm25(users_fts) AS score
FROM users_fts JOIN users u ON u.id = users_fts.rowid
WHERE users_fts MATCH (SELECT q FROM q)
ORDER BY score
LIMIT COALESCE(:limit, 20);
```

---

# 12) Uniform list/detail scaffold (descriptor-driven)

```sql
-- resource_descriptors(name TEXT PRIMARY KEY, list_sql TEXT, detail_sql TEXT, default_sort TEXT)

-- generic_list.sql
WITH d AS (SELECT * FROM resource_descriptors WHERE name = :resource),
opts AS (SELECT * FROM run_sql('query_opts.sql', json_object('sort', :sort, 'page', :page, 'page_size', :page_size)))
SELECT * FROM run_sql(
  (SELECT list_sql FROM d),
  json_object('sort', COALESCE(:sort, (SELECT default_sort FROM d)),
              'limit',(SELECT page_size FROM opts),
              'offset',(SELECT offset_val FROM opts))
);
```

> Preprocessor: `@macro LIST(resource)` → `run_sql('generic_list.sql', json_object('resource', resource))`

---

# 13) Logging/metrics hook

```sql
-- log_event.sql
INSERT INTO app_log(at, user_id, event, meta)
VALUES (datetime('now'), (SELECT user_id FROM temp.ctx), :event, :meta)
RETURNING 'invisible' AS component;
```

Call it from guards/handlers:

```sql
SELECT * FROM run_sql('log_event.sql', json_object('event','projects.view','meta',json_object('project_id',:id)));
```

---

# 14) Error-resilient external fetch

SQLite can’t try/catch SQL errors, but you can **wrap external calls** in a helper that returns a default row on failure. If your SQLPage provides `sqlpage.fetch(...)`, prefer returning a sentinel when fetch fails and **COALESCE** your component.

```sql
-- safe_fetch.sql (pseudo—depends on your fetch function name)
WITH resp AS (
  SELECT json_extract(r,'$.ok') AS ok,
         r AS body
  FROM (SELECT sqlpage_fetch(:url) AS r)  -- replace with your function
)
SELECT 'card' AS component, 'External data' AS title, json_extract(body,'$.data') AS description
FROM resp WHERE ok=1
UNION ALL
SELECT 'message','Upstream error','Could not load external data' WHERE NOT EXISTS (SELECT 1 FROM resp WHERE ok=1);
```

---

## Preprocessor power moves

Your external preprocessor can make this feel like a full framework:

* **Includes**: `@include "ctx.sql"` at top of every file.
* **Macros**:

  * `@macro GUARD(role)` → expands to `run_sql('guards/require_role.sql', ...)`
  * `@macro USER_CARD(user_json)` → expands to the partial call.
* **Constants/config**: `@define PAGE_SIZE_DEFAULT 20`, substitute in `query_opts.sql`.
* **File routing**: generate `routes` seed data from a directory tree (compile-time).

---

## Minimal “page skeleton” tying it together

```sql
-- pages/projects/list.sql
@include "ctx.sql"

-- Optional guards
WITH guard AS (SELECT * FROM run_sql('guards/require_role.sql'))
SELECT * FROM guard
UNION ALL
SELECT * FROM run_sql('generic_list.sql',
  json_object('resource','projects','sort',:sort,'page',:page,'page_size',:page_size))
WHERE NOT EXISTS (SELECT 1 FROM guard)
UNION ALL
SELECT * FROM run_sql('log_event.sql', json_object('event','projects.list','meta',json_object()));
```

This structure gives you **consistent context, policy, validation, logging, caching, and templating** across a growing app—using only SQLite + your preprocessor + `run_sql`.

If you want, tell me which bits you plan to ship first (e.g., auth, CRUD, dashboards), and I’ll bundle the relevant files into a ready-to-paste mini-starter.

Great question. SvelteKit’s routing/layout model is full of ideas you can borrow—even in a SQLPage + SQLite + preprocessor world. Here’s a compact, practical “translation guide” with patterns and snippets you can drop in.

---

# 1) Filesystem routing → table-driven + folders

**SvelteKit:** `src/routes/blog/[slug]/+page.svelte`
**SQLPage idea:** mirror the tree; your preprocessor compiles it into a `routes` table.

```
/routes
  /+layout.sql
  /+layout.header.sql
  /dashboard/+page.sql
  /dashboard/+layout.sql
  /users/[id]/+page.sql
  /users/[id]/+page.actions.sql
  /api/posts/+server.sql
  /(marketing)/landing/+page.sql   <-- route group
```

Compile-time, generate `routes(path, sql_file, kind)` rows:

* `+layout.sql` → layout node for a prefix
* `+page.sql` → actual page
* `+server.sql` → API endpoint (JSON)
* `+page.actions.sql` → form handlers/command bus

---

# 2) Nested layouts & “slots”

**SvelteKit:** layouts compose; `slot` fills child content.
**SQLPage:** implement `render_layout(layout_file, inner_sql, params)`. Layout selects header/nav, then injects child content via `run_sql(inner_sql, params)`.

```sql
-- _layout_helpers.sql
CREATE TEMP TABLE temp._stack(depth INTEGER, layout TEXT); -- optional, for breadcrumbs

-- render_layout.sql
-- params: layout_file, inner_sql, params_json
WITH header AS (
  SELECT * FROM run_sql(:layout_file || '.header.sql', :params)  -- optional
)
SELECT * FROM header
UNION ALL
SELECT * FROM run_sql(:inner_sql, :params)
UNION ALL
SELECT * FROM run_sql(:layout_file || '.footer.sql', :params);  -- optional
```

**Usage (in dispatcher):**

```sql
-- For a match: root layout → section layout → page
SELECT * FROM run_sql('render_layout.sql',
  json_object(
    'layout_file','/routes/+layout',
    'inner_sql','/routes/dashboard/+layout.sql',
    'params', json_object('child_sql','/routes/dashboard/+page.sql', 'token', :token)
  )
);
```

And inside `/routes/dashboard/+layout.sql`:

```sql
-- expects :child_sql and params in :params
SELECT 'navbar' AS component, 'Dashboard' AS title;
SELECT * FROM run_sql(json_extract(:params,'$.child_sql'), :params);
```

> Tip: Your preprocessor can auto-wire the chain: parent `+layout.sql` wraps child layout wraps `+page.sql`.

---

# 3) Dynamic params: `[id]`, rest params: `[...slug]`

**SvelteKit:** folder names drive params.
**SQLPage:** let dispatcher parse the path and set `:params` JSON.

```sql
-- example page: /routes/users/[id]/+page.sql
WITH user AS (
  SELECT * FROM users WHERE id = CAST(json_extract(:params,'$.id') AS INTEGER)
)
SELECT 'card' AS component, name AS title, email AS description FROM user;
```

Rest segments:

```sql
-- /routes/docs/[...slug]/+page.sql
SELECT 'markdown' AS component, load_markdown(join_path('docs', json_each.value))
FROM json_each(json_extract(:params,'$.slug')); -- assume helper functions
```

---

# 4) `+layout.server.ts` / `load()` → `+layout.load.sql`

**SvelteKit:** parent/child `load` with cascading data.
**SQLPage:** each `+layout.load.sql` stores results in temp tables (`temp.ctx_*`) that children read.

```sql
-- /routes/+layout.load.sql
DROP TABLE IF EXISTS temp.ctx_app;
CREATE TEMP TABLE temp.ctx_app AS
SELECT u.id AS user_id, u.email, json_group_array(r.role) AS roles
FROM sessions s JOIN users u ON u.id=s.user_id
LEFT JOIN user_roles r ON r.user_id=u.id
WHERE s.token=:token
GROUP BY u.id;
```

Children can `SELECT * FROM temp.ctx_app`. You can add `/routes/dashboard/+layout.load.sql` to add `temp.ctx_dash`, etc.

---

# 5) Shared error & loading routes: `+error`, `+loading`

**SvelteKit:** special files.
**SQLPage:** define global partials and make dispatcher fall back to them.

* `/routes/+error.sql` – render a friendly component with details (no stack).
* `/routes/+loading.sql` – optional skeleton (helpful when you use external fetches).

Dispatcher skeleton:

```sql
WITH page AS (
  SELECT * FROM run_sql(:target_sql, :params)
)
SELECT * FROM page
UNION ALL
SELECT * FROM run_sql('/routes/+error.sql', json_object('message','Not found'))
WHERE NOT EXISTS (SELECT 1 FROM page);
```

---

# 6) Form actions: `+page.server.ts` `actions` → `+page.actions.sql`

Map form `action` names to handlers (command-bus style).

```sql
-- /routes/users/[id]/+page.actions.sql
WITH h AS (SELECT :action AS name)
SELECT * FROM run_sql(
  CASE (SELECT name FROM h)
    WHEN 'update' THEN '/handlers/user_update.sql'
    WHEN 'delete' THEN '/handlers/user_delete.sql'
    ELSE '/handlers/_unknown.sql'
  END,
  json_object('payload', :payload, 'params', :params)
);
```

Your `+page.sql` emits a `<form>` pointing at the same path with a hidden `action` field.

---

# 7) Route groups `(group)` and “private” folders

**SvelteKit:** groups don’t affect URL but organize code.
**SQLPage:** let folders in `()` be ignored for the path but contribute a layout.

```
/routes
  /(app)/+layout.sql        <-- wraps all app pages
  /(app)/projects/+page.sql <-- path is /projects
```

Preprocessor: compute the “effective layouts” chain for each page by walking parents and including any group layouts.

---

# 8) Universal vs server-only data

**SvelteKit:** `+layout.ts` (universal) vs `+layout.server.ts`.
**SQLPage:** decide what becomes:

* **Universal** (safe to embed in HTML): labels, i18n strings, feature toggles.
* **Server-only** (temp tables only): secrets, raw tokens, internal IDs.

Pattern:

* `/+layout.load.sql` writes **both** a component (`'invisible'` or `'raw'`) returning public JSON, **and** a `temp.ctx_*` table for private data. Pages read from temp tables; if needed, they can also read the public JSON.

---

# 9) Per-route hooks: `handle`, `handleFetch`

**SvelteKit:** global hooks.
**SQLPage:** emulate with two special files your dispatcher calls:

* `/hooks/+before.sql` (auth, tracing, feature flags)
* `/hooks/+after.sql`  (logging, metrics)

```sql
-- before
SELECT * FROM run_sql('/hooks/+before.sql', json_object('path', :path, 'token', :token));
-- then resolve route
-- after
SELECT * FROM run_sql('/hooks/+after.sql', json_object('path', :path, 'status', :status));
```

---

# 10) Route options: `prerender`, `ssr`, `trailingSlash`

**SvelteKit:** route metadata.
**SQLPage:** support a `route_meta` table or front-matter in each `+page.sql` that your preprocessor extracts:

```sql
-- front-matter-esque comment
-- meta: {"cache":"10m","trailingSlash":"ignore","csrf":true}

-- compiled into route_meta(path, key, value)
```

Dispatcher reads `route_meta` to set caching headers, enforce CSRF, or normalize paths.

---

# 11) Layout “data contracts”

Use a convention so layouts know what children provide and vice-versa. Example keys in `:params`:

* `params` – path params
* `query` – parsed querystring
* `ctx` – minimal public context (locale, theme)
* `child_sql` – which page or nested layout to render next

Your preprocessor ensures each layer passes these along.

---

# 12) Error boundaries per layout

**SvelteKit:** a layout can catch errors for its subtree.
**SQLPage:** let each `+layout.sql` optionally define `+layout.error.sql`. Wrap the child call:

```sql
-- in a layout
WITH child AS (SELECT * FROM run_sql(json_extract(:params,'$.child_sql'), :params))
SELECT * FROM child
UNION ALL
SELECT * FROM run_sql('/routes/this/layout/+layout.error.sql',
                      json_object('message','Subtree error'))
WHERE NOT EXISTS (SELECT 1 FROM child);
```

---

# 13) Progressive enhancement pattern

SvelteKit progressively enhances forms and links.
In SQLPage:

* Always make server-rendered forms work (POST → `+page.actions.sql`)
* Optionally add a small JS sprinkles file per route that calls lightweight JSON endpoints in `/api/.../+server.sql` and swaps components (keep the server contract identical).

---

# 14) “Parent data” access

**SvelteKit:** `const data = await parent()` in a child load.
**SQLPage:** parents write into `temp.ctx_*` (server-only) and/or emit a `'raw'` component with public JSON `data`. Children can:

```sql
-- read server-only
SELECT * FROM temp.ctx_app;

-- or read public
WITH d AS (SELECT payload FROM temp.ctx_public_data)  -- filled by parent
SELECT json_extract(d.payload,'$.theme') FROM d;
```

(You can have the preprocessor create a shared `temp.ctx_public_data` table per layout.)

---

# 15) Path aliases and link helpers

Create `link_to(name, params)` using the same route registry so links don’t hardcode paths.

```sql
-- route_params(name, pattern, segments_json)
-- link helper returns a href
SELECT build_path(pattern, :params) AS href
FROM route_params WHERE name = :name;
```

Use that in nav partials (like SvelteKit’s `$app/paths`).

---

## Tiny end-to-end example

```
/routes
  /+layout.load.sql         -- sets temp.ctx_app
  /+layout.sql              -- header/nav, calls child
  /(app)/projects/+layout.sql
  /(app)/projects/+page.sql
  /(app)/projects/+page.actions.sql
  /(app)/projects/[id]/+page.sql
  /api/projects/+server.sql
```

`/routes/(app)/projects/+page.sql`

```sql
-- expects ctx from parent, query from dispatcher
WITH opts AS (SELECT * FROM run_sql('/middleware/query_opts.sql',
                    json_object('sort',:sort,'page',:page,'page_size',:page_size)))
SELECT 'table' AS component, json_group_array(json_object(
  'id',p.id,'name',p.name,'owner',u.email
)) AS rows
FROM projects p JOIN users u ON u.id = p.owner_id
ORDER BY
  CASE json_extract((SELECT json(:sort)), '$')
    WHEN 'name' THEN p.name
    ELSE p.created_at
  END
LIMIT (SELECT page_size FROM opts) OFFSET (SELECT offset_val FROM opts);
```

`/routes/(app)/projects/+page.actions.sql`

```sql
WITH h AS (SELECT :action AS name)
SELECT * FROM run_sql(
  CASE (SELECT name FROM h)
    WHEN 'create' THEN '/handlers/create_project.sql'
    ELSE '/handlers/_unknown.sql'
  END,
  json_object('payload', :payload)
);
```

---

If you want, I can sketch the dispatcher + preprocessor rules that auto-wire:

* collecting the layout chain,
* extracting route metadata,
* populating `:params/:query`,
* and invoking `+layout.load.sql` files in order before rendering.

