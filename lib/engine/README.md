# Getting Started with the Spry SQLPage Orchestration Engine

Spry is a tiny “orchestration” framework for SQLPage-based apps (plus other
assets) written in Deno/TypeScript. It scans your project for annotated files,
validates those annotations, builds a navigable route tree and breadcrumbs,
seeds a SQLite table (`sqlpage_files`) with your SQLPage assets, optionally runs
“capturable executables” (CapExecs) to generate artifacts, lints findings, and
emits a consolidated markdown report. It also exposes a CLI to list routes,
print breadcrumbs, generate SQL DDL/inserts, and watch the filesystem to
re-orchestrate on change with a `dev` mode.

## TypeScript Engine vs Polyglot Plugins

Spry itself (the engine) is written in Deno and TypeScript. But the pipeline is
intentionally polyglot. Any step of the workflow can invoke capturable
executables (CapExecs), which are just programs annotated for Spry to discover
and run. These plugins can be written in any language — Bash, Python, Rust, Go,
Java, Node.js, etc. — as long as they follow Spry’s simple conventions and use
environment variables to emit predictable SQL, JSON, or Markdown. Spry is not
opinionated about languages: you use the right tool for each job.

## What Spry gives you

Spry organizes a SQLPage project into a simple pipeline:

- Walk your sources to find SQLPage files and annotations.
- Validate and catalog entry and route annotations.
- Optionally run “cap-execs” (capturable executables) before and/or after
  SQLPage files are generated.
- Emit SQL that maintains a `sqlpage_files` table your SQLPage instance can
  read.
- Provide a dev loop that rebuilds on change and restarts SQLPage.

## Annotations drive behavior

Spry uses _annotations_ (special comments embedded in your files) to attach
structured metadata to SQLPage files and capturable executables. Annotations are
always parsed and validated with Zod schemas so they are predictable and
enforceable.

They act as the control plane for Spry: instead of hard-coding configuration,
you declare intent right next to the file or code that matters. Spry lints and
validates annotations, so misconfigured files show up before you orchestrate.

Spry annotations enable declarative deterministically reproducible workflows.
Content is connected to navigation and execution through lightweight, structured
annotations.

### `@spry` _entry_ annotations

- Purpose: Describe an _entry point_ into your project.
- Where used:
  - Capturable executables (`abc.sql.auto.ts`, `abc.json.auto.ts`, etc.)
  - SQLPage files (`.sql`, `.md`, etc.)

- What they do:
  - Tell Spry how to treat the file during orchestration.
  - Indicate what phase to run in (`before-sqlpage-files`,
    `after-sqlpage-files`, or both).
  - Define outputs (SQL, JSON, Markdown) and where to materialize them.
  - Carry extra metadata for orchestration, e.g. dependencies, purpose, or tags.

Think of `@spry entry` as a declaration of capability — “this file participates
in Spry’s workflow, here’s what it does.”

### `@route` annotations

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

### Side by side

| Aspect         | `@spry.*` tags define _entries_            | `@route.*` tags define navigation              |
| -------------- | ------------------------------------------ | ---------------------------------------------- |
| Focus          | How a file participates in orchestration   | How a page appears in site navigation          |
| Scope          | Executables, SQL, JSON, Markdown           | SQLPage routes (pages, views, menus)           |
| Controls       | Workflow phase, outputs, cap-exec behavior | Path, title, breadcrumbs, parent relationships |
| Think of it as | “Capability declaration”                   | “Navigation declaration”                       |

💡 Spry's annotations are extensible and type-safe. If your project needs other
types of annotations, contact the Spry team.

## Core concepts and classes

- `projectPaths(moduleHome, sprySymlinkDest)` Computes path helpers used
  everywhere else. It understands your module’s `src/` tree, a symlinked
  `src/spry` folder, and where SQLPage config lives.

- `Plan` Your application’s wiring. Construct it with `projectPaths(...)`. From
  a `Plan` you get:

  - Stores for writing generated artifacts
  - Scanners for SQLPage files and annotations
  - A `workflow()` to lint, catalog, and orchestrate

- `Workflow` The end-to-end pipeline. It:

  - Lints annotations and cap-exec setups
  - Catalogs routes and breadcrumbs
  - Runs cap-execs in phases: `before-sqlpage-files` and/or
    `after-sqlpage-files`
  - Writes an `orchestrated.auto.md` report into `spry.d/auto/`
  - Can clean and rebuild `spry.d/auto/`

- `SQL` Emits SQL for your database. It scans the project for `.sql` and related
  content and produces statements that keep the `sqlpage_files` table in sync.

- `CLI` A Cliffy-based command that exposes:

  - `init` to set up local dev scaffolding (including `sqlpage/sqlpage.json`)
  - `clean` to remove generated artifacts
  - `ls` subcommands to inspect annotations, cap-execs, routes, and breadcrumbs
  - `sql` to emit various SQL segments or deploy the full set
  - `dev` to watch sources and restart SQLPage on change

- `Annotations` and Zod schemas Parse entry and route annotations from file
  tags. Route annotations drive breadcrumbs and navigation; entry annotations
  describe actions, APIs, cap-execs, etc.

- `CapExecs` Finds executables (`abc.<nature>.<exec>`) and runs them in the
  right phase. Provides a standard env, e.g. `CAPEXEC_CONTEXT_JSON` and
  `CAPEXEC_TARGET_SQLITEDB`, so your scripts can behave deterministically.

- `Store` and `JsonStore` Minimal helpers for writing text/bytes and validated
  JSON to project-relative paths (used for `spry.d/auto/*` and other generated
  outputs).

## Project layout expectations

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

## Quick start

1. Understand the `projectPaths` function and `Plan` class just for reference
   because they help determine most workflow steps (see next section).

2. Initialize a dev environment (one time)

   - `./spryctl.ts init` Creates `sqlpage/sqlpage.json`, symlinks Spry home
     under `src/spry`, and ensures directories exist.

3. Orchestrate and materialize content (`build`)

   - `./spryctl.ts build` Lints, catalogs, runs cap-execs, regenerates
     `spry.d/auto/*`, and writes `lint-results.auto.md` along with
     `orchestrated.auto.md`.
   - Pay special attention to `spry.d/auto/lint-results.auto.md` because it
     provides diagnostics about the build.

4. Emit SQL once

   - `./spryctl.ts` and `./spryctl.ts sql` (synonyms) print SQL that maintains
     the `sqlpage_files` table. Pipe STDOUT from it into your SQLite DB as
     needed.

5. Develop with live rebuilds

   - `./spryctl.ts dev` Watches for changes, regenerates outputs, and restarts
     SQLPage automatically. Optional: `--clean-db` to recreate the DB on each
     cycle (this is very dangerous, use it with care in special circumstances).

### Common CLI tasks

- Setup

  - `spryctl.ts init --clean` Recreate dev scaffolding.

- Housekeeping

  - `spryctl.ts clean` Remove `spry.d/auto/*` and other generated paths Spry
    owns.

- Listing and inspection

  - `spryctl.ts ls` List discovered SQLPage files (non-migrations).
  - `spryctl.ts ls ann [-j]` Show parsed annotations; `-j` for JSON.
  - `spryctl.ts ls cap-execs [-j]` Show cap-exec candidates.
  - `spryctl.ts ls routes [-j]` Show annotated routes.
  - `spryctl.ts ls breadcrumbs [-j]` Show route breadcrumbs; `-j` dumps the full
    object model.

- SQL emission

  - `spryctl.ts sql head` Emit header SQL segments.
  - `spryctl.ts sql tail` Emit trailer SQL segments.
  - `spryctl.ts sql sqlpage-files` Emit delete/insert statements for
    `sqlpage_files`.
  - `spryctl.ts sql deploy` Emit the full combined SQL used for deployment.

- DB selection

  - Any command accepts `--db-name <file>` to target a specific SQLite database
    name.

### Cap-execs in brief

Cap-execs are where you bring in other languages. Write a script in Python,
Rust, Bash, or anything else, mark it with a @spry annotation, and Spry will
treat it as part of the pipeline. This makes it easy to reuse existing tools or
bring in language-specific strengths without locking you into TypeScript/Deno
everywhere.

- All executable files in the `src` tree are are CapExec candidates.
- Files named like `abc.<nature>.<exec>` are auto-materialization candidates.
- Each cap-exec’s annotation declares when it runs (`before-sqlpage-files`,
  `after-sqlpage-files`, or `both`) and where its outputs go.

- Environment provided:
  - `CAPEXEC_CONTEXT_JSON` includes CLI options and other context.
  - `CAPEXEC_TARGET_SQLITEDB` points to the SQLite DB, if specified.

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

During execution, Spry provides a set of `CAPEXEC_*` environment variables so
your scripts can adapt to project state. For example, `CAPEXEC_CONTEXT_JSON`
includes CLI options and orchestration context, while `CAPEXEC_TARGET_SQLITEDB`
points to the SQLite database when one is in play. These environment variables
let CapExecs plug into the orchestration in a reproducible way, regardless of
language or runtime.

Perfect — here’s a table you can append to the section so CapExec authors have a
quick reference:

---

### Common `CAPEXEC_*` Environment Variables

When Spry runs a CapExec, it sets standard environment variables so your script
can behave consistently and access orchestration context.

| Variable                        | Purpose                                                               | Example Value                               |
| ------------------------------- | --------------------------------------------------------------------- | ------------------------------------------- |
| `CAPEXEC_WORKFLOW_STEP`         | The step / phase in which the CapExec is being invoked.               | `before-sqlpage-files`                      |
| `CAPEXEC_SOURCE_JSON`           | The complete object which idenfies the file system location of CapEx. | `{TODO: ...}`                               |
| `CAPEXEC_CONTEXT_JSON`          | Full orchestration context in JSON (CLI args, workflow phase, paths). | `{"phase":"after-sqlpage-files","args":[]}` |
| `CAPEXEC_TARGET_SQLITEDB`       | Path to the SQLite DB file Spry is operating on (if specified).       | `/home/user/project/dev.sqlite`             |
| `CAPEXEC_MATERIALIZE_BASE_NAME` | If auto-materialized, the path where Spry will write the artifact.    | `spry.d/auto/my-exec.auto.sql`              |
| `CAPEXEC_DESTROY_CLEAN`         | If isCleanable annotation is set and `clean` command is being called  | `TRUE` or `FALSE`                           |

💡 Not all variables are always set. At minimum, you can rely on
`CAPEXEC_CONTEXT_JSON`, `CAPEXEC_WORKFLOW_STEP`, and `CAPEXEC_TARGET_SQLITEDB`.
Auto-materialized executables will also receive `CAPEXEC_OUTPUT_PATH` so you
know exactly where your output will land.

#### Debug template: Inspecting `CAPEXEC_*`

Save this as `debug-cap-exec.env.sh` somehwere in your project and make it
executable:

```bash
#!/usr/bin/env bash

# @spry.nature cap-exec
# Debug script to show CAPEXEC_* environment variables

echo "# Debugging CapExec environment"
for var in $(env | grep '^CAPEXEC_'); do
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
  cap-execs, generate SQL, and write reports.
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
and everything else (annotations, cap-execs, SQL emission, dev loops) falls into
place.
