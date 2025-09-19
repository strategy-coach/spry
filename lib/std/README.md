# Orchestrate.ts core workflow and pipeline engine

A tiny “orchestration” framework for SQLPage-based apps (plus other assets)
written in Deno/TypeScript. It scans your project for annotated files, validates
those annotations, builds a navigable route tree and breadcrumbs, seeds a SQLite
table (`sqlpage_files`) with your SQLPage assets, optionally runs “capturable
executables” (CapExecs) to generate artifacts, lints findings, and emits a
consolidated markdown report. It also exposes a CLI to list routes, print
breadcrumbs, generate SQL DDL/inserts, and watch the filesystem to
re-orchestrate on change.

# How it works (high level)

- **Path plumbing (`projectPaths`)** You pass two roots: the current module’s
  directory and a “std” library root. It returns helpers for
  absolute/relative/web paths with special handling for a `src/spry` symlink so
  those files appear under `/spry/...` in web paths.

- **Discovery (Walkers/EncountersSuppliers)** File walkers find candidate
  sources:

  - `sqlPageCandidates`: `*.sql` and `*.json` you want to seed/serve.
  - `annotationCandidates`: files to parse for annotations.
  - `capExecCandidates`: files that look like CapExec scripts.

- **Annotations (Zod-validated)** Two schemas define what you can declare in
  code comments:

  - `spryEntryAnnSchema` (nature of a file: `page`, `partial`, `action`, `api`,
    `sql`, `resource`).
  - `spryRouteAnnSchema` (routing/navigation: `path`, titles/captions, ordering,
    description, elaboration, etc.). The framework parses comments, validates
    with Zod, collects **valid** annotations and **issues**, and can transform
    them via optional hooks.

- **Navigation & breadcrumbs** From route annotations it builds a path tree
  (forest) and breadcrumb structures, with convenience serializers (including a
  JSON Schema form of crumbs if you want to materialize it).

- **Seeding SQLPage (`SqlPageFiles`)** Generates SQL to create/refresh a
  lightweight table:

  ```sql
  CREATE TABLE sqlpage_files (
    path TEXT PRIMARY KEY,
    contents TEXT NOT NULL,
    last_modified TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
  )
  ```

  …and then emits `INSERT` statements for each discovered SQLPage file, mapping
  its filesystem path to a web path.

- **CapExecs integration** Detects “capturable executable” candidates,
  configures an execution context (via env JSON), runs them, and plumbs any
  outputs into your dist store.

- **Linting & reporting** A small lint registry records invalid/missing
  annotations, etc. Results plus orchestration details go into
  `orchestrated.auto.md` via a `MarkdownStore`.

- **Stores**

  - `orchStore`: workspace for orchestration outputs (markdown, etc.).
  - `srcStore`: for writing into your `src` tree when needed.
  - `spryDistStores.polyglot`: a `spry.d/` distribution area where generated
    artifacts (like the report) are written.

- **Extensibility points**

  - Transform functions for entry/route annotations.
  - Replaceable walking roots and file filters.
  - Head/tail SQL hooks (`headSQL()`/`tailSQL()`) to bracket the generated SQL.

# What the entry point you shared does

```ts
export class EndToEndTestPrime extends o.Orchestrator {
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
        await e2e.cli().parse(Deno.args);
    } else {
        await e2e.SQL();
    }
}
```

- It **subclasses** the generic `Orchestrator`, wiring it to the module’s
  directory and your shared `lib/std` tree (so path resolution & symlink logic
  work).
- If you **run it with args**, it launches the **CLI**:

  - `ls` — list annotated entries and issues.
  - `routes` — show route annotations (optionally as JSON).
  - `breadcrumbs` — show crumbs (optionally dump full JSON).
  - `sql` — emit the SQLPage table DDL + seed inserts.
  - `watch` — watch filesystem & re-orchestrate on changes.
- If you run it **without args**, it calls `SQL()` which:

  - prints head SQL (DDL), then the `INSERT`s for each file, then tail SQL. The
    output is ready to pipe into SQLite/Turso/LibSQL to refresh the
    `sqlpage_files` table.

# Typical flow (one run)

1. Walk files → 2) Parse & validate annotations → 3) Build route forest +
   breadcrumbs → 4) Generate SQLPage seed SQL → 5) Run CapExecs (if any) → 6)
   Lint + write `orchestrated.auto.md`.

# Why it’s handy

- Keeps routing/navigation close to the source via comment annotations.
- Gives you a **reproducible build** of your SQLPage content (single SQL
  stream).
- Produces **developer-friendly diagnostics** and a **markdown report**.
- Plays nicely with Deno 2.x (JSR stdlib, Cliffy CLI) and Drizzle ORM (SQLite).

---

# Peer Review Results

Here’s a concise review focused on keeping your power while trimming surface
area and making both inheritance and composition first-class.

What already feels extensible

- Clear seams around discovery, annotation parsing/validation, route building,
  SQL emission, and reporting. Those are natural extension points.
- Zod schemas for annotations and the “transform” hooks you’ve exposed make it
  safe to extend semantics without forking core.
- The CLI wrapper is already modular enough that subcommands can map to pipeline
  stages.

Where to make it more concise without losing power

- Collapse “manager” classes into thin, single-purpose services with tiny
  interfaces. Smaller units + explicit contracts often reduce code and improve
  testability.
- Prefer pure functions for transforms and formatting; keep side effects in a
  single orchestration shell. This “functional core, imperative shell” pattern
  trims complexity.
- Normalize return types across stages to a small set of immutable value objects
  (candidates, annotations, routes, emissions, issues). Fewer shapes → less glue
  code.
- Standardize async iteration. If every stage accepts/returns AsyncIterable of a
  well-known envelope, you can compose pipelines with minimal adapter code.

Make both inheritance and composition first-class

- Define a formal pipeline with named lifecycle stages: discover → parse →
  validate → transform → build routes → emit artifacts → report. Each stage is a
  Strategy with a tiny interface. Orchestrator simply wires strategies.

  - Inheritance path: subclass Orchestrator and override chooseStrategy(stage,
    context) or lifecycle hooks.
  - Composition path: pass a registry or container that provides strategies per
    stage.
- Introduce a micro event bus. Emit events like onFileFound, onAnnotation,
  onCapExecStart/Done, onSQLChunk, onIssue.

  - Inheritance path: override handlers.
  - Composition path: register listeners/plugins.
  - Evented hooks reduce subclassing pressure and let multiple plugins
    cooperate.
- Use capability flags and feature guards. Stages can check capabilities (e.g.,
  “capexec”, “sqlpage”, “routes”) so plugins can opt in without subclassing.

Plugin and extension model

- Plugin contract. A plugin is just an object that can contribute: walkers,
  parsers, validators, transformers, emitters, CLI subcommands, and markdown
  sections. Keep each method optional.
- Registration. Accept plugins via constructor options or a simple config
  manifest. Resolve by name to avoid import cycles.
- Namespacing. Let plugins register new annotation kinds via a schema registry
  keyed by namespace to avoid collisions and keep core lean.

Configuration and DX

- Single source of truth config. Allow a deno.json/ts or spry.config.ts that
  returns your pipeline wiring (plugins, paths, filters, output targets). CLI
  loads it by default; flags override.
- Consistent output contract. Every command supports --json and --quiet.
  Machine-readable outputs make it easy to script and test.
- Dry runs everywhere. Add --dry-run to emit plans without touching the
  filesystem.
- Deterministic ordering. Sort all outputs and logs; show stable IDs for files
  and routes. Determinism is a massive DX win.
- First-class watch mode. Show a compact, actionable delta log per change;
  debounce and batch runs to avoid noisy rebuilds.
- Uniform errors. Route all issues through a single Issue type with code,
  severity, span/location, hint. Small, predictable errors beat verbose ad hoc
  messages.
- Built-in profiling. Add a minimal timer per stage and display a summary table;
  it helps users tune walkers and filters.

Concision in the core types

- Unify “annotation entry” and “route” around a minimal core: id, kind, path,
  meta, source. Everything else hangs off meta dictionaries that plugins can
  extend. Keeps the core type tiny.
- Collapse multiple “store” abstractions into a single output sink interface
  with writeText(path, text) and writeJson(path, obj). Swap implementations
  (filesystem, in-memory, “dist”).

SQL emission and artifact generation

- Replace head/tail functions with an emitter chain. Each emitter receives a
  stream of “assets” and can yield SQL blocks. Concise and more composable than
  scattered printers.
- Make SQLPage seeding a plugin, not a core concern. Core just forwards
  discovered assets; the sqlpage plugin decides DDL shape and inserts.

Discovery and parsing

- One walker interface: returns FileUnit { url, rel, webPath, bytes|text
  accessor, meta }. Keep candidates as filters on that stream rather than
  separate walkers.
- Parser registry keyed by file predicate. The first parser that claims a file
  returns zero or more annotations plus issues. This cuts bespoke glue.

Caching and performance

- Content hash cache. Short-circuit parse/validate/emit when neither bytes nor
  config changed; persist cache under spry.d/. Concise code paths, big speed
  wins.
- Bounded concurrency. Let users set a concurrency limit; default to CPU count.
  Keeps code small and predictable under load.

CLI ergonomics

- Subcommand shape: list, routes, sql, emit, report, watch. Each takes common
  flags: --config, --plugin, --out, --json, --quiet, --dry-run.
- Add a doctor command. It checks environment, paths, and plugin compatibility
  and prints actionable fixes in a compact list.

Testing and contracts

- Golden tests on JSON outputs for each stage. Because outputs are small and
  deterministic, tests stay concise yet robust.
- Contract tests for plugin authors. Provide a tiny test harness that runs a
  plugin against fixtures and asserts only the contract, not internal details.

Documentation and discoverability

- One-page “Extensibility Playbook” describing stages, interfaces, events, and a
  table of which extension is best used when. Teaching the seams reduces code
  and support pings.
- Minimal examples folder with three patterns: subclassing orchestrator, pure
  composition via config, and a hybrid.

Guardrails to keep it simple

- Limit the number of public interfaces. Aim for five or fewer: Walker, Parser,
  Transformer, Emitter, Reporter. Everything else is a data type.
- Keep data immutable and serializable. If it can be dumped as JSON at every
  boundary, your pipeline will stay small and debuggable.
- Prefer conventions over options. Where possible, infer. Only expose flags that
  meaningfully change behavior.

If you adopt the pipeline + event bus + plugin trio, you’ll make the codebase
smaller and clearer while opening more avenues for both subclassing and drop-in
composition. The end result is a lean core that’s easy to reason about, with
most of the “surface area” moved to plugins and tiny, testable strategies.
