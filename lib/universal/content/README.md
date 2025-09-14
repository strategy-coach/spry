# Content Module

Stream-first, type-safe abstractions for working with content in Deno (and
beyond).

The `content` module lets you treat files, streams, and objects as a uniform
`Content` interface: readable/writable streams, metadata, governance, and
extensibility — all in one place.

- ✅ Quick start with `typical.ts` for everyday DX
- ✅ Adapters for filesystem (and pluggable future sources like HTTP, S3, Git)
- ✅ Stream-first: use Web Streams for reading, writing, piping transforms
- ✅ Governance: type-safe metadata, annotations, provenance, permissions
- ✅ Hash utilities: compute digests in memory or as part of a pipeline
- ✅ Extensible: bring your own payloads, annotations, or policies

## Quick Start

Most developers start with [`typical.ts`](./typical.ts), which hides generics
and gives friendly wrappers.

### Read and write a file

```ts
import { openFile, readAllText, writeAllText } from "./mod.ts";

const fc = await openFile("./notes.txt");
await writeAllText(fc, "hello world\n");
const text = await readAllText(fc);
console.log(text); // "hello world"
await fc.close();
```

### Text vs. binary

```ts
import { openBinaryFile, openTextFile } from "./mod.ts";

const txt = await openTextFile("./report.log");
await txt.writeText("new log line\n");

const bin = await openBinaryFile("./blob.bin");
await bin.writeBytes(new Uint8Array([1, 2, 3]));
```

### Governance presets

```ts
import { openFile, withUtf8 } from "./mod.ts";

const fc = await openFile("./data.csv", { governance: withUtf8() });
// Ensures UTF-8, auto-detects text vs. binary by extension.
```

### Builders

```ts
import { fileContentBuilder } from "./mod.ts";

const fc = fileContentBuilder()
  .id("file-123")
  .path("./data.json")
  .known({ nature: "text" })
  .build();
```

## Features

### Unified `Content` API

Every content object (file, HTTP body, Git blob) exposes:

- Identity: `contentId`, `uri`, `scheme`
- Metadata: `size`, `modifiedAt`, `checksum`
- Governance: annotations, provenance, permissions, tags
- Streams:

  - `getReadable()`, `getWritable()`
  - `readText()`, `writeText()`
  - `readBytes()`, `writeBytes()`
  - `pipeThrough([...])`
- Lifecycle: `close()`

### Filesystem Adapter (`fs.ts`)

Adds file-specific fields:

- `path` (absolute path)
- `baseDir`, `rel` (if provided)

Supports:

- Range reads
- Truncate or append writes
- Auto-closing file handles
- Extension-based nature detection

### Governance Builders (`governance.ts`)

Fluent, type-safe builders for governance metadata.

```ts
import { fsGovernance, governance } from "./modgovernance.ts";

const gov = governance()
  .annotations({ reviewer: "alice", status: "approved" })
  .tags("internal")
  .done();

const fsgov = fsGovernance()
  .annotations({ dataset: "2025-Q1" })
  .policy((p) => p.defaultEncoding("utf-8"))
  .done();
```

#### With Zod

```ts
import { z } from "zod";
import { governance } from "./modgovernance.ts";

const ReviewAnnoZ = z.object({
  reviewer: z.string(),
  status: z.enum(["pending", "approved", "rejected"]),
});
type ReviewAnnotations = z.infer<typeof ReviewAnnoZ>;

const gov = governance<ReviewAnnotations>()
  .annotations({ reviewer: "bob", status: "pending" })
  .done();

ReviewAnnoZ.parse(gov.annotations); // runtime validation
```

### Hash Utilities (`hash.ts`)

- `hashBytes(bytes, alg)` → digest of bytes
- `hashReadable(stream, alg)` → digest of a stream (buffers in memory)
- `createHashingTap(alg)` → pass-through transform with digest promise

```ts
import { createHashingTap } from "./modhash.ts";
import { openFile, pipe } from "./modtypical.ts";

const fc = await openFile("./artifact.bin");
const { transform, digest } = createHashingTap("SHA-256");

await pipe(fc, [transform]); // stream file through
console.log(await digest); // final hash hex
await fc.close();
```

## Design Philosophy

- Layered

  - `core.ts` — abstract `Content`, no environment assumptions
  - `fs.ts` — filesystem adapter
  - `typical.ts` — DX wrappers for everyday use
  - `governance.ts` — type-safe metadata builders
  - `hash.ts` — utilities for integrity checks

- Stream-first Everything is a Web Stream for scalability and composability.

- Extensible

  - Bring your own `Payload` type for domain data
  - Replace `Annotations`, `Provenance`, `Permissions`, `Tags` via generics
  - Add new adapters (HTTP, S3, Git) without changing the core

- Safe by default

  - Auto-close file handles
  - Strong typing for governance
  - Optional runtime validation with Zod

- Friendly DX

  - `Typical*` aliases and helpers in `typical.ts`
  - Builders for structured creation
  - Presets (`withUtf8`, `withNoDetect`) for zero-friction setup

## When to Use

- Use `typical.ts` for quick file IO with governance presets.
- Use `fs.ts` when you need low-level file adapter control.
- Use `core.ts` to build your own adapters.
- Use `governance.ts` for structured metadata (and Zod validation).
- Use `hash.ts` for digests and integrity checks in pipelines.

## Roadmap

- Adapters for HTTP, S3, Git
- Streaming hash implementations without buffering
- Governance extensions (access control, retention policies)
- Deeper integration with traversal/walker systems

👉 Start simple with `openFile` and `readAllText`. Scale up to structured
governance, multiple adapters, and streaming pipelines — all without leaving the
same API surface.

## Code Content and Code Comments

The `code.ts` and `code-comments.ts` modules extend the core `content` library
to handle **source code** as content, with a special focus on **comments**.
Together, they make it easy to:

- Detect programming languages from paths, extensions, or shebangs.
- Normalize access to source code as `Content`.
- Parse line/block comments (including nested block comments).
- Extract structured annotations (tags, key/values, YAML, JSON, Spry-style).
- Attach those annotations into the `governance` or `payload` of a content
  object.

### `code.ts`: General-Purpose Code Content

`code.ts` provides the **base layer** for working with source code in the same
way you work with text or binary files:

- **Language registry**: Map file extensions or aliases to `LanguageSpec`.
- **Detection**: `detectLanguageByPath("file.ts")` → TypeScript spec.
- **Opening code files**: `openCodeFile(path)` returns a `CodeFileContent`
  (extends `FileContent`) with `language` metadata attached.
- **Governance extension**: Code files can carry annotations, provenance,
  permissions, etc. just like any other `Content`.

Example:

```ts
import { detectLanguageByPath, openCodeFile } from "./content/code.ts";

const ts = detectLanguageByPath("service.ts");
console.log(ts.id); // "typescript"

const code = await openCodeFile("./src/service.ts");
console.log(code.language.id); // "typescript"
await code.close();
```

### `code-comments.ts`: Comment Parsing and Annotations

This module builds on `code.ts` to focus on **comments** and the metadata they
can contain.

#### Features

- **Scanning comments**:

  - `scanComments(source, lang)` → array of `CommentNode` with text, location,
    fences.
  - `scanCommentsStream(rs, lang)` → streaming FSM scanner across chunk
    boundaries.
  - Supports nested block comments (e.g., Rust, Lua).

- **Annotation extraction**:

  - Tags: `@owner alice`
  - Key/Value: `timeout = 30`
  - YAML fenced blocks:

    ```yaml
    ---
    owner: bob
    route: /api/users
    flags: [beta, dark]
    ---
    ```
  - JSON blocks inside comments
  - Spry-style annotations (`!directive`, `...` fenced blocks)

- **Catalogs**: Collected annotations are wrapped in an `AnnotationCatalog<T>`
  with items, summary counts, and typed values.

- **Governance integration**: Use `annotateCodeContent` to attach extracted
  annotations into the governance or payload of a `CodeFileContent`.

#### Quick Examples

##### Extracting tags and key/values

```ts
import { extractAnnotationsFromText } from "./content/code-comments.ts";
import { getLanguageByIdOrAlias } from "./content/code.ts";

const src = `
// @owner alice
// timeout = 30
`;

const ts = getLanguageByIdOrAlias("typescript")!;
const cat = await extractAnnotationsFromText(src, ts, { tags: true, kv: true });

console.log(cat.items);
/*
[
  { kind: "tag", key: "owner", value: "alice", ... },
  { kind: "kv", key: "timeout", value: "30", ... }
]
*/
```

##### YAML block in comments

```ts
const src = `
/**
 * ---
 * owner: bob
 * route: /api/users
 * ---
 */
`;

const cat = await extractAnnotationsFromText(src, ts, { yaml: true });
const yamlAnno = cat.items.find((i) => i.kind === "yaml");
console.log(yamlAnno?.value);
/*
{ owner: "bob", route: "/api/users" }
*/
```

#### Validating with Zod

```ts
import { z } from "zod";
import { extractAnnotations } from "./content/code-comments.ts";
import { openCodeFile } from "./content/code.ts";

const path = "./service.ts";
const code = await openCodeFile(path);

const Schema = z.object({
  owner: z.string(),
  route: z.string(),
  flags: z.array(z.string()).default([]),
});

const cat = await extractAnnotations(code, {
  yaml: true,
  validate: (item) => {
    if (item.kind === "yaml") return Schema.parse(item.value);
    throw new Error("drop");
  },
});

console.log(cat.items[0].value.owner); // strongly typed "string"
await code.close();
```

#### Attaching into governance

```ts
import { openCodeFile } from "./content/code.ts";
import { annotateCodeContent } from "./content/code-comments.ts";

const code = await openCodeFile("./api/users.ts");
const annotated = await annotateCodeContent(code, { tags: true, kv: true });

console.log(annotated.governance.annotations?.codeAnnotations?.summary);
/*
{
  "tag:owner": 1,
  "kv:timeout": 1
}
*/
```

#### Code Comments Design Notes

- **Normalization**: JSDoc-style `*` prefixes are stripped automatically before
  YAML/JSON parsing, so annotations work in block comments.
- **Streaming FSM**: Comment parsing works on arbitrarily large files without
  buffering them entirely.
- **Extensibility**:

  - Add new languages via `registerLanguage`.
  - Add new annotation extractors by extending `extractAnnotationsFromText`.
  - Attach results to governance or payload depending on your workflow.
- **Type safety**: Validators (e.g., Zod) give strong typing of annotation
  values, while keeping DX-friendly defaults (`unknown` when no validator is
  provided).

### When to Use Code Content

- Use `code.ts` if you just need **language-aware code files** as content.
- Use `code-comments.ts` when you want to **scan, extract, and use annotations
  from source code comments**.
