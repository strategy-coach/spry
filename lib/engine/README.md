# Getting Started with the Spry SQLPage Orchestration Engine

Spry is a tiny orchestration framework for SQLPage-based apps (plus other
assets) written in Deno/TypeScript. If you’re a data analyst or a junior
developer who mainly knows SQL, think of Spry as the project manager for your
pages:

- It reads your intent from special comments (called _annotations_).
- It transforms your files with small inline commands (called _directives_).
- It runs programs that produce content (called _foundries_) and saves the
  results into stores so everything is reproducible.

Spry then optionally updates a SQLite table (`sqlpage_files`) so SQLPage always
sees the latest pages. It also provides a CLI to list things, build, and watch
files during development.

NOTE: This document is incomplete, contains some duplicate content and
disorganized as of September 25, 2025. It needs to be organized and edited.

TODO: use `deps.ts` or import maps to unify usage of all libraries instead of
putting hardcoded libraries in import statements.

## TypeScript Engine vs Polyglot Plugins

Spry itself (the _engine_) is written in Deno and TypeScript. But the pipeline
is intentionally polyglot. Any step of the workflow can invoke foundries
(executables) which are just programs annotated for Spry to discover and run.
These foundries act as plugins and can be written in any language — Bash,
Python, Rust, Go, Java, Node.js, etc. — as long as they follow Spry’s simple
(Linux-like) conventions and use environment variables to emit predictable SQL,
JSON, or Markdown. Spry is not opinionated about languages: you use the right
tool for each job.

## The Spry Mental Model (4 simple ideas)

- Annotations (`@…`) are blueprints. They describe what a file is or how it
  should appear. They _never_ change your file’s text.
- Directives (`#…` or `!…`) are assembly instructions. They transform your
  file’s text _inline_ (insert layouts, headers, snippets, etc.). These can
  modify your source files within the _regions_ you specify.
- Foundries are production shops (executable files in any language) Spry can run
  to generate SQL/JSON/Markdown.
- Stores are warehouses where Spry materializes or forges outputs (e.g.,
  `spry.d/auto/*`, and the `sqlpage_files` table).

Spry works in two phases:

1. Processing: scan, validate, and plan (read annotations, detect directives and
   foundries).
2. Execution: apply directives, run foundries, and store results in predictable
   locations.

## What Spry gives you

- No copy-paste layouts — include headers/footers/layouts with one line.
- Consistent navigation — routes and breadcrumbs come from annotations.
- Reproducible builds — one command rebuilds everything the same way.
- Polyglot power — foundries can be Python, Bash, Rust, Go, Node.js—whatever
  suits the job.
- Dev loop — watch files, rebuild automatically, and keep SQLPage synced.

## Project layout expectations

The `spryctl.ts init` helper aides you in setting up the following.

- Your project has a `src/` folder that contains your SQLPage files and Spry
  assets.
- Spry is usually symlinked under `src/spry` so Deno’s watcher can follow the
  physical location.
- Generated artifacts land under `spry.d/auto/` (owned by Spry and safe to
  clean).

## Minimal entry point

Your project's `spryctl.ts` (or similar) typically looks like this (_make sure
to set it as an executable_):

```ts
#!/usr/bin/env -S deno run -A

import { fromFileUrl } from "jsr:@std/path@1";
import * as o from "../../../lib/engine/orchestrate.ts";

export class EndToEndTestPrime extends o.Plan {
  constructor() {
    super(o.projectPaths(
      fromFileUrl(import.meta.resolve("./")),
      "../../../lib/std",
    ));
  }
}

if (import.meta.main) {
  const e2e = new EndToEndTestPrime();
  if (Deno.args.length > 0) {
    await new o.CLI(e2e).cli().parse(Deno.args);
  } else {
    await new o.SQL(e2e).toStdOut();
  }
}
```

With no arguments it prints SQL to stdout. With arguments it exposes the full
CLI. To learn more about the CLI use:

```
./spryctl.ts help
./spryctl.ts <command> help
```

## Step-by-Step: Typical Workflow

1. Write your page in `.sql`.
2. Add annotations to describe routing and titles.
3. Add directives where you want layouts/snippets.
4. (Optional) Add foundries for generated content (e.g., a script that prints
   SQL).
5. Build:

   ```bash
   ./spryctl.ts build
   ```

   - Spry processes (reads annotations, detects directives and foundries).
   - Spry executes (applies directives, runs foundries).
   - Outputs are materialized into stores (`spry.d/auto/*`, `sqlpage_files`).
6. Dev mode (auto-rebuild on change):

   ```bash
   ./spryctl.ts dev
   ```

## Key Concepts (with examples)

### 1) Annotations — _Describe intent (don’t modify text)_

- What they are: Special comments that start with `@`.
- What they do: Tell Spry about routes, titles, phases, and how a file
  participates in the workflow.
- Where they live: In `.sql`, `.md`, scripts, etc.

```sql
-- @route.path /reports
-- @route.title Monthly Reports
```

> Think of annotations as labels and settings. Spry reads them; your file’s text
> is unchanged.

#### `@spry` _resource_ annotations

- Purpose: Describe a _resource_ or _entry point_ into your project.
- Where used:

  - Foundries (executables) (`abc.sql.auto.ts`, `abc.json.auto.ts`, etc.)
  - SQLPage files (`.sql`, `.md`, etc.)
- What they do:

  - Tell Spry how to treat the file during orchestration.
  - Indicate what phase to run in (`before-sqlpage-files`,
    `after-sqlpage-files`, or both).
  - Define outputs (SQL, JSON, Markdown) and where to materialize them.
  - Carry extra metadata for orchestration, e.g. dependencies, purpose, or tags.

Think of `@spry resource` as a declaration of capability — “this file
participates in Spry’s workflow, here’s what it does.”

#### `@route` annotations

- Purpose: Describe navigation routes in your SQLPage project.
- Where used: Inside SQLPage `.sql` files (usually near the top).
- What they do:

  - Attach a logical route to the SQLPage file.
  - Provide display metadata (title, label, description).
  - Generate breadcrumbs automatically so navigation is consistent across your
    project.
  - Support hierarchical navigation by defining parent–child relationships
    between routes.

Think of `@route` as declaration of placement — “this page lives here in the
navigation tree.”

#### Side by side

| Aspect         | `@spry.*` tags define _resources_         | `@route.*` tags define navigation              |
| -------------- | ----------------------------------------- | ---------------------------------------------- |
| Focus          | How a file participates in orchestration  | How a page appears in site navigation          |
| Scope          | Executables, SQL, JSON, Markdown          | SQLPage routes (pages, views, menus)           |
| Controls       | Workflow phase, outputs, foundry behavior | Path, title, breadcrumbs, parent relationships |
| Think of it as | “Capability declaration”                  | “Navigation declaration”                       |

💡 Spry's annotations are extensible and type-safe. If your project needs other
types of annotations, contact the Spry team.

### 2) Directives — _Transform text inline_

Directives are small inline commands inside comments (often in `.sql`) that
modify the content Spry ships to SQLPage.

- Inline directive: replaces just the directive line.
- Block directive: keeps begin/end markers but replaces only the lines in
  between.

```sql
-- #include layout default
SELECT 'content';

-- #include sidebar left
  -- inner lines will be replaced
-- #includeEnd sidebar

-- !inject header x-powered-by=spry
```

Use directives to insert layouts, shared snippets, middleware, or boilerplate.

---

### 3) Foundries — _Generate & materialize content_

A foundry is an executable file (any language) that Spry discovers via an
annotation (e.g., `@spry.nature foundry`). Spry runs the foundry, captures its
output, and materializes it into stores (or lets the foundry executable decide
where to put content using env vars).

- Languages: Python, Bash, Rust, Go, Java, Node.js—anything that can print
  SQL/JSON/Markdown.
- When they run: In a phase you declare (e.g., `before-sqlpage-files` or
  `after-sqlpage-files`).
- What they produce: Artifacts saved under `spry.d/auto/*` and/or loaded into
  `sqlpage_files`.

> Foundries are like plugins that don’t extend the engine itself. Instead of
> “plugging into” or modifying Spry’s internals, a foundry simply produces
> output (SQL/JSON/Markdown). Spry captures that output and stores it. This
> keeps the engine simple and your automation portable.

Minimal Python foundry

```python
#!/usr/bin/env python3
# @spry.nature foundry after-sqlpage-files

print("-- generated SQL")
print("SELECT 'Hello from a foundry' AS msg;")
```

Make it executable:

```bash
chmod +x src/foundries/hello_foundry.py
```

Spry will run it in the right phase, capture the output, and save it to a store.

#### `FOUNDRY_*` environment variables

Spry provides _only_ `FOUNDRY_*` variables (no legacy names):

| Variable                  | Purpose                                                      | Example                                     |
| ------------------------- | ------------------------------------------------------------ | ------------------------------------------- |
| `FOUNDRY_WORKFLOW_STEP`   | Phase in which the foundry is invoked                        | `before-sqlpage-files`                      |
| `FOUNDRY_SOURCE_JSON`     | JSON describing the foundry file’s location & metadata       | `{...}`                                     |
| `FOUNDRY_CONTEXT_JSON`    | CLI args + workflow context (JSON)                           | `{"phase":"after-sqlpage-files","args":[]}` |
| `FOUNDRY_TARGET_SQLITEDB` | Path to the target SQLite DB, if specified                   | `/home/user/project/dev.sqlite`             |
| `FOUNDRY_OUTPUT_BASENAME` | Base path/name Spry will use for auto-materialized artifacts | `spry.d/auto/report.auto.sql`               |
| `FOUNDRY_DESTROY_CLEAN`   | Indicates a clean operation for cleanable outputs            | `TRUE` or `FALSE`                           |

Debug template: print env

```bash
#!/usr/bin/env bash
# @spry.nature foundry after-sqlpage-files
# Foundry debug script: shows FOUNDRY_* environment

echo "# Foundry environment"
env | grep '^FOUNDRY_' || true
```

Run `./spryctl.ts build` to see what’s set before writing a real foundry.

### 4) Stores — _Where outputs are saved_

Spry writes generated files and keeps the database in sync using stores:

- Filesystem store: `spry.d/auto/*` — generated SQL/JSON/Markdown you can
  inspect or commit.
- Database store: the `sqlpage_files` table — what SQLPage reads to render
  pages.

Stores make builds deterministic (same inputs → same outputs), easy to diff, and
easy for SQLPage to consume.

## Best practices

- Put annotations at the top (`@route.*`, `@spry.entry`) so they’re easy to
  find.
- Use directives near the content they affect—inline for quick inserts, block
  for larger regions.
- Keep generated files under `spry.d/auto/*`; don’t hand-edit them.
- Use `./spryctl.ts ls …` often to catch mistakes early (wrong route, missing
  annotation, etc.).
- Name foundries clearly (`generate_sales.py`, `build_nav.ts`) so teammates know
  what they produce.
- Stay deterministic: the same inputs should produce the same outputs — that’s
  what stores are for.

## Troubleshooting quickies

- Nothing shows up in SQLPage: run `./spryctl.ts` (or `./spryctl.ts sql`) and
  check that your DB’s `sqlpage_files` matches expected content.
- Directive didn’t apply: ensure the directive line is commented and correctly
  formatted (e.g., `-- #include …`).
- Foundry didn’t run: ensure the file is executable (`chmod +x`) and has
  `@spry.nature foundry`. Use the debug script to print `FOUNDRY_*` env.
- Auto-materialized name looks odd: follow the `<basename>.<nature>.<runner>`
  pattern (`report.sql.ts` → `report.auto.sql`).

## Spry engine internals & TypeScript extensibility

> You do not need TypeScript to _operate_ Spry or use the CLI. If you only add
> annotations, directives, and foundries, you’re good to go. TypeScript is
> required only if you want to modify or extend the engine itself.

### Foundries vs “plugins”

- Foundries are _plugin-like_ but do not extend the engine. They only generate
  content that Spry captures and stores. This keeps workflows portable and
  language-agnostic.

### The engine is pluggable (TypeScript)

If you need to enhance Spry’s core behavior, you have two options:

- Composition (recommended): assemble new behaviors by composing smaller parts
  (scanners, stores, workflows). This keeps coupling loose and maintenance easy.
- Inheritance (for tight coupling): extend core classes when you must override
  or deeply integrate behavior.

### Core classes (for engine developers)

> Start with composition to plug custom scanners or stores together. Reach for
> inheritance only if you need tight control over engine behavior.

- `projectPaths(moduleHome, sprySymlinkDest)` Computes path helpers used
  everywhere else. It understands your module’s `src/` tree, a symlinked
  `src/spry` folder, and where SQLPage config lives.
- `Plan` Your application’s wiring. Construct it with `projectPaths(...)`. From
  a `Plan` you get:

  - Stores for writing generated artifacts
  - Scanners for SQLPage files and annotations
  - A `workflow()` to lint, catalog, and orchestrate
- `Workflow` The end-to-end pipeline. It:

  - Lints annotations, directives and foundry setups
  - Catalogs routes and breadcrumbs
  - Runs foundries in phases: `before-sqlpage-files` and/or
    `after-sqlpage-files`
  - Writes an `orchestrated.auto.md` report into `spry.d/auto/`
  - Can clean and rebuild `spry.d/auto/`
- `SQL` Emits SQL for your database. It scans the project for `.sql` and related
  content and produces statements that keep the `sqlpage_files` table in sync.
- `CLI` A Cliffy-based command that exposes:

  - `init` to set up local dev scaffolding (including `sqlpage/sqlpage.json`)
  - `clean` to remove generated artifacts
  - `ls` subcommands to inspect annotations, foundries, routes, and breadcrumbs
  - `sql` to emit various SQL segments or deploy the full set
  - `dev` to watch sources and restart SQLPage on change
- `Annotations` and Zod schemas Parse entry and route annotations from file
  tags. Route annotations drive breadcrumbs and navigation; entry annotations
  describe actions, APIs, foundries, etc.
- `Foundries` Finds executables (`abc.<nature>.<exec>`) and runs them in the
  right phase. Provides a standard env, e.g. `FOUNDRY_CONTEXT_JSON` and
  `FOUNDRY_TARGET_SQLITEDB`, so your scripts can behave deterministically.
- `DirectivesMacros` perform `.sql` file transformations to inject code or other
  content into SQL and (usually) source code files.
- `Store` and `JsonStore` Minimal helpers for writing text/bytes and validated
  JSON to project-relative paths (used for `spry.d/auto/*` and other generated
  outputs).

### More about Foundries

Foundries are where you bring in other languages. Write a script in Python,
Rust, Bash, or anything else, mark it with a @spry annotation, and Spry will
treat it as part of the pipeline. This makes it easy to reuse existing tools or
bring in language-specific strengths without locking you into TypeScript/Deno
everywhere.

- All executable files in the `src` tree are are CapExec candidates.
- Files named like `abc.<nature>.<exec>` are auto-materialization candidates.
- Each foundry's annotation declares when it runs (`before-sqlpage-files`,
  `after-sqlpage-files`, or `both`) and where its outputs go.
- Environment provided:

  - `FOUNDRY_CONTEXT_JSON` includes CLI options and other context.
  - `FOUNDRY_TARGET_SQLITEDB` points to the SQLite DB, if specified.

CapExecs are discovered by a single, simple rule: they are just executable files
as your operating system sees them. If a file has execute permissions
(`chmod +x`) and carries a `@spry.*` entry annotation, Spry will treat it as
part of the orchestration pipeline. This makes CapExecs easy to author in any
language and avoids special registries or configs — the filesystem itself is the
source of truth.

Once discovered, Spry has two ways of handling their outputs:

- Auto-materialization pattern: If your file follows the naming convention
  `<basename>.<nature>.<runner>` (e.g. `my-exec.json.py` or `report.sql.ts`),
  Spry automatically materializes the output into `<basename>.auto.<nature>`
  (e.g. `my-exec.auto.json` or `report.auto.sql`). This ensures predictable file
  placement in `spry.d/auto/` and makes it easy to version or check artifacts
  into your repo.
- Custom materialization: If the file doesn’t follow the auto-materialization
  pattern, Spry simply executes it and trusts the binary to write to its own
  destinations. This is useful for advanced workflows where executables need to
  manage multiple files, or outputs don’t fit the simple one-to-one mapping.

During execution, Spry provides a set of `FOUNDRY_*` environment variables so
your scripts can adapt to project state. For example, `FOUNDRY_CONTEXT_JSON`
includes CLI options and orchestration context, while `FOUNDRY_TARGET_SQLITEDB`
points to the SQLite database when one is in play. These environment variables
let CapExecs plug into the orchestration in a reproducible way, regardless of
language or runtime.

Perfect — here’s a table you can append to the section so CapExec authors have a
quick reference:

---

### Common `FOUNDRY_*` Environment Variables

When Spry runs a CapExec, it sets standard environment variables so your script
can behave consistently and access orchestration context.

| Variable                        | Purpose                                                               | Example Value                               |
| ------------------------------- | --------------------------------------------------------------------- | ------------------------------------------- |
| `FOUNDRY_WORKFLOW_STEP`         | The step / phase in which the CapExec is being invoked.               | `before-sqlpage-files`                      |
| `FOUNDRY_SOURCE_JSON`           | The complete object which idenfies the file system location of CapEx. | `{TODO: ...}`                               |
| `FOUNDRY_CONTEXT_JSON`          | Full orchestration context in JSON (CLI args, workflow phase, paths). | `{"phase":"after-sqlpage-files","args":[]}` |
| `FOUNDRY_TARGET_SQLITEDB`       | Path to the SQLite DB file Spry is operating on (if specified).       | `/home/user/project/dev.sqlite`             |
| `FOUNDRY_MATERIALIZE_BASE_NAME` | If auto-materialized, the path where Spry will write the artifact.    | `spry.d/auto/my-exec.auto.sql`              |
| `FOUNDRY_DESTROY_CLEAN`         | If isCleanable annotation is set and `clean` command is being called  | `TRUE` or `FALSE`                           |

💡 Not all variables are always set. At minimum, you can rely on
`FOUNDRY_CONTEXT_JSON`, `FOUNDRY_WORKFLOW_STEP`, and `FOUNDRY_TARGET_SQLITEDB`.
Auto-materialized executables will also receive `FOUNDRY_OUTPUT_PATH` so you
know exactly where your output will land.

#### Debug template: Inspecting `FOUNDRY_*`

Save this as `debug-foundry.env.sh` somehwere in your project and make it
executable:

```bash
#!/usr/bin/env bash

# @spry.nature foundry
# Debug script to show FOUNDRY_* environment variables

echo "# Debugging CapExec environment"
for var in $(env | grep '^FOUNDRY_'); do
  echo $var
done
```

Run `spryctl.ts build` to confirm which variables are set in your environment
before writing a more complex CapExec.

### Tips

- Keep custom SQL in source files; let Spry manage `spry.d/auto/*`.
- Use route annotations to generate navigation and breadcrumbs without
  hand-crafted trees.
- Use `ls` commands frequently; they quickly reveal misconfigurations before you
  run `build` or `sql deploy`.

That’s it. Point your SQLPage instance at the maintained `sqlpage_files` table,
and use Spry’s CLI to keep it up-to-date during development and deploys.

## Understanding Spry's Entry Points

Spry has two important “entry points” into every project: `projectPaths` and
`Plan`. Together, they define how your project sees its file system and how Spry
orchestrates its workflow.

### `projectPaths`

The `projectPaths` helper builds a map of directories and paths that Spry needs
to know about. You typically call it in your entry point like this:

```ts
o.projectPaths(
  fromFileUrl(import.meta.resolve("./")),
  "../../../lib/std",
);
```

Here’s what it does and why it matters:

- Establishes the module’s “home” It takes the resolved path of your project’s
  entry directory and uses that as the anchor point.
- Defines the `spry` symlink Spry assumes that your project has a `src/spry`
  symlink pointing at the Spry Standard Library (`stdlib`). This gives you
  access to shared orchestration logic and prebuilt SQLPage assets without
  copying them into your repo.
- Sets up auto-generation folders It knows where to create and clean
  `spry.d/auto/` for generated markdown, SQL, and other artifacts.
- Normalizes everything into relative paths All downstream tools (CLI, SQL
  emitter, orchestrator) rely on this normalized set of paths so they can find
  the right files no matter where you invoke the CLI from.

Without `projectPaths`, you would have to hard-code or manually calculate all of
those directories. By centralizing this, Spry makes the rest of the workflow
deterministic and portable.

### `Plan`

The `Plan` class is the core of your project’s orchestration. You extend it in
your own entry point:

```ts
export class EndToEndTestPrime extends o.Plan {
  constructor() {
    super(o.projectPaths(
      fromFileUrl(import.meta.resolve("./")),
      "../../../lib/std",
    ));
  }
}
```

A `Plan`:

- Holds onto the paths from `projectPaths`.
- Provides access to stores, scanners, and orchestrators.
- Defines the workflow lifecycle: lint annotations, catalog routes, run
  foundries, generate SQL, and write reports.
- Serves as the root object for `CLI` or `SQL`—you always pass your `Plan` into
  those so they know what project to operate on.

Think of `Plan` as your project’s “engine room.” It doesn’t run until you hand
it to the CLI or SQL emitter, but it defines what “your project” even means.

### How they fit together

- `projectPaths` sets up the directory structure and symlinks so Spry knows
  where things live.
- `Plan` consumes those paths and exposes the full orchestration pipeline.

Together, they are the two entry points that matter most. In practice:

- Most projects only need to worry about `projectPaths`. The defaults are sane:
  Spry assumes your project content lives in `src/` and that the Spry Standard
  Library (`stdlib`) lives adjacent and is symlinked into `src/spry`.
- Why symlinks? Symlinks make it simple: your project code and the shared stdlib
  can live in separate repos, but at runtime they appear co-located. This keeps
  stdlib content maintained separately while still being “ingested” into the
  SQLPage project.
- The symlinked setup has only been tested on Linux and WSL. Windows and macOS
  do not yet have first-class support for this approach.

So: `projectPaths` + `Plan` = your project’s entry point. Get those two right
and everything else (annotations, foundries, SQL emission, dev loops) falls into
place.
