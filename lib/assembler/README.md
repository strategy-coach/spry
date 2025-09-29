# Spry Assembler

Spry is a tiny orchestration framework for software development artifacts like
SQL-accepting apps and other “source code”-like files that don’t sit inside a
common application framework. It’s written in Deno/TypeScript. If you’re a data
analyst or a junior developer who mainly knows SQL or Bash, think of Spry as the
project manager for your pages and pipelines:

- It reads your intent from special comments (annotations).
- It transforms your files with small inline commands (directives).
- It runs programs that produce content (foundries) and saves the results into
  stores so everything is reproducible.

Many languages and content types already enjoy mature frameworks and scaffolds:
Java (Spring, Quarkus), JavaScript/TypeScript (Next.js, Remix, Deno Fresh),
Markdown/HTML (static site generators). Others, like SQL and Bash, typically
lack full-fledged application frameworks even though teams build significant
“apps” with them. Spry fills that gap by providing orchestration, composition,
and reproducible builds around SQL-accepting tools (for example, tools like
SQLPage) and around lightweight, frameworkless sources such as SQL and Bash.

Note: This document is incomplete, contains some duplicate content and is
disorganized as of September 25, 2025. It needs editing.

TODO: use deps.ts or import maps to unify usage of all libraries instead of
hard-coding imports.

## TypeScript assembler vs polyglot plugins

Spry itself (the assembler) is written in Deno and TypeScript. The pipeline is
intentionally polyglot. Any step can invoke foundries (executables) that Spry
discovers and runs. Foundries can be written in any language—Bash, Python, Rust,
Go, Java, Node.js—so long as they follow Spry’s simple conventions and use
environment variables to emit predictable text files like SQL, JSON, or
Markdown. Use the right tool for each job. Spry is especially helpful for
languages like SQL and Bash that don’t come with opinionated web or app
frameworks out of the box.

## The Spry mental model (4 simple ideas)

- Annotations (`@…`) are blueprints. They describe what a file is or how it
  should appear. They never change your file’s text.
- Directives (`#…` or `!…`) are assembly instructions. They transform your
  file’s text inline (insert layouts, headers, snippets, etc.). These can modify
  your source files within the regions you specify.
- Foundries are production shops (executable files in any language) Spry can run
  to generate SQL/JSON/Markdown.
- Stores are warehouses where Spry materializes or forges outputs (for example,
  `spry.d/auto/*`, and optionally a SQLite or other database tables that
  SQL-accepting tools can read).

Spry works in two phases:

1. Discovery: scan, validate, and plan (read annotations, detect directives and
   foundries).
2. Materialization: apply directives, run foundries, and store results in
   predictable locations.

## What Spry gives you

- A light framework where there isn’t one: orchestration for SQL, Bash, and
  other framework-light polyglot language source code.
- Reduce copy-paste: include headers/footers/layouts with one line.
- Consistent navigation: routes and breadcrumbs can come from annotations.
- Reproducible builds: one command rebuilds everything the same way.
- Polyglot power: foundries can be Python, Bash, Rust, Go, Node.js—whatever
  suits the job.
- Dev loop: watch files, rebuild automatically, and keep your SQL-accepting
  runtime/tool in sync.

## Project layout expectations

The `spryctl.ts init` helper aids in setting up the following.

- Your project has a `src/` folder containing your SQL and other sources plus
  Spry assets.
- Spry is usually symlinked under `src/spry` so Deno’s watcher can follow the
  physical location.
- Generated artifacts land under `spry.d/auto/` (owned by Spry and safe to
  clean).

## Step-by-step: typical workflow

1. Author your content in SQL or other framework-light sources.
2. Add annotations to describe routing and titles or anything you'd like to add
   as "meta" or "frontmatter" for source code.
3. Add directives where you want layouts/snippets.
4. Optionally add foundries for generated content (for example, a script that
   generates SQL or HTML or Markdown or almost any other target).
5. Build with `./spryctl.ts build` to materialize outputs.
6. Use `./spryctl.ts dev` or `watchexec` for auto-rebuild on change.

## Directives

Directives are small inline commands inside comments (often in `.sql` or other
files that don't have their own modules or source code modification
capabilities). Directives can modify the content used by your text- or
SQL-accepting runtime/tool (like SQLPage or browsers). This lets you bring
framework-like composition (layouts, shared snippets, boilerplate) to SQL, HTML,
Markdown and Bash without adopting a heavyweight web framework.

## Foundries

Foundries are language-agnostic generators. They are particularly useful when
your primary sources (SQL, Bash) lack native plugin systems. Spry discovers
foundries by annotation, invokes them in the right phase, and materializes their
outputs in a consistent way.

## Stores

Spry writes generated files and can keep a database in sync using stores:

- Filesystem store: `spry.d/auto/*`—generated SQL/JSON/Markdown you can inspect
  or commit.
- Database store: an optional SQLite table that SQL-accepting tools (for
  example, tools like SQLPage) can read to render pages or views.

## Positioning: where Spry fits

- For languages with rich frameworks (Java/Spring, JS/TS web frameworks,
  Markdown/HTML SSGs), continue using those ecosystems and bring Spry in only if
  you need orchestration across mixed sources or want reproducible foundry
  outputs that feed a SQL-accepting target.
- For languages without full frameworks (SQL, Bash, and similar), use Spry as
  the missing orchestration layer to standardize structure, composition, and
  build outputs without adopting an unrelated web framework.
