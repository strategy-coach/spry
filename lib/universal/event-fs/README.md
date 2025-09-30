# Event Driven Reactive File System

This guide shows how to use Spry's Reactive (event-driven) File System wrappers
safely and comfortably. You’ll read/write files, move/copy things around, and
subscribe to typed events that tell you what’s happening.

Everything here is TypeScript-first and designed so it’s hard to make mistakes.

## What is this?

- Drivers do the actual I/O (we provide `memoryDriver()` and `localDriver()`).
- Rooted wrapper (“chroot” style) makes sure all paths live under a specific
  folder.
- Reactive FS wraps a rooted driver and emits well-typed events for every
  operation.
- Path helpers (`rel()`, `child()`, etc.) prevent path bugs (`..`, absolute
  paths, etc.).

## Install / imports

```ts
// Core
import { localDriver, memoryDriver, reactiveFs, rel, rootFs } from "./mod.ts";

// Path helpers (optional extras)
import { child, relativeToRoot, type RootLiteral, toAbs } from "./mod.ts";
```

## Quick Start (In-Memory)

```ts
// 1) Choose a root directory (literal or from config).
const ROOT = "/app" as const satisfies RootLiteral;

// 2) Pick a driver and root it.
const mem = memoryDriver();
const rooted = rootFs(mem, ROOT);

// 3) Make it reactive (eventful).
const rfs = reactiveFs(rooted);

// 4) Paths must be relative to the root (and canonical).
const dir = rel("content");
const file = rel("content/hello.txt");

// 5) Do FS things.
await rfs.mkdir(dir, { recursive: true });
await rfs.write(file, "Hello, world!");
console.log(await rfs.read(file, { as: "text" })); // "Hello, world!"
```

## Quick Start (Local filesystem)

Requires `deno test -A` or at least read/write permissions.

```ts
const ROOT = "/tmp/my-app" as const; // or from env; must be absolute
const rooted = rootFs(localDriver(), ROOT);
const rfs = reactiveFs(rooted);

await rfs.mkdir(rel("logs"), { recursive: true });
await rfs.write(rel("logs/app.log"), "booting...\n");
const stats = await rfs.stat(rel("logs/app.log"));
console.log(stats.size); // e.g., 11
```

## Why “relative-only” paths?

All public APIs take relative paths (to your chosen root), not raw strings. That
means:

- No accidental writes to `/etc/passwd`
- No `..` traversal surprises
- Consistent path normalization across platforms

You’ll construct paths with helpers:

```ts
const dataDir = rel("data");
const img = rel("assets/images/logo.svg");

// Add a child segment safely:
import { child } from "./path-types.ts";
const img2 = child(rel("assets/images"), "banner.png"); // "assets/images/banner.png"
```

> If you have an absolute path (like from Deno APIs), convert with
> `relativeToRoot(abs, ROOT)`.

## Events: see everything

Every operation emits before / after / error events. Subscribe once and learn
what’s happening.

```ts
// Listen to all events
const off = rfs.events.all((type, e) => {
  console.log(type, e.path, "at", new Date(e.at).toISOString());
});

// Listen to specific events, fully typed payloads:
rfs.events.on("write:after", (ev) => {
  console.log("Wrote", ev.path, "bytes:", ev.bytesWritten);
});
```

Common event names:

- `"read:before" | "read:after" | "read:error"`
- `"write:before" | "write:after" | "write:error"`
- `"mkdir:*"`, `"rm:*"`, `"move:*"`, `"copy:*"`, `"list:*"`, `"stat:*"`
- `"watch:change"` (emitted for local changes we cause:
  create/modify/delete/rename)

> You don’t need to manually emit—Reactive FS does it for you.

## Everyday Tasks

### Create folders & write/read files

```ts
await rfs.mkdir(rel("reports/2025"), { recursive: true });

await rfs.write(rel("reports/2025/q3.txt"), "Quarter 3 results");
// read as text
const text = await rfs.read(rel("reports/2025/q3.txt"), { as: "text" });

// read as bytes
const buf = await rfs.read(rel("reports/2025/q3.txt"));
```

### Copy & Move

```ts
await rfs.copy(rel("reports/2025/q3.txt"), rel("reports/2025/q3-backup.txt"), {
  overwrite: true,
});
await rfs.move(
  rel("reports/2025/q3-backup.txt"),
  rel("reports/2025/q3-archived.txt"),
);
```

### Delete

```ts
await rfs.rm(rel("reports/2025"), { recursive: true });
```

### List

```ts
const entries = await rfs.list(rel("assets"));
for (const p of entries) console.log(String(p));
```

### Stats

```ts
const st = await rfs.stat(rel("assets/images/logo.svg"));
if (st.exists && st.isFile) {
  console.log("Logo size:", st.size);
}
```

## Root-safety: how it protects you

All APIs accept only relative paths (brand-typed). Internally we:

- Canonicalize & normalize (POSIX `/`)
- Reject absolute inputs
- Block `..` escapes (and still check containment even if you construct them
  manually)

If you try to escape root:

```ts
const bad = rel("../outside.txt"); // ❌ throws at construction
// or (if you purposely disabled blocking):
const bad2 = parseRel("../outside.txt", { blockDotDot: false });
await rfs.read(bad2); // ❌ throws at runtime containment
```

## Converting between relative and absolute (when needed)

Sometimes you need absolute paths (e.g., error logs), or you got an absolute
path from elsewhere.

```ts
import { relativeToRoot, type RootLiteral, toAbs } from "./path-types.ts";

const ROOT = "/srv/app" as const satisfies RootLiteral;

const abs1 = toAbs(ROOT, rel("assets/logo.svg")); // "/srv/app/assets/logo.svg"
const rel1 = relativeToRoot(abs1, ROOT); // "assets/logo.svg"
```

## Memory vs Local: when to use which?

- Memory (`memoryDriver()`): tests, prototypes, in-process caching.
- Local (`localDriver()`): real files on disk (needs Deno permissions).

Both share the same Reactive FS surface, so you can switch later without
changing your code.

## Error handling & good patterns

- Operations throw on failure, and also emit `*:error` events.
- For audit trails, subscribe to events and log them.
- For “best effort” flows, catch errors and keep going:

```ts
try {
  await rfs.copy(rel("input.csv"), rel("backup/input.csv"));
} catch (err) {
  console.error("Backup failed:", err);
}
```

## Recipes

### Mirror a folder (shallow) within the same root

```ts
async function mirror(
  rfs: ReturnType<typeof reactiveFs>,
  from: string,
  to: string,
) {
  const src = rel(from);
  const dst = rel(to);

  const entries = await rfs.list(src);
  for (const p of entries) {
    const name = String(p).split("/").pop()!;
    await rfs.copy(p, rel(`${String(dst)}/${name}`), { overwrite: true });
  }
}
```

### Filtered event logging (only “content/” writes)

```ts
const off = rfs.events.on("write:after", (ev) => {
  if (String(ev.path).startsWith("content/")) {
    console.log("Updated content file:", String(ev.path));
  }
});
```

### Moving a whole subtree

```ts
await rfs.move(rel("inbox"), rel("archive/inbox-2025"), { overwrite: true });
```

## Common pitfalls (and how we prevent them)

- Using absolute paths → Compiler refuses; APIs take `RelCanonical`.
- Path traversal (`..`) → Blocked by constructors + root containment.
- Platform path separators → Normalized to `/` internally.
- Forgetting to create parent directories → `localDriver.write()` auto-creates
  parents; memory driver requires parent dirs exist (it’s strict and fast—create
  with `mkdir({ recursive: true })`).

## Minimal end-to-end sample

```ts
import { localDriver, reactiveFs, rel, rootFs } from "./reactive-fs.ts";
import type { RootLiteral } from "./path-types.ts";

const ROOT = "/tmp/rfs-demo" as const satisfies RootLiteral;
const rfs = reactiveFs(rootFs(localDriver(), ROOT));

const off = rfs.events.all((t, e) => console.log(t, String(e.path)));

await rfs.mkdir(rel("docs/guides"), { recursive: true });
await rfs.write(rel("docs/guides/readme.md"), "# Hello\nUse Reactive FS!\n");
console.log(await rfs.read(rel("docs/guides/readme.md"), { as: "text" }));

await rfs.copy(rel("docs"), rel("backup/docs"), { overwrite: true });
await rfs.move(rel("docs/guides/readme.md"), rel("docs/README.md"), {
  overwrite: true,
});

await rfs.rm(rel("backup"), { recursive: true });
off();
```

## Test it locally

```bash
deno test -A lib/universal/react-fs/reactive-fs_test.ts
```

## Got questions?

- If you need to mount multiple roots (e.g., `/data` to local, `/cache` to
  memory), we can add a simple mount table wrapper.
- If you need “live” OS watching, we can layer `Deno.watchFs` and re-emit as
  `watch:change` events (the `localDriver` already emits change events for
  operations it performs).

Happy building!
