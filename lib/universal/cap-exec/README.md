# Capturable Executables Content Preparation (`CECP`)

`CECP` is a general-purpose, polyglot content preparation and generation
system—great for SQL (e.g., SQLPage), JSON, Markdown, YAML, code scaffolds, and
more. It embraces the Linux philosophy: each file is its own “master program,”
composition happens through `STDIN → program → STDOUT`, and everything else is
just files and processes. Pipelines are declared in the filename—not hidden in
config.

## Overview

Capturable Executables Content Preparation (short: CapExec Content,
abbreviation: `CECP`) is a general-purpose, language-agnostic system for
preparing and generating content.

It follows the Linux philosophy:

- _Everything is a file_
- _Programs do one thing well_
- _Compose programs through standard streams (`stdin`, `stdout`, `stderr`)_

In `CECP`, files themselves are the master programs. They can be written in any
language (SQL, TypeScript, Python, Bash, etc.) and become "capturable
executables" ()scripts or templates that _capture_ generate *content *when
_executed_).

This makes `CECP` a polyglot content generation system. It is equally suitable
for:

- Preparing `.sql` files for tools like SQLPage.
- Generating `.json`, `.yaml`, `.csv`, or any arbitrary text/binary content.
- Chaining transformations across multiple stages (parsers, linters, formatters,
  compilers, etc.).

## General Purpose & Value

- Polyglot ready: Any executable supported by the OS (`ts-node`, `python`,
  `deno`, `bash`, etc.) can participate.
- Deterministic pipelines: Pre/post processing stages are expressed
  declaratively in filenames, not hidden in build configs.
- Composable: Each stage consumes `stdin` and produces `stdout`, forming a
  predictable pipeline.
- Type-safe context passing: Beyond raw streams, `CECP` supports passing
  strongly typed metadata and configuration using JSON + JSON Schema (e.g.,
  validated with Zod).
- Filesystem-native: No hidden registries — everything lives in the project tree
  and is discoverable by walking the filesystem.

The result: a lightweight, strongly typed build system where developers retain
full control while staying close to the OS and its tools.

## Filename Grammar

CapExec filenames declare their behavior directly:

```
<basename>.[<pre-stages>].<nature>[+].[<post-stages>].<domain>
```

- `<basename>` — Logical base name (e.g., `report`, `schema`).
- `.[<pre-stages>].` — Optional pipeline of pre-executables feeding `stdin` to
  the sink.
- `<nature>` — Content type (e.g., `sql`, `json`, `md`, `yaml`).
- `+` — If present, indicates multi-file generator. Output is emitted as JSONL
  records (`{ path, content }`) instead of a single file.
- `.[<post-stages>].` — Optional pipeline of post-executables, processing sink
  output.
- `<domain>` — Execution domain, usually indicating the runtime/language (e.g.,
  `.ts`, `.py`, `.sh`).

### Example

```
report.[seed validate].sql.[fmt].ts
```

- seed: pre-stage that emits initial content (e.g., SQL fragment).
- validate: pre-stage that checks constraints.
- .sql: nature, the file produces SQL.
- .ts: domain, the sink executable is a TypeScript program.
- fmt: post-stage that formats the SQL before writing the final
  `report.auto.sql`.

Final output:

```
report.auto.sql
```

## File Walking & Acquisition System

At the core of `CECP` is a file walker:

- Walks directories, databases, APIs, or other sources (extensible via
  adapters).
- Matches files against the CapExec grammar.
- Yields strongly typed Encountered items:

  - `basename`, `nature`, `domain`
  - Pre/post stage tokens
  - Normalized spec info
  - Optional typed payload (e.g., relative path, DB row metadata)

This is all implemented with TypeScript generics, giving developers:

- Type safety across file specs, walker adapters, and payloads.
- Flexibility to plug in custom sources (filesystem, DB, APIs).
- Consistency: one API for iterating over all content sources.

## Example: SQLPage Integration

Suppose you’re using SQLPage (which manages `.sql` files in a web app project).
`CECP` can help generate `.sql` content dynamically.

### Example 1: Basic SQL generator

File:

```
users.sql.ts
```

Executable TypeScript file that, when run, queries metadata and generates SQL:

```ts
console.log("SELECT * FROM users;");
```

`CECP` produces:

```
users.auto.sql
```

### Example 2: SQL with pre/post stages

File:

```
report.[seed].sql.[fmt].py
```

- `seed` (pre-stage, e.g. `echo "SELECT * FROM sales;"`)
- Sink (`report.sql.py`): Python script that enriches the SQL with filters or
  JOINs.
- `fmt` (post-stage, e.g. `sql-formatter` command)

Final output: `report.auto.sql` containing a pretty-printed SQL query.

### Example 3: Multi-file SQL generation

File:

```
views.sql+.ts
```

The executable emits JSONL records:

```json
{"path": "customer_view.sql", "content": "CREATE VIEW customer_view AS ...;"}
{"path": "order_view.sql", "content": "CREATE VIEW order_view AS ...;"}
```

`CECP` materializes:

```
views/
  customer_view.sql
  order_view.sql
```

## Example: JSON Generation

`CECP` isn’t just for SQL. Any file type can be targeted.

File:

```
schema.json.ts
```

Executable:

```ts
console.log(JSON.stringify({ tables: ["users", "orders"] }, null, 2));
```

Produces:

```
schema.auto.json
```

## Dataflow: content via STDIN/STDOUT

`CECP` runs three logical steps:

```
[pre stages]  → (STDOUT)
                 │
                 ▼
               (STDIN)  sink executable  (STDOUT)
                 │
                 ▼
               (STDIN) [post stages]  (STDOUT) → materialize to files
```

- Pre emits the _initial_ content to STDOUT.
- Sink reads from STDIN, transforms or generates, and writes to STDOUT.
- Post reads from STDIN, transforms, and emits the final content.

If the nature has a trailing `+` (e.g., `sql+`), the sink’s STDOUT is NDJSON
with one JSON object per line:

```json
{"path":"out/one.sql","content":"SELECT 1;"}
{"path":"out/two.sql","content":"SELECT 2;"}
```

`CECP` writes each record to the given `path` (relative to the sink directory by
default).

## Context & State: typed vs. untyped via environment

Beyond raw streams, `CECP` projects a minimal environment for every stage and
the sink. You can also inject your own variables. Typical defaults
(adapter-dependent) may include:

- `CAPEXEC_MODE` (`build` | `watch` | `dry-run`)
- `CAPEXEC_SINK` (absolute path to the sink file)
- `CAPEXEC_DIR` (directory of the sink)
- `CAPEXEC_BASENAME` (basename parsed from the filename)
- `CAPEXEC_NATURE` (e.g., `sql` or `sql+`)

### Untyped sharing (quick and simple)

Drop ad-hoc variables into env:

- `APP_ENV=prod`
- `FEATURE_FLAG_X=1`
- `TARGET_SCHEMA=public`

Shell, Python, TypeScript—every stage reads them the usual way:

```sh
# sh
echo "Running in $APP_ENV for schema $TARGET_SCHEMA"
```

```python
# Python
import os
flag = os.getenv("FEATURE_FLAG_X") == "1"
```

```ts
// TypeScript (Deno/node)
const env = Deno.env.get("TARGET_SCHEMA") ?? "public";
```

### Typed sharing (recommended)

For robust, typed context, `CECP` encourages shipping JSON via env (either as a
raw string or as a _file path_) and validating it with a schema library:

- TypeScript: Zod, Valibot, TypeBox, etc.
- Python: Pydantic, dataclasses + validators

Two patterns are common:

#### Pattern A: Inline JSON in an env var

- `CAPEXEC_CONTEXT_JSON` contains a compact JSON blob

```ts
// TypeScript (Deno) with Zod
import { z } from "zod";

const Context = z.object({
    appEnv: z.enum(["dev", "staging", "prod"]),
    schema: z.string().min(1),
    featureX: z.boolean().optional(),
});

const raw = Deno.env.get("CAPEXEC_CONTEXT_JSON") ?? "{}";
const ctx = Context.parse(JSON.parse(raw));

// use ctx.schema, ctx.appEnv...
```

```python
# Python with Pydantic
from pydantic import BaseModel
import os, json

class Context(BaseModel):
    appEnv: str
    schema: str
    featureX: bool | None = None

raw = os.environ.get("CAPEXEC_CONTEXT_JSON","{}")
ctx = Context.model_validate_json(raw)
# use ctx.schema, ctx.appEnv...
```

#### Pattern B: Path to a JSON file

- `CAPEXEC_CONTEXT_FILE` points to a JSON file `CECP` (or your wrapper) wrote

```ts
import { z } from "zod";

const Context = z.object({ schema: z.string() });
const fp = Deno.env.get("CAPEXEC_CONTEXT_FILE");
const parsed = fp ? JSON.parse(await Deno.readTextFile(fp)) : {};
const ctx = Context.parse(parsed);
```

```python
from pydantic import BaseModel
import os, json

class Context(BaseModel):
    schema: str

fp = os.environ.get("CAPEXEC_CONTEXT_FILE")
parsed = json.load(open(fp)) if fp else {}
ctx = Context.model_validate(parsed)
```

> Tip: For large or sensitive context, prefer the _FILE_ pattern.

## Extended Examples

### 1) Simple SQL for SQLPage

File: `users.sql.ts` Intent: Generate a static query for SQLPage to run; result
saved as `users.auto.sql`.

```ts
// users.sql.ts (Deno/Node)
const schema = Deno.env.get("TARGET_SCHEMA") ?? "public";
console.log(`SELECT * FROM ${schema}.users ORDER BY created_at DESC;`);
```

Run behavior:

- `CECP` runs the sink (`.ts` via your runtime resolver).
- The sink’s STDOUT becomes the file `users.auto.sql`.

### 2) SQL with pre/post stages

File: `report.[seed validate].sql.[fmt].py`

- seed: `sh -c 'printf "SELECT * FROM sales"'`
- validate: a checker that ensures the output isn’t empty (returns non-zero exit
  to fail)
- sink: Python script appends conditions, limits
- fmt: a SQL formatter (e.g., `sql-formatter` CLI)

Flow:

```
seed → validate → (sink py) → fmt → report.auto.sql
```

Python sink (reads from STDIN, appends where/limit):

```python
import sys
q = sys.stdin.read()
q = q.strip() + " WHERE amount > 0 ORDER BY created_at DESC LIMIT 100;\n"
sys.stdout.write(q)
```

### 3) Multi-file SQL generation (`sql+`)

File: `views.sql+.ts` Intent: Emit multiple views as NDJSON.

```ts
// views.sql+.ts
console.log(
    JSON.stringify({
        path: "views/customer_view.sql",
        content: "CREATE VIEW customer_view AS SELECT ...;",
    }),
);
console.log(
    JSON.stringify({
        path: "views/order_view.sql",
        content: "CREATE VIEW order_view AS SELECT ...;",
    }),
);
```

`CECP` writes:

```
views/customer_view.sql
views/order_view.sql
```

### 4) JSON generation

File: `schema.json.ts` Intent: Generate a JSON file for downstream tools.

```ts
console.log(JSON.stringify(
    {
        version: "1.0.0",
        tables: ["users", "orders", "items"],
    },
    null,
    2,
));
```

Result: `schema.auto.json`

# Drop-in Zod schemas for typed `CECP` context

Use one (or both) patterns depending on whether you want to pass context inline
(as JSON in an env var) or by file path.

## 1) Inline JSON via `CAPEXEC_CONTEXT_JSON`

```ts
// `cecp`-context.ts
import { z } from "jsr:@zodjs/zod@^4.0.0";

// 1) Define your context contract once
export const BuildContextSchema = z.object({
    appEnv: z.enum(["dev", "staging", "prod"]).default("dev"),
    schema: z.string().min(1).default("public"),
    featureX: z.boolean().optional(),
    flags: z.record(z.boolean()).default({}),
});

// 2) Convenient TypeScript type
export type BuildContext = z.infer<typeof BuildContextSchema>;

// 3) Parse from CAPEXEC_CONTEXT_JSON (inline JSON env)
export function parseContextFromEnvJSON(): BuildContext {
    const raw = Deno.env.get("CAPEXEC_CONTEXT_JSON") ?? "{}";
    return BuildContextSchema.parse(JSON.parse(raw));
}
```

In any stage/sink:

```ts
import { parseContextFromEnvJSON } from "./`cecp`-context.ts";

const ctx = parseContextFromEnvJSON();
console.log(`Using schema ${ctx.schema} in ${ctx.appEnv}`);
```

## 2) JSON file via `CAPEXEC_CONTEXT_FILE`

```ts
// `cecp`-context-file.ts
import { z } from "jsr:@zodjs/zod@^4.0.0";

export const BuildContextSchema = z.object({
    appEnv: z.enum(["dev", "staging", "prod"]).default("dev"),
    schema: z.string().min(1).default("public"),
    featureX: z.boolean().optional(),
    flags: z.record(z.boolean()).default({}),
});

export type BuildContext = z.infer<typeof BuildContextSchema>;

export async function parseContextFromEnvFile(): Promise<BuildContext> {
    const fp = Deno.env.get("CAPEXEC_CONTEXT_FILE");
    const parsed = fp ? JSON.parse(await Deno.readTextFile(fp)) : {};
    return BuildContextSchema.parse(parsed);
}
```

In any stage/sink:

```ts
import { parseContextFromEnvFile } from "./`cecp`-context-file.ts";
const ctx = await parseContextFromEnvFile();
```

> Tip: use file mode for large/sensitive context. Use inline for quick
> experiments.

# Reference CLI: `cectl.ts` (Cliffy)

A thin CLI you can compile with Deno. It wires up:

- walking the filesystem
- preparing & (optionally) executing CapExecs
- injects typed context (inline or file)
- supports `build`, `watch` (edge-triggered reruns), and `dry-run`

### Example CLI invocations

```bash
# Build everything under ./sql and ./api (defaults)
cectl build -r sql -r api

# Only include *.ts and *.py within sql/
cectl build -r sql -I "/*.ts" -I "/*.py"

# Exclude tests and temp
cectl build -r sql -X "/*.test.*" -X "/.tmp/"

# Build with typed context (inline JSON env)
cectl build -r sql --app-env prod --schema reporting --flag export=true

# Prefer context file (for large/sensitive context)
cectl build -r sql --context-file --context-outdir ./.capexec
```

## Quick “why” for env usage

- Content always flows through STDIN/STDOUT (the heart of `CECP`).
- State/Context flows via the Environment:

  - Untyped for quick flags: `FEATURE_X=1`.
  - Typed (Zod/Pydantic) for anything that benefits from validation and
    autocompletion—schemas, toggles, runtime values.

This keeps the data plane (content) clean and streamable, and the control plane
(context) explicit and verifiable.

If you want, I can also add:

- a tiny cookbook (“seed/validate/fmt” stage token patterns),
- Windows-friendly launchers (e.g., prefer `deno run`/`python` over POSIX
  tools),
- or a sample `sqlpage` project layout wired to `CECP`.

## How the system finds your files (file walking, flexibly and type-safely)

- `CECP` uses a walker (filesystem by default) that:

  - Traverses one or more roots (configurable)
  - Applies include/exclude globs
  - Parses filenames with the CapExec grammar
  - Yields strongly typed “found” items (`basename`, `nature`, `isMulti`,
    `preStages`, `postStages`, etc.)
- The walker is adapter-based and generic:

  - Today: filesystem
  - Future: databases, APIs, object stores—all via the same typed contract
  - Each adapter can attach a typed payload to encountered items (e.g.,
    `relPath`, DB primary keys)
- You can filter at discovery time:

  - “Only `.sql` nature”
  - “Only files under `src/sql/`”
  - “Only executables updated since X”

## Typical `CECP` usage in a “SQLPage-style” project

Project tree

```
sql/
  users.sql.ts
  report.[seed validate].sql.[fmt].py
  views.sql+.ts
api/
  schema.json.ts
```

Run `CECP` (CLI sketch):

```
cectl build sql/ api/
```

Results (examples):

```
sql/users.auto.sql
sql/report.auto.sql
sql/views/customer_view.sql
sql/views/order_view.sql
api/schema.auto.json
```

You now check in the _sources_ (the `.ts`/`.py` etc.), and decide whether to
check in the _generated_ `.auto.*` outputs depending on your workflow.

## Design notes & best practices

- Keep programs composable: prefer small, focused pre/post tools over monoliths.
- Make sinks pure (idempotent, no hidden side effects) for predictable builds.
- Use typed context for anything non-trivial. Validate early (Zod/Pydantic).
- Favor `STDIN/STDOUT` for content; reserve environment for _control_ and
  _context_.
- Embrace multi-file NDJSON for generators that fan out many files—fast,
  streaming, append-friendly.

# Unit testing, Verification and Validation

`CECP` is designed to be testable by default. Because every stage and sink is
just a process that speaks STDIN/STDOUT and reads ENV, you can test and debug
content generators independently—no framework or build system needed.

## Principles

- Small, composable units: test each _pre_ stage, sink, and _post_ stage
  separately.
- Pure data plane: feed input via STDIN, assert output via STDOUT.
- Explicit control plane: inject context via ENV (typed with Zod/Pydantic, or
  untyped).
- Determinism: the same inputs (STDIN + ENV + filesystem) produce the same
  outputs.

## Quick patterns

### 1) Test a sink in isolation (single-file natures)

If your sink reads SQL from STDIN and prints transformed SQL:

```bash
# Provide input on STDIN, assert STDOUT
printf 'SELECT 1;' \
  | CAPEXEC_MODE=build CAPEXEC_CONTEXT_JSON='{"schema":"public"}' \
    deno run -A path/to/sink.sql.ts \
  | diff -u - expected.sql
```

- Put expected output in `expected.sql` (golden file).
- Use `diff -u -` to compare STDOUT with the golden file.

### 2) Test a multi-file generator (`nature+`) that emits NDJSON

Generators print one JSON object per line (`{"path": "...", "content": "..."}`):

```bash
# Capture emitted NDJSON
CAPEXEC_CONTEXT_JSON='{"schema":"reporting"}' \
  deno run -A views.sql+.ts > out.ndjson

# Validate each line is valid JSON and contains required fields
jq -c '. | select(.path and .content)' out.ndjson >/dev/null

# Assert specific records exist
grep -q '"path":"views/customer_view.sql"' out.ndjson
grep -q '"content":"CREATE VIEW' out.ndjson
```

To materialize and then validate contents:

```bash
# Pipe through `CECP`'s default materializer (or your own script)
cat out.ndjson | while read -r line; do
  path=$(echo "$line" | jq -r .path)
  content=$(echo "$line" | jq -r .content)
  mkdir -p "$(dirname "$path")"
  printf '%s' "$content" > "$path"
done

diff -u views/customer_view.sql expected/customer_view.sql
```

### 3) Test a single stage (pre/post) independently

Stages are plain filters. Example: `upper` converts to uppercase.

```bash
printf 'hello' | upper | diff -u - <(printf 'HELLO')
```

If `upper` is a script:

```bash
printf 'hello' | sh ./stages/upper | diff -u - <(printf 'HELLO')
```

### 4) Debug a composed pipeline locally

Mimic `CECP`’s flow with classic pipes:

```bash
# pre → sink → post
printf 'seed' \
  | ./stages/seed \
  | deno run -A ./sinks/report.sql.ts \
  | ./stages/fmt \
  | tee actual.sql
```

- Use `tee` to see and save the output while debugging.
- Add `set -euo pipefail` at the top of shell stages for safer failures.

### 5) Typed context in tests (Zod/Pydantic)

Inline-JSON:

```bash
CAPEXEC_CONTEXT_JSON='{"appEnv":"staging","schema":"public"}' \
  deno run -A ./sinks/users.sql.ts | diff -u - expected/users.sql
```

File-based:

```bash
echo '{"schema":"public"}' > ./.capexec/context.json
CAPEXEC_CONTEXT_FILE=.capexec/context.json \
  deno run -A ./sinks/users.sql.ts | diff -u - expected/users.sql
```

### 6) Idempotence & determinism checks

Run twice and ensure the same bytes:

```bash
out1=$(mktemp); out2=$(mktemp)
CAPEXEC_CONTEXT_JSON='{}' deno run -A sink.sql.ts > "$out1"
CAPEXEC_CONTEXT_JSON='{}' deno run -A sink.sql.ts > "$out2"
cmp -s "$out1" "$out2"  # exit 0 means identical
```

### 7) Negative tests (input/validation errors)

If a _validate_ stage should fail on bad SQL:

```bash
set +e
printf 'BAD SQL' | ./stages/validate
test $? -ne 0  # expect non-zero exit
```

## Snapshot testing (golden files)

For large outputs (SQL, JSON, Markdown):

1. Generate output to a file (e.g., `actual.sql`).
2. Compare to a checked-in golden file: `diff -u actual.sql golden.sql`.
3. If behavior changes intentionally, update the golden file via a controlled
   workflow.

## CI considerations

- No network: strive for hermetic tests; mock APIs by injecting fixtures via
  ENV/STDIN or temporary files.
- Stable time/locale: if your generator uses timestamps/locales, inject fixed
  values via ENV for CI runs.
- Fail fast: non-zero exit codes from any stage should fail the test job.

## Logging & diagnostics

- Write logs to STDERR so they don’t pollute STDOUT:

  - In shell: `echo "debug" >&2`
  - In Node/Deno: `console.error("debug")`
  - In Python: `print("debug", file=sys.stderr)`

This keeps STDOUT reserved for test assertions and file materialization.

## Where `CECP` helps

- You can run the same executables in tests and in production builds.
- Pipelines are transparent: easy to bisect which stage breaks.
- ENV makes _control-plane_ behavior explicit and repeatable; STDIN/STDOUT keeps
  the _data-plane_ clean.

## Security & portability tips

- Treat environment context as untrusted unless validated.
- Avoid shell-injection: prefer argv arrays over `sh -c` when possible.
- For cross-platform projects:

  - Use portable tools (`node`, `deno`, `python`) rather than OS-specific ones
    when it matters.
  - On Windows, rely on `.ts/.py` runners instead of POSIX-only utilities.

## Troubleshooting

- Nothing gets written: ensure the filename matches the grammar and (for `sql+`)
  that your sink emits valid NDJSON.
- Stage not found: confirm your resolver maps stage tokens to actual executables
  (or use `$PATH`).
- Weird output: view raw `STDOUT` of each stage by running them manually and
  piping.
- Context missing: dump relevant env vars inside your scripts to confirm
  injection.

## Summary

CapExec Content Preparation (`CECP`) brings a Linux-inspired, type-safe, and
polyglot way to declare and execute content pipelines.

- No central build files: pipelines live in filenames.
- Any language: as long as the OS can execute it.
- Deterministic pipelines: `stdin` → sink → `stdout` with typed context passing.
- TypeScript-first: generic, strongly typed walkers and adapters.
- General purpose: equally useful for SQL, JSON, Markdown, YAML, or any
  text/binary.

Think of `CECP` as make for polyglot content pipelines, with each file declaring
its own build logic.
