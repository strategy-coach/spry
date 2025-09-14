// walk_test.ts
import { assert, assertArrayIncludes, assertEquals } from "jsr:@std/assert@1";
import { dirname, join } from "jsr:@std/path@1";
import { createFSAdapter, type FSEncountered, walkFS } from "./mod.ts";

/** Utility: create file, ensuring parent dirs exist. */
async function writeFile(path: string, content: string) {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, content);
}

/** Collect all yielded items from an async generator into an array. */
async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

/** Build a standard temp project tree for tests. */
async function setupTempFS() {
  const base = await Deno.makeTempDir({ prefix: "cecp-walk-" });
  // Files
  const files = [
    "src/a.ts",
    "src/b.ts",
    "src/b.test.ts",
    "src/c.js",
    "src/sub/inner.ts",
    "src/sub/ignore.md",
    "scripts/build.sh",
    ".hidden/hidden.ts",
  ];
  for (const f of files) {
    await writeFile(join(base, f), `// ${f}`);
  }
  // A directory with no files (to ensure dirs aren't emitted)
  await Deno.mkdir(join(base, "emptydir"), { recursive: true });
  return { base, files };
}

/** Clean up a temp directory (best-effort). */
async function cleanup(dir: string) {
  try {
    await Deno.remove(dir, { recursive: true });
  } catch {
    // ignore
  }
}

Deno.test("walkFS: includes/excludes with globs and rel paths", async () => {
  const { base } = await setupTempFS();
  try {
    const entries = await collect(walkFS({
      specs: () => [
        {
          root: "src",
          baseDir: base,
          include: ["**/*.ts"], // include only TS
          exclude: ["**/*.test.ts"], // exclude tests
        },
      ],
    }));
    const rels = entries.map((e) => e.payload.relPath).sort();

    assertArrayIncludes(rels, ["a.ts", "b.ts", "sub/inner.ts"]);
    assertEquals(rels.includes("b.test.ts"), false, "exclude .test.ts");
    assertEquals(rels.includes("../scripts/build.sh"), false);
    assertEquals(rels.includes("../.hidden/hidden.ts"), false);
  } finally {
    await cleanup(base);
  }
});

Deno.test("walkFS: default payload contains relPath", async () => {
  const { base } = await setupTempFS();
  try {
    const items = await collect(
      walkFS({ specs: [{ root: "src", baseDir: base }] }),
    );
    assert(items.length > 0);
    for (const e of items) {
      // payload has relPath by default
      assert(
        typeof (e as FSEncountered).payload.relPath === "string",
        "default payload should include relPath",
      );
    }
  } finally {
    await cleanup(base);
  }
});

Deno.test("walkFS: custom payloadFactory overrides payload type", async () => {
  const { base } = await setupTempFS();
  try {
    type CustomPayload = { size: number; rel: string };
    const adapter = createFSAdapter<CustomPayload>(
      async ({ entry, relPath }) => {
        const info = await Deno.stat(entry.path);
        return { size: info.size, rel: relPath };
      },
    );

    const items = await collect(walkFS<CustomPayload>({
      specs: () => [{
        root: "src",
        baseDir: base,
        include: ["**/*.ts"],
      }],
    }, adapter));
    assert(items.length > 0);
    for (const e of items) {
      assert(typeof e.payload.size === "number");
      assert(typeof e.payload.rel === "string");
    }
  } finally {
    await cleanup(base);
  }
});

Deno.test("walkFS: de-duplicates files across overlapping roots", async () => {
  const { base } = await setupTempFS();
  try {
    const items = await collect(walkFS({
      specs: () => [
        { root: ".", baseDir: base, include: ["src/**/*.ts"] },
        { root: "src", baseDir: base, include: ["**/*.ts"] }, // overlaps above
      ],
    }));
    // Ensure unique absolute paths
    const abs = new Set(items.map((e) => e.item.path));
    assertEquals(abs.size, items.length);
  } finally {
    await cleanup(base);
  }
});

Deno.test("walkFS: invalid root triggers onInvalidSpec and yields nothing for that spec", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "cecp-walk-" });
  try {
    const missing = join(tmp, "nope");
    const hits: string[] = [];

    const items = await collect(walkFS({
      specs: [{ root: missing, baseDir: tmp }],
      onInvalidSpec: ({ reason }) => {
        hits.push(reason);
      },
    }));

    assertEquals(items.length, 0);
    assert(
      hits.some((msg) =>
        msg.includes("does not exist") ||
        msg.includes("not a directory")
      ),
    );
  } finally {
    await cleanup(tmp);
  }
});

Deno.test("walkFS: include all when include globs are omitted", async () => {
  const { base } = await setupTempFS();
  try {
    const items = await collect(
      walkFS({ specs: () => [{ root: "src", baseDir: base }] }),
    );
    // Should include .ts, .js, .md inside src (but not directories)
    const rels = items.map((e) => e.payload.relPath).sort();
    assert(rels.includes("a.ts"));
    assert(rels.includes("b.ts"));
    assert(rels.includes("c.js"));
    assert(rels.includes("sub/inner.ts"));
    assert(rels.includes("sub/ignore.md"));
  } finally {
    await cleanup(base);
  }
});

Deno.test("walkFS: absolute globs behave the same as relative-to-root", async () => {
  const { base } = await setupTempFS();
  try {
    const absGlob = join(base, "src/**/*.ts");
    const items = await collect(walkFS({
      specs: () => [
        { root: "src", baseDir: base, include: [absGlob] },
      ],
    }));
    assert(items.length > 0);
    assert(items.every((e) => e.item.path.endsWith(".ts")));
  } finally {
    await cleanup(base);
  }
});
