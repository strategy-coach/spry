# SQLite DDL Migrations (No Dependencies)

Goal: Idempotent, self-describing, transactional schema management using only `sqlite3` and `.sql` files.

## 0) What You’ll Use

* Tool: `sqlite3` CLI
* Database file: `app.db` (or any name)
* Scripts & dirs:

  * `plan.sql` — the planner that *emits* comments + only the DDL you need
  * `migrations/` — folder where each run’s applied SQL is saved as an audit artifact

> We do not keep any permanent “migration” tables. A TEMP table is used only to print a per-run session id; it disappears when the connection closes.

## 1) Install / Verify SQLite CLI

* macOS: `brew install sqlite` (if needed)
* Ubuntu/Debian: `sudo apt-get install sqlite3`
* Fedora/CentOS: `sudo dnf install sqlite` or `sudo yum install sqlite`
* Windows:

  1. Download the “sqlite-tools” zip from the official site.
  2. Unzip into `C:\sqlite\` and add it to PATH.
  3. Verify: open PowerShell → `sqlite3 --version`

## 2) Repository Layout

```
your-project/
  app.db              # SQLite database (created on first run if missing)
  plan.sql            # migration planner (below)
  migrations/         # run artifacts (applied SQL & optional trace)
```

Create the `migrations/` folder:

```bash
mkdir -p migrations
```

Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force -Path migrations | Out-Null
```

## 3) How To Run (Plan → Log → Apply)

### macOS / Linux

```bash
ts="migrations/applied-$(date +%F-%H%M%S).sql"

# Plan → save output → Apply
sqlite3 app.db < plan.sql | tee "$ts" | sqlite3 app.db

# (Optional) sanity check: ensure the applied file alone is valid SQL
sqlite3 app.db -cmd ".bail on" < "$ts"

# (Optional) execution trace of applying that file
sqlite3 app.db -cmd ".trace '$ts.trace'" < "$ts" >/dev/null

echo "Migration applied. Log: $ts  Trace: $ts.trace"
```

### Windows PowerShell

```powershell
$ts = "migrations/applied-$(Get-Date -Format 'yyyy-MM-dd-HHmmss').sql"

# Plan → save output → Apply
cmd /c "sqlite3 app.db < plan.sql" | Tee-Object -FilePath $ts | cmd /c "sqlite3 app.db"

# (Optional) sanity check
cmd /c "sqlite3 app.db -cmd '.bail on' < $ts > NUL"

# (Optional) trace
cmd /c "sqlite3 app.db -cmd '.trace $ts.trace' < $ts > NUL"

"Migration applied. Log: $ts  Trace: $ts.trace"
```

> Dry-run: run only the first `sqlite3` (don’t pipe into the second). You’ll still get the fully annotated applied file to review.

## 4) `plan.sql` (emit-as-comments, fully valid SQL)

* All human-readable lines are SQL comments emitted by `SELECT '-- …'`.
* All executable statements are plain SQL text emitted by `SELECT '…;'`.
* The second pass sees a stream of valid SQL (comments + statements).

```sql
-- Generator-side CLI setup (only affects this first sqlite3 process)
.bail on
.timer off
.headers off
.mode list

-- Per-run session id in TEMP (disappears at connection close)
CREATE TEMP TABLE IF NOT EXISTS _mig_session(id TEXT);
DELETE FROM _mig_session;
INSERT INTO _mig_session(id) SELECT lower(hex(randomblob(16)));

-- Optional but recommended if you use FKs: enforce FK checks
SELECT 'PRAGMA foreign_keys=ON;';

-- ---- SELF-DESCRIBING HEADER (as SQL comments) ------------------------------
SELECT '-- MIGRATION BEGIN';
SELECT '-- session:  '||(SELECT id FROM _mig_session);
SELECT '-- started:  '||strftime('%Y-%m-%dT%H:%M:%fZ','now');
SELECT '-- sqlite:   '||sqlite_version();
SELECT '-- -------------------------------------------------------';

-- Pre-schema snapshot (comments only)
SELECT '-- pre-schema objects:';
SELECT '--   '||type||' '||name
FROM sqlite_schema
WHERE name NOT LIKE 'sqlite_%'
ORDER BY type, name;

-- Always do DDL atomically (emit BEGIN as SQL)
SELECT 'BEGIN IMMEDIATE;';

-- ======================= EXAMPLE STEPS ======================================

-- 1) Create table if missing
WITH need AS (
  SELECT 1 WHERE NOT EXISTS (
    SELECT 1 FROM sqlite_schema WHERE type='table' AND name='user'
  )
)
SELECT '-- APPLY  : create table user' FROM need
UNION ALL
SELECT 'CREATE TABLE IF NOT EXISTS user (
           id INTEGER PRIMARY KEY,
           email TEXT UNIQUE NOT NULL,
           created_at TEXT NOT NULL DEFAULT (
             strftime(''%Y-%m-%dT%H:%M:%fZ'',''now'')
           )
        );' FROM need
UNION ALL
SELECT '-- NOOP   : create table user (already exists)'
WHERE NOT EXISTS (SELECT 1 FROM need);

-- 2) Add column if missing
WITH need AS (
  SELECT 1 WHERE NOT EXISTS (
    SELECT 1 FROM pragma_table_info('user') WHERE name='last_login'
  )
)
SELECT '-- APPLY  : add column user.last_login' FROM need
UNION ALL
SELECT 'ALTER TABLE user ADD COLUMN last_login TEXT;' FROM need
UNION ALL
SELECT '-- NOOP   : add column user.last_login (already present)'
WHERE NOT EXISTS (SELECT 1 FROM need);

-- 3) Create index if missing
WITH need AS (
  SELECT 1 WHERE NOT EXISTS (
    SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_user_email'
  )
)
SELECT '-- APPLY  : create index idx_user_email on user(email)' FROM need
UNION ALL
SELECT 'CREATE INDEX IF NOT EXISTS idx_user_email ON user(email);' FROM need
UNION ALL
SELECT '-- NOOP   : create index idx_user_email (already exists)'
WHERE NOT EXISTS (SELECT 1 FROM need);

-- ===================== END EXAMPLE STEPS ====================================

-- Commit the transaction (emit as SQL)
SELECT 'COMMIT;';

-- Post-schema snapshot (comments only)
SELECT '-- post-schema objects:';
SELECT '--   '||type||' '||name
FROM sqlite_schema
WHERE name NOT LIKE 'sqlite_%'
ORDER BY type, name;

SELECT '-- -------------------------------------------------------';
SELECT '-- finished: '||strftime('%Y-%m-%dT%H:%M:%fZ','now');
SELECT '-- MIGRATION END';
```

## 5) Reading the Output

A typical `migrations/applied-…sql` looks like:

```sql
-- MIGRATION BEGIN
-- session:  5b3d9cfe2ab142ac85fba7b4d690f009
-- started:  2025-10-03T21:15:23Z
-- sqlite:   3.46.0
-- -------------------------------------------------------
-- pre-schema objects:
--   table user
--   index idx_user_email
BEGIN IMMEDIATE;
-- NOOP   : create table user (already exists)
-- APPLY  : add column user.last_login
ALTER TABLE user ADD COLUMN last_login TEXT;
-- NOOP   : create index idx_user_email (already exists)
COMMIT;
-- post-schema objects:
--   table user
--   index idx_user_email
-- -------------------------------------------------------
-- finished: 2025-10-03T21:15:23Z
-- MIGRATION END
```

* `-- APPLY` lines precede the exact SQL that will run.
* `-- NOOP` lines indicate guarded steps that were unnecessary.
* The file is executable SQL (comments + statements); you can replay it by itself.

## 6) Engineer Safety Playbook

1. Guard every DDL

   * New table: check `sqlite_schema`
   * New column: check `pragma_table_info('T')`
   * Index: `CREATE INDEX IF NOT EXISTS ...`

2. Transactional changes

   * Emit `BEGIN IMMEDIATE;` before the first DDL and `COMMIT;` after the last.

3. Never emit raw prose

   * Comments must be `--` lines, *emitted via* `SELECT '-- ...'`.
   * Executable lines must be real SQL ending with `;`, *emitted via* `SELECT '…;'`.

4. Foreign keys

   * If you depend on FKs, emit `PRAGMA foreign_keys=ON;` near the top (as an SQL statement via `SELECT 'PRAGMA ...';`).

5. Prefer additive changes

   * Add columns instead of changing types in place.
   * For incompatible changes, use a guarded rebuild (below).

6. Backups on prod

   * Before first rollout:

     * macOS/Linux: `cp app.db "app.db.bak.$(date +%F-%H%M%S)"`
     * PowerShell: `Copy-Item app.db "app.db.bak.$(Get-Date -Format 'yyyy-MM-dd-HHmmss')"`

7. WAL mode (optional)

   * For concurrent reads during migration: set once in environment setup (not required in `plan.sql`):

     ```sql
     PRAGMA journal_mode=WAL;
     ```

## 7) Tricky but Common Patterns (Templates)

### 7.1 Add a NOT NULL-like constraint safely

SQLite can’t `ALTER COLUMN` to add `NOT NULL`. Use DEFAULT + optional rebuild with `CHECK`.

```sql
-- Add with DEFAULT so existing rows are valid
WITH need AS (
  SELECT 1 WHERE NOT EXISTS (
    SELECT 1 FROM pragma_table_info('user') WHERE name='timezone'
  )
)
SELECT '-- APPLY  : add user.timezone TEXT DEFAULT ''UTC''' FROM need
UNION ALL
SELECT 'ALTER TABLE user ADD COLUMN timezone TEXT DEFAULT ''UTC'';' FROM need
UNION ALL
SELECT '-- NOOP   : add user.timezone (already present)'
WHERE NOT EXISTS (SELECT 1 FROM need);

/* If later you need strict enforcement, rebuild with CHECK or real NOT NULL: */
WITH need AS (
  SELECT 1 WHERE NOT EXISTS (
    SELECT 1
    FROM sqlite_schema
    WHERE type='table' AND name='user'
      AND sql LIKE '%CHECK( (timezone) IS NOT NULL AND (length(timezone) > 0) )%'
  )
)
SELECT '-- APPLY  : enforce timezone non-empty via CHECK (rebuild)' FROM need
UNION ALL
SELECT 'ALTER TABLE user RENAME TO user__old;' FROM need
UNION ALL
SELECT 'CREATE TABLE user (
          id INTEGER PRIMARY KEY,
          email TEXT UNIQUE NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime(''%%Y-%%m-%%dT%%H:%%M:%%fZ'',''now'')),
          timezone TEXT DEFAULT ''UTC'',
          CHECK( (timezone) IS NOT NULL AND (length(timezone) > 0) )
        );' FROM need
UNION ALL
SELECT 'INSERT INTO user(id,email,created_at,timezone)
        SELECT id,email,created_at,COALESCE(timezone,''UTC'')
        FROM user__old;' FROM need
UNION ALL
SELECT 'DROP TABLE user__old;' FROM need
UNION ALL
SELECT '-- NOOP   : timezone CHECK already enforced'
WHERE NOT EXISTS (SELECT 1 FROM need);
```

### 7.2 Guarded table rebuild for incompatible column changes

Only rebuild if a mismatch is detected.

```sql
WITH desired AS (
  SELECT 'id' AS name, 'INTEGER' AS type, 1 AS pk, 1 AS nn, NULL AS dv UNION ALL
  SELECT 'email','TEXT',0,1,NULL UNION ALL
  SELECT 'created_at','TEXT',0,1,"(strftime(''%Y-%m-%dT%H:%M:%fZ'',''now''))" UNION ALL
  SELECT 'last_login','TEXT',0,0,NULL
),
live AS (
  SELECT name, UPPER(type) AS type, pk, "notnull" AS nn, "dflt_value" AS dv
  FROM pragma_table_info('user')
),
mismatch AS (
  SELECT 1 FROM desired d
  LEFT JOIN live l ON l.name=d.name
  WHERE l.name IS NULL
     OR l.type <> UPPER(d.type)
     OR l.pk   <> d.pk
     OR l.nn   <> d.nn
     OR COALESCE(l.dv,'') <> COALESCE(d.dv,'')
  LIMIT 1
)
SELECT '-- APPLY  : rebuild user (incompatible columns)' FROM mismatch
UNION ALL
SELECT 'ALTER TABLE user RENAME TO user__old;' FROM mismatch
UNION ALL
SELECT 'CREATE TABLE user (
          id INTEGER PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL DEFAULT (strftime(''%%Y-%%m-%%dT%%H:%%M:%%fZ'',''now'')),
          last_login TEXT
        );' FROM mismatch
UNION ALL
SELECT 'INSERT INTO user (id,email,created_at,last_login)
        SELECT id,email,created_at,last_login FROM user__old;' FROM mismatch
UNION ALL
SELECT 'DROP TABLE user__old;' FROM mismatch
UNION ALL
SELECT '-- NOOP   : rebuild user (schema already matches)'
WHERE NOT EXISTS (SELECT 1 FROM mismatch);
```

### 7.3 Views & triggers (easy idempotence)

* Views: replace with drop/recreate (safe to re-run)

  ```sql
  SELECT '-- APPLY  : recreate view v_user_active';
  SELECT 'DROP VIEW IF EXISTS v_user_active;';
  SELECT 'CREATE VIEW v_user_active AS
          SELECT * FROM user WHERE last_login IS NOT NULL;';
  ```

* Triggers: create if not exists, or drop/recreate to modify

  ```sql
  SELECT '-- APPLY  : create trigger if not exists t_user_ai';
  SELECT 'CREATE TRIGGER IF NOT EXISTS t_user_ai
          AFTER INSERT ON user BEGIN
            UPDATE user SET last_login = NEW.created_at WHERE id = NEW.id;
          END;';
  ```

## 8) Concurrency & Locking

* We emit `BEGIN IMMEDIATE;` so the migration obtains a write lock up front, keeping the run atomic.
* If another writer is active, the CLI may error after waiting; re-run once the writer finishes.
* If your app runs migrations at startup, ensure only one instance runs `plan.sql` at a time.

## 9) CI / Automation Recipe

* Dry-run check (syntax + guards):

  ```bash
  sqlite3 ci-test.db < plan.sql > /dev/null
  test $? -eq 0 || (echo "Plan failed" && exit 1)
  ```

* Idempotence check (should mostly emit `-- NOOP` on 2nd run):

  ```bash
  sqlite3 ci-test.db < plan.sql | sqlite3 ci-test.db
  sqlite3 ci-test.db < plan.sql | sqlite3 ci-test.db
  ```

* Replay check (applied file alone is valid SQL):

  ```bash
  ts="migrations/ci-$(date +%F-%H%M%S).sql"
  sqlite3 ci-test.db < plan.sql | tee "$ts" | sqlite3 ci-test.db
  sqlite3 ci-test.db -cmd ".bail on" < "$ts"
  ```

## 10) Common Pitfalls (and our prevention)

* “This isn’t valid SQL” → Every emitted line is either a `-- comment` or a real SQL statement ending in `;`.
* “Duplicate table/index” → Guard with `WHERE NOT EXISTS` checks or `IF NOT EXISTS`.
* “Cannot add NOT NULL column” → Use DEFAULT then CHECK or a rebuild.
* “Foreign keys not enforced” → Emit `PRAGMA foreign_keys=ON;`.
* “Partial migration” → We bracket with `BEGIN IMMEDIATE; … COMMIT;`.

## 11) Engineering Checklist (Before Merging)

* [ ] I can run `sqlite3 --version`.
* [ ] I created `migrations/` and can write to it.
* [ ] First run emitted sensible `-- APPLY` lines and executed successfully.
* [ ] Second run emitted only `-- NOOP` lines (idempotent).
* [ ] The saved file in `migrations/` is executable SQL (replay succeeds).
* [ ] For any incompatible change, I used the guarded rebuild template.
* [ ] If I rely on foreign keys, I included `PRAGMA foreign_keys=ON;`.

### Final Notes

* This approach provides exact audit logs, no hidden state, and repeatable migrations—all with vanilla SQLite.
* If a change can’t be done additively, use the guarded rebuild pattern so that re-runs remain safe and self-documenting.
* Keep `plan.sql` small, readable, and organized into clearly labeled guarded blocks.
