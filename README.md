# Spry Assembler

Spry Assembler is a lightweight system for organizing, transforming, and
assembling SQL-accepting files (and other framework-light sources) into
consistent, reproducible outputs.

Think of Spry as the assembler on your project team:

- It discovers the files you already have (SQL, Markdown, HTML, scripts, AI
  prompts, etc.).
- It applies instructions you add inside those files (annotations and
  directives).
- It runs helpers (called foundries) that generate extra content when needed.
- It assembles everything into consistent outputs that tools can use — for
  example, a SQLite table for SQL-accepting tools like SQLPage, or a set of
  auto-generated files you can share.

Spry is designed for situations where you don’t already have a full-blown
framework. Languages like Java, JavaScript, and TypeScript have large ecosystems
with many frameworks (Spring, React, Next.js, etc.). But SQL, Bash, and even
“non-traditional” sources like AI prompts or Markdown don’t have much structure.
Spry Assembler fills that gap.

## What Spry Assembler Does

- Keeps things organized — pages, prompts, or scripts can be cataloged with
  routes and metadata.
- Removes repetition — you can reuse layouts, headers, or snippets with a single
  directive.
- Runs your helpers — any script or program (Python, Bash, Rust, Node.js, etc.)
  can act as a _foundry_ that generates SQL, JSON, or Markdown.
- Keeps outputs in sync — your source files plus Spry’s rules always produce the
  same results.
- Supports dev workflow — watch files for changes, rebuild automatically, and
  keep SQL-accepting tools up-to-date.

## Key Concepts

Spry Assembler works around four ideas:

1. Annotations (`@...`) — describe intent.

   - Example: give a file a route, title, or role.
   - They _don’t_ change your file, just add meaning.

   ```sql
   -- @route.path /reports
   -- @route.title Monthly Reports
   ```

2. Directives (`#...` or `!...`) — transform content inline.

   - Insert layouts, snippets, or boilerplate into your files.

   ```sql
   -- #include layout default
   SELECT 'content here';
   ```

3. Foundries — helper programs.

   - Write a Python script, Bash file, or TypeScript module that prints SQL,
     JSON, or Markdown.
   - Mark it with an annotation and Spry will run it at the right time.

   ```python
   #!/usr/bin/env python
   # @spry.nature foundry after-sql-files

   print("SELECT 'Hello from AI prompt' AS msg;")
   ```

   Foundries can even generate outputs from AI prompts or other automated
   sources.

4. Stores — where results go.

   - Filesystem: `spry.d/auto/*` (auto-generated files you can inspect or
     commit).
   - Database: an optional SQLite table that SQL-accepting tools (like SQLPage)
     can read directly.

## Typical Workflow

1. Write your source file (SQL, Markdown, HTML, Bash, or even an AI prompt
   file).

2. Add annotations to describe intent (titles, routes, metadata).

3. Add directives to insert layouts or snippets.

4. (Optional) Add a foundry to generate content.

5. Run Spry Assembler:

   ```bash
   ./spryctl.ts build
   ```

   - It scans your files.
   - Runs any helpers.
   - Assembles everything into consistent stores.

6. Use `./spryctl.ts dev` to watch for changes and auto-rebuild.

## Why It Matters

- For SQL & Bash: finally have a framework-like system for consistency.
- For AI Prompts: treat them like source code, keep them versioned,
  reproducible, and usable in pipelines.
- For Business Analysts: simple tags (`@route`, `#include`) let you describe
  what you want without writing new frameworks.
- For Teams: deterministic outputs mean the same build runs identically across
  machines.

## Example Use Cases

- A data analyst wants to keep a catalog of SQL queries and reports with
  consistent navigation.
- A business team wants AI prompts to be managed like source code, so outputs
  are predictable.
- A junior developer wants to reuse headers, layouts, or snippets across
  multiple SQL or Markdown files.
- A mixed team needs Python scripts and SQL queries to run in the same
  repeatable workflow.

👉 In short: Spry Assembler is a lightweight system that discovers your files,
applies your rules, runs your helpers, and assembles everything into consistent,
framework-like outputs — even when working with languages or sources that don’t
have frameworks of their own.

Would you like me to also draft a one-page “executive” version (very high-level,
no code samples) that you could hand to a product manager or business analyst
without overwhelming them?
