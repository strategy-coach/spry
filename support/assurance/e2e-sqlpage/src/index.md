#!/usr/bin/env -S deno run --allow-read ../../../../lib/sqlpage/notebook.ts

---
siteName: "SQLPage Demo"
---

# SQLPage Notebook — Shebang + Examples

This file doubles as documentation **and** a runnable sample. Make it executable
and run it directly:

```bash
chmod +x index.md
./index.md                # human summary
./index.md --json         # machine-readable JSON
./index.md --strict       # drop fences that fail attribute validation
```

If you prefer piping via stdin:

```bash
cat index.md | deno run --allow-read ../../../../lib/sqlpage/notebook.ts --base .
cat index.md | deno run --allow-read ../../../../lib/sqlpage/notebook.ts --base . --json
```

> `--base <dir>` sets the base directory for stdin runs. For shebang runs, the
> base dir is the **canonical directory** of this file (symlinks resolved).

---

## Sample shebang lines

Use whichever style suits your project layout:

```text
#!/usr/bin/env -S deno run --allow-read ../../../../lib/sqlpage/notebook.ts
```

Absolute path:

```text
#!/usr/bin/env -S deno run --allow-read /absolute/path/to/lib/sqlpage/notebook.ts
```

Remote (pin a tag/commit you trust):

```text
#!/usr/bin/env -S deno run --allow-read https://example.com/your/notebook.ts
```

> Only `--allow-read` is required for parsing your Markdown. Add more
> permissions if your downstream steps need them.

---

## What this runner does

- Strips the shebang (first line).
- Parses this Markdown for **`sql` fenced blocks**.
- Validates attributes (we use a `kind` discriminant).
- Yields typed fences (no files are written here).

Kinds we use:

- `head` — raw SQL to run once up-front (e.g., pragmas).
- `page` — a SQLPage page (you’ll write these out later in your own pipeline).
- `tail` — raw SQL to run after pages.

## Head

```sql { kind: "head" }
PRAGMA foreign_keys = ON;
-- Place any one-time DB session config here.
```

---

## Page

```sql { kind: "page", path: "test.sql" }
-- Minimal example content you might adapt into a SQLPage page:
select
  'SQLPage Demo' as title,
  'Welcome from index.md' as subtitle,
  1 as one;
```

---

## Tail

```sql { kind: "tail" }
-- Post-page SQL (analytics, maintenance, etc.)
-- This runs after all page blocks in your pipeline.
select 'tail complete' as status;
```

---

## Alternate invocations

Direct CLI (no shebang):

```bash
deno run --allow-read ../../../../lib/sqlpage/notebook.ts index.md
deno run --allow-read ../../../../lib/sqlpage/notebook.ts index.md --json
deno run --allow-read ../../../../lib/sqlpage/notebook.ts index.md --strict
```

From another directory:

```bash
(cd docs && ./index.md --json)
# or
deno run --allow-read ../../../../lib/sqlpage/notebook.ts ./docs/index.md
```

Via stdin with explicit base:

```bash
cat docs/index.md | deno run --allow-read ../../../../lib/sqlpage/notebook.ts --base ./docs
```

> Shebang runs automatically resolve the **canonical** directory of the file
> (symlinks included) and use that as base. For stdin, pass `--base`.
