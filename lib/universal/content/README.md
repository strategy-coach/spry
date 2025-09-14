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
import { openFile, withUtf8 } from "./content/.ts";

const fc = await openFile("./data.csv", { governance: withUtf8() });
// Ensures UTF-8, auto-detects text vs. binary by extension.
```

### Builders

```ts
import { fileContentBuilder } from "./content/.ts";

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
import { fsGovernance, governance } from "./content/governance.ts";

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
import { governance } from "./content/governance.ts";

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
import { createHashingTap } from "./content/hash.ts";
import { openFile, pipe } from "./content/typical.ts";

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
