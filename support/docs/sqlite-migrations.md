# SQLite DDL Migrations (No Dependencies)

Goal: Idempotent, self-describing, and transactional schema management using only the `sqlite3` CLI and plain `.sql` files.

* Tool: `sqlite3` command-line tool (bundled on macOS; available via package managers on Linux/Windows).
* DB file: `app.db` (or any name you choose).
* SQL scripts:

  * `plan.sql` — emits human-readable log lines and only the DDL you actually need.
  * `migrations/` — folder where each run’s applied SQL is saved as an audit artifact.

> We do not create any permanent tables for migration tracking. All state is inferred from `sqlite_schema` and PRAGMAs. One TEMP table is used per run for a session id and disappears automatically.

Install / Verify the SQLite CLI:

* macOS: `brew install sqlite` (if not already present).
* Ubuntu/Debian: `sudo apt-get install sqlite3`
* Fedora/CentOS: `sudo dnf install sqlite` or `sudo yum install sqlite`
* Windows:

  1. Download “sqlite-tools” zip from the official SQLite site.
  2. Unzip into `C:\sqlite\` and add that folder to your PATH.
  3. Verify: open PowerShell → `sqlite3 --version`

Folder Layout:

```
your-project/
  app.db              # your SQLite database (or create on first run)
  plan.sql            # migration planner (provided below)
  migrations/         # auto-created; holds applied logs per run
```

Create the folder for logs:

```bash
mkdir -p migrations
```

Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force -Path migrations | Out-Null
```

## How To Run (Plan → Log → Apply)

### macOS / Linux (Bash/Zsh)

```bash
ts="migrations/applied-$(date +%F-%H%M%S).sql"

# Plan → log to file → Apply to DB
sqlite3 app.db < plan.sql | tee "$ts" | sqlite3 app.db

# (Optional) Execution trace from the CLI processing that file
sqlite3 app.db -cmd ".trace '$ts.trace'" < "$ts" >/dev/null

echo "Migration applied. Log: $ts  Trace: $ts.trace"
```

### Windows PowerShell

```powershell
$ts = "migrations/applied-$(Get-Date -Format 'yyyy-MM-dd-HHmmss').sql"

# Plan → log → Apply
cmd /c "sqlite3 app.db < plan.sql" | Tee-Object -FilePath $ts | cmd /c "sqlite3 app.db"

# (Optional) Execution trace
cmd /c "sqlite3 app.db -cmd '.trace $ts.trace' < $ts > NUL"

"Migration applied. Log: $ts  Trace: $ts.trace"
```

> Dry-run: run only the first half (don’t pipe into the second `sqlite3`). You’ll still get the complete “would-apply” file.

## The `plan.sql` (Self-Describing, Idempotent, Transactional)

Drop this file into your repo as `plan.sql`. It includes:

* Run header (session id, start time, SQLite version)
* Pre-schema listing
* Transaction wrapper (`BEGIN IMMEDIATE … COMMIT`)
* Guarded DDL blocks that print `APPLY` or `NOOP`
* Post-schema listing and footer

```sql
.bail on
.timer on
.echo off

-- Per-run session id in TEMP (auto-disappears at connection close)
CREATE TEMP TABLE IF NOT EXISTS _mig_session(id TEXT);
DELETE FROM _mig_session;
INSERT INTO _mig_session(id) SELECT lower(hex(randomblob(16)));

-- Recommended safety: enable FK checks if you use FKs
PRAGMA foreign_keys=ON;

.print ---- MIGRATION BEGIN ----
.print session:  (SELECT id FROM _mig_session)
.print started:  (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
.print sqlite:   (SELECT sqlite_version())
.print ----------------------------------------------------.print pre-schema objects:
SELECT '--   '||type||' '||name
FROM sqlite_schema
WHERE name NOT LIKE 'sqlite_%'
ORDER BY type, name;

-- Always do DDL atomically
SELECT 'BEGIN IMMEDIATE;';

-- ===================== EXAMPLE STEPS =======================

-- 1) Create table if missing
WITH need AS (
  SELECT 1
  WHERE NOT EXISTS (
    SELECT 1 FROM sqlite_schema WHERE type='table' AND name='user'
  )
)
SELECT '.print APPLY  : create table user' FROM need
UNION ALL
SELECT 'CREATE TABLE IF NOT EXISTS user (
           id INTEGER PRIMARY KEY,
           email TEXT UNIQUE NOT NULL,
           created_at TEXT NOT NULL DEFAULT (
             strftime(''%Y-%m-%dT%H:%M:%fZ'',''now'')
           )
        );' FROM need
UNION ALL
SELECT '.print NOOP   : create table user (already exists)'
WHERE NOT EXISTS (SELECT 1 FROM need);

-- 2) Add column if missing
WITH need AS (
  SELECT 1
  WHERE NOT EXISTS (
    SELECT 1 FROM pragma_table_info('user') WHERE name='last_login'
  )
)
SELECT '.print APPLY  : add column user.last_login' FROM need
UNION ALL
SELECT 'ALTER TABLE user ADD COLUMN last_login TEXT;' FROM need
UNION ALL
SELECT '.print NOOP   : add column user.last_login (already present)'
WHERE NOT EXISTS (SELECT 1 FROM need);

-- 3) Create index if missing
WITH need AS (
  SELECT 1
  WHERE NOT EXISTS (
    SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_user_email'
  )
)
SELECT '.print APPLY  : create index idx_user_email on user(email)' FROM need
UNION ALL
SELECT 'CREATE INDEX IF NOT EXISTS idx_user_email ON user(email);' FROM need
UNION ALL
SELECT '.print NOOP   : create index idx_user_email (already exists)'
WHERE NOT EXISTS (SELECT 1 FROM need);

-- =================== END EXAMPLE STEPS =====================

-- Commit the transaction emitted above
SELECT 'COMMIT;';

.print post-schema objects:
SELECT '--   '||type||' '||name
FROM sqlite_schema
WHERE name NOT LIKE 'sqlite_%'
ORDER BY type, name;

.print -------------------------------------------------------
.print finished: (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
.print ---- MIGRATION END ----
```

## Reading the Output (What Good Looks Like)

A typical run writes a file like `migrations/applied-2025-10-03-211523.sql`:

```
---- MIGRATION BEGIN ----
session:  5b3d9cfe2ab142ac85fba7b4d690f009
started:  2025-10-03T21:15:23Z
sqlite:   3.46.0
-------------------------------------------------------
pre-schema objects:
--   table user
--   index idx_user_email
BEGIN IMMEDIATE;
.print NOOP   : create table user (already exists)
.print APPLY  : add column user.last_login
ALTER TABLE user ADD COLUMN last_login TEXT;
.print NOOP   : create index idx_user_email (already exists)
COMMIT;
post-schema objects:
--   table user
--   index idx_user_email
-------------------------------------------------------
finished: 2025-10-03T21:15:23Z
---- MIGRATION END ----
```

* `APPLY` lines mean we executed a statement (the statement is right below).
* `NOOP` means the step wasn’t needed (already in desired state).
* `BEGIN/COMMIT` brackets ensure atomicity.

> If anything fails, `.bail on` makes the CLI stop with a non-zero exit code. Nothing partial should be left behind because DDL was inside a transaction.

## Safety Playbook (Memorize These)

1. Always guard DDL

   * New table: `WHERE NOT EXISTS (…sqlite_schema…)`
   * New column: `WHERE NOT EXISTS (SELECT 1 FROM pragma_table_info('T') WHERE name='c')`
   * Index: `CREATE INDEX IF NOT EXISTS`

2. Always wrap in a transaction

   * Emit `BEGIN IMMEDIATE;` before any DDL and `COMMIT;` at the end.

3. Never use `PRAGMA writable_schema=ON`

   * It bypasses safety checks. Avoid for routine migrations.

4. Prefer additive changes

   * Columns: add new columns; avoid destructive changes.
   * For incompatible changes, do a guarded rebuild (template below).

5. Enable foreign keys if you use them

   * `PRAGMA foreign_keys=ON;` at the top ensures FK constraints are enforced.

6. Backups for production

   * Before first rollout on prod:

     ```bash
     cp app.db "app.db.bak.$(date +%F-%H%M%S)"
     ```

     PowerShell:

     ```powershell
     Copy-Item app.db "app.db.bak.$(Get-Date -Format 'yyyy-MM-dd-HHmmss')"
     ```

7. WAL mode (optional, improves concurrency)

   * Good for apps doing reads/writes while migrating:

     ```sql
     PRAGMA journal_mode=WAL;
     ```
   * You can place this near the top of `plan.sql` if desired.

## Patterns for Tricky Cases (Templates)

### Add a NOT NULL column safely

SQLite can’t `ADD COLUMN ... NOT NULL` without a default unless the table is empty. Use this pattern:

```sql
-- Step 1: add with a DEFAULT (so existing rows get a value)
WITH need AS (
  SELECT 1 WHERE NOT EXISTS (
    SELECT 1 FROM pragma_table_info('user') WHERE name='timezone'
  )
)
SELECT '.print APPLY  : add user.timezone TEXT DEFAULT ''UTC''' FROM need
UNION ALL
SELECT 'ALTER TABLE user ADD COLUMN timezone TEXT DEFAULT ''UTC'';' FROM need
UNION ALL
SELECT '.print NOOP   : add user.timezone (already present)'
WHERE NOT EXISTS (SELECT 1 FROM need);

-- Step 2 (optional): strengthen via CHECK instead of NOT NULL
-- (SQLite lacks ALTER COLUMN to add NOT NULL; use CHECK to enforce non-empty)
WITH need AS (
  SELECT 1 WHERE NOT EXISTS (
    SELECT 1
    FROM sqlite_schema
    WHERE type='table' AND name='user'
      AND sql LIKE '%CHECK( (timezone) IS NOT NULL AND (length(timezone) > 0) )%'
  )
)
SELECT '.print APPLY  : enforce timezone not null via CHECK (rebuild)' FROM need
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
SELECT '.print NOOP   : timezone CHECK already enforced'
WHERE NOT EXISTS (SELECT 1 FROM need);
```

> Why CHECK? SQLite can’t ALTER a column to add NOT NULL. Rebuild is the canonical path to strengthen constraints.

### Guarded table rebuild for incompatible changes

Use this when types/constraints must change. The block emits nothing unless a mismatch is detected.

```sql
-- Detect a mismatch and only then rebuild
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
SELECT '.print APPLY  : rebuild user (incompatible columns)' FROM mismatch
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
SELECT '.print NOOP   : rebuild user (schema already matches)'
WHERE NOT EXISTS (SELECT 1 FROM mismatch);
```

> This stays idempotent: if the live schema already matches, you’ll only see a NOOP line.

### Views & triggers (always safe)

* Views: always replace

  ```sql
  SELECT '.print APPLY  : recreate view v_user_active';
  SELECT 'DROP VIEW IF EXISTS v_user_active;';
  SELECT 'CREATE VIEW v_user_active AS
          SELECT * FROM user WHERE last_login IS NOT NULL;';
  ```
* Triggers: safe create (or drop/recreate to modify)

  ```sql
  SELECT '.print APPLY  : create trigger if not exists t_user_ai';
  SELECT 'CREATE TRIGGER IF NOT EXISTS t_user_ai
          AFTER INSERT ON user BEGIN
            UPDATE user SET last_login = NEW.created_at WHERE id = NEW.id;
          END;';
  ```

## Version Notes (Avoid Surprises)

* SQLite version (printed in header) matters for certain DDL features (e.g., `ALTER TABLE ... RENAME COLUMN` needs ≥3.25).
* If you’re unsure about fleet versions in the field, prefer rebuild patterns which work across older versions.

## Concurrency & Locking

* We emit `BEGIN IMMEDIATE;` so the migration obtains a write lock before generating DDL statements, keeping the run atomic.
* If another process holds a write lock, the CLI will wait briefly and then error. Rerun after other writers finish.
* For services with concurrent traffic, consider setting WAL mode ahead of time (`PRAGMA journal_mode=WAL;`) during environment setup (not necessarily inside migrations).

## CI / Automation Recipe

* Dry-run in CI: verify `plan.sql` produces valid SQL and sensible `APPLY/NOOP` lines without changing a shared database.

  ```bash
  sqlite3 ci-test.db < plan.sql > /dev/null
  test $? -eq 0 || (echo "Plan failed" && exit 1)
  ```
* Apply on ephemeral DBs to catch syntax errors and ensure idempotence (run `plan.sql` twice; second run should be mostly NOOPs):

  ```bash
  sqlite3 ci-test.db < plan.sql | sqlite3 ci-test.db
  sqlite3 ci-test.db < plan.sql | sqlite3 ci-test.db  # should be NOOPs
  ```

## Common Pitfalls (and How We Avoid Them)

* “Cannot add NOT NULL column without default” → Use the add with DEFAULT then CHECK or rebuild pattern.
* “Duplicate index/table” errors → Always guard with `IF NOT EXISTS` or `WHERE NOT EXISTS` queries.
* Partial migrations → We wrap DDL in a single transaction (`BEGIN IMMEDIATE … COMMIT`).
* Foreign keys not enforced → Ensure `PRAGMA foreign_keys=ON;` at the top of `plan.sql`.
* Tooling differences on Windows → Use PowerShell `Tee-Object` equivalent shown above.

## Engineering Checklist (Before Merging)

* [ ] I can run `sqlite3 --version`.
* [ ] I created `migrations/` in the repo.
* [ ] I ran the migration once; I see `APPLY` lines only where needed.
* [ ] I ran it a second time; I see `NOOP` lines (idempotent).
* [ ] I reviewed `migrations/applied-*.sql` and, if needed, `.trace`.
* [ ] My changes are wrapped in a single transaction and use guards.
* [ ] If I changed constraints or types, I used the guarded rebuild template.

### Final Word

This approach gives you exact audit logs, no hidden state, and repeatable migrations—all with the vanilla SQLite CLI. If a future change feels “destructive,” convert it into a guarded rebuild so re-runs remain safe and self-documenting.
