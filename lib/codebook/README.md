# Spry Code Notebook

Spry Codebook (a.k.a. “Spry Code Notebook” or simply “Codebook”) is a tiny,
deterministic core that turns Markdown into a sequence of cells. It reads
frontmatter, splits the document into `markdown` and `code` cells, and exposes
only what’s truly present in the file—no execution, no IDs, no runtime metadata.

This guide explains the mental model, the types, and how to wire `core.ts` into
your workflow.

## What it is (and isn’t)

- Is: a parser that converts Markdown into an immutable `Notebook` with:

  - `fm`: first YAML frontmatter object at the top.
  - `cells`: ordered `markdown` and `code` cells with line ranges.
  - `issues`: structured warnings/errors (e.g., malformed JSON5 fence meta).

- Isn’t: an executor, validator, kernel, or plugin platform. No IDs are
  assigned, no side effects, and no schema validation beyond YAML/JSON5 parsing.

## How Codebook decides cell boundaries

1. YAML frontmatter Only the first YAML node at the head is parsed into `fm` and
   then skipped.

2. Delimiters for `markdown` cells Top-level `## Heading` (H2) and top-level
   horizontal rules (`---`, `***`, `___`) start a new markdown cell. The
   delimiter itself belongs to the following markdown slice.

3. Fenced blocks for `code` cells Every fenced block becomes a `code` cell.

- Language = the fence language (defaults to `"text"` if none).
- Attributes = trailing `{ ... }` JSON5 object parsed from the fence meta; any
  leading meta text becomes `info`.
- Source = fence body as-is.

Everything after frontmatter belongs to exactly one cell.

## Install and import

You’ll need:

- `remark`, `remark-frontmatter`, `remark-gfm`, `remark-stringify`
- `@std/yaml` (YAML parse)
- `json5`
- `mdast-util-to-string`

Import the core in Deno/TypeScript:

```ts
import { normalizeSources, notebooks } from "./core.ts";
import type { Cell, CodeCell, MarkdownCell, Notebook } from "./core.ts";
```

## Quick start

### Parse a single Markdown string

```ts
const md = `---
title: Hello
---
## Section
\`\`\`sql { id: 1 }
SELECT 1;
\`\`\`
`;

for await (const nb of notebooks(md)) {
  console.log(nb.fm.title); // "Hello"
  console.log(nb.cells.length); // 2 (markdown cell for H2, code cell for sql)
}
```

### Parse multiple documents via async iterator

````ts
async function* inputs() {
  yield "# Doc 1\n\n```bash\n echo hi\n```";
  yield "# Doc 2\n\n---\n\nend.";
}

for await (const nb of notebooks(inputs())) {
  console.log(nb.cells.map((c) => c.kind)); // e.g., ["markdown","code"], ...
}
````

### Parse from a ReadableStream<Uint8Array>

````ts
const enc = new TextEncoder();
const stream = new ReadableStream<Uint8Array>({
  start(ctrl) {
    ctrl.enqueue(enc.encode("# From Stream\n\n```json\n{}\n```"));
    ctrl.close();
  },
});

for await (const nb of notebooks(stream)) {
  console.log(nb.cells.map((c) => c.kind)); // ["markdown","code"]
}
````

## Core API (what you’ll actually use)

### `async function* notebooks(input: SourceStream): AsyncGenerator<Notebook<FM, TAttrs>>`

- `input` can be a single `string`, a `ReadableStream<Uint8Array>`, or an async
  (iterable|iterator) of those.
- Yields one `Notebook` per input document.
- Generic parameters:

  - `FM` defaults to `Record<string, unknown>` (the YAML frontmatter shape).
  - `TAttrs` defaults to `Record<string, unknown>` (the per-fence attribute
    shape).

Example with typed attributes:

```ts
type SqlAttrs = { id?: number; name?: string; dryRun?: boolean };

for await (const nb of notebooks<Record<string, unknown>, SqlAttrs>(md)) {
  const cells = nb.cells;
  const sql = cells.find((c) => c.kind === "code" && c.language === "sql");
  if (sql) {
    // sql.attrs is inferred as SqlAttrs
    console.log(sql.attrs.dryRun);
  }
}
```

### `async function* normalizeSources(input: SourceStream): AsyncIterable<string>`

- Exposes the normalization step, yielding complete text documents.
- Useful if you want to pre-process or lint before parsing into notebooks.

## Types you get back

```ts
type IssueDisposition = "error" | "warning";

type Issue =
  | {
    kind: "frontmatter-parse";
    message: string;
    raw: unknown;
    error: unknown;
    startLine?: number;
    endLine?: number;
    disposition: IssueDisposition;
  }
  | {
    kind: "fence-attrs-json5-parse";
    message: string;
    metaText?: string;
    error: unknown;
    startLine?: number;
    endLine?: number;
    disposition: IssueDisposition;
  };

type MarkdownCell = {
  kind: "markdown";
  markdown: string;
  text: string;
  startLine?: number;
  endLine?: number;
};

type CodeCell<TAttrs = Record<string, unknown>> = {
  kind: "code";
  language: string; // or "text" if none
  source: string;
  attrs: TAttrs; // JSON5 from trailing {...} in fence meta
  info?: string; // meta prefix before {...}
  startLine?: number;
  endLine?: number;
};

type Cell<TAttrs = Record<string, unknown>> =
  | CodeCell<TAttrs>
  | MarkdownCell;

type Notebook<
  FM extends Record<string, unknown> = Record<string, unknown>,
  TAttrs extends Record<string, unknown> = Record<string, unknown>,
> = {
  fm: FM;
  cells: readonly Cell<TAttrs>[];
  issues: readonly Issue[];
};
```

Notes:

- All structures are shallow-frozen by the core to discourage mutation.
- `language` falls back to `"text"` for fences without a language.

## Common patterns

### 1) Attribute-safe access per language

If you want typed `attrs` only sometimes, keep `TAttrs` general and narrow at
usage:

```ts
type AnyAttrs = Record<string, unknown>;
type SqlAttrs = { id?: number; name?: string; dryRun?: boolean };

for await (const nb of notebooks<Record<string, unknown>, AnyAttrs>(md)) {
  for (const cell of nb.cells) {
    if (cell.kind === "code" && cell.language === "sql") {
      const sqlAttrs = cell.attrs as SqlAttrs;
      if (sqlAttrs.dryRun) { /* ... */ }
    }
  }
}
```

### 2) Splitting notebooks into execution-ready tasks

```ts
for await (const nb of notebooks(md)) {
  const tasks = nb.cells.flatMap((cell) => {
    if (cell.kind !== "code") return [];
    switch (cell.language) {
      case "sql":
        return [{ engine: "sql", text: cell.source, attrs: cell.attrs }];
      case "bash":
        return [{ engine: "bash", text: cell.source, attrs: cell.attrs }];
      default:
        return [];
    }
  });
  // hand tasks to your executor
}
```

### 3) Linting fence meta and collecting issues

```ts
for await (const nb of notebooks(md)) {
  const warnings = nb.issues.filter((i) => i.disposition === "warning");
  for (const w of warnings) {
    console.warn(`[${w.kind}] ${w.message}`, w);
  }
}
```

## Testing workflow

- Put your synthetic fixtures in the repo (see `core_test-fixture-01.md`).
- In your tests, prefer subtests: load fixture, parse via `notebooks(md)`, and
  assert:

  - frontmatter fields
  - `cells.map(c => c.kind)` sequence
  - specific fences: language, `attrs`, `info`, and `source`
  - line ranges exist where expected
  - `issues` includes malformed JSON5 cases

Minimal subtest example:

```ts
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1.0.6";
import { notebooks } from "./core.ts";

Deno.test("Codebook — basics", async (t) => {
  const md = await Deno.readTextFile(
    new URL("./core_test-fixture-01.md", import.meta.url),
  );

  const outs = [];
  for await (const nb of notebooks(md)) outs.push(nb);
  const nb = outs[0];

  await t.step("fm", () => {
    assertEquals(nb.fm.title, "Core Fixture 01 (Complex)");
  });

  await t.step("cell kinds", () => {
    assertEquals(nb.cells.map((c) => c.kind)[0], "markdown");
  });

  await t.step("sql fence", () => {
    const sql = nb.cells.find((c) => c.kind === "code" && c.language === "sql");
    assert(sql);
    assertMatch(sql.source, /SELECT/);
    assertEquals(sql.attrs, { id: 1, name: "patients", dryRun: true });
  });
});
```

## Performance and limits

- Parsing is single-pass over top-level nodes; cells are accumulated and frozen.
- Shallow immutability is chosen for speed; if you need deep immutability, wrap
  on your side.
- Large files: memory scales with the text and the created mdast tree; measure
  with your content mix.

## FAQ

Q: Why H2 as the delimiter? A: It’s a sensible default for authoring. H2 and HR
are stable “chapter” cuts without over-fragmenting documents. You can wrap Core
with your own delimiter rules if needed.

Q: Can I control the frontmatter schema? A: Core doesn’t validate. Wrap the
output and validate `nb.fm` with your favorite schema library.

Q: How do I add execution? A: Map `code` cells to tasks, feed them to your
executor, and keep outputs alongside your own run metadata. Core remains
parsing-only.

That’s it. Codebook is deliberately small so you can compose the rest of your
stack however you like.
