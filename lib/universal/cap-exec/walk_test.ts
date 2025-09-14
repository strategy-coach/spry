// walk_test.ts
import { assert, assertArrayIncludes, assertEquals } from "jsr:@std/assert@1";
import { basename, dirname, join } from "jsr:@std/path@1";
import { createFSAdapter } from "../walk/mod.ts";
import { parseCapExecName, walkCapExecs } from "./walk.ts";

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
  const base = await Deno.makeTempDir({ prefix: "cecp-capexec-walk-" });
  // CapExec-ish files
  const files = [
    "src/abc.[one two].sql.[min].ts", // pre+post
    "src/def.sql.ts", // no pre/post
    "src/assets.[pack].sql+.ts", // multi-file (+)
    "src/notcapexec.txt", // non-matching
    "src/ghi.[preA,preB].md.[fmt].py", // different domain/nature
    "src/bad.[].sql.ts", // invalid: empty pre list
  ];
  for (const f of files) {
    await writeFile(join(base, f), `// ${f}`);
  }
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

Deno.test("parseCapExecName: grammar", async (t) => {
  await t.step("parses name with pre, post, and plus", () => {
    const p = parseCapExecName("abc.[one two].sql+.[min gzip].ts");
    assert(p);
    assertEquals(p.basename, "abc");
    assertEquals(p.nature, "sql");
    assertEquals(p.isMulti, true);
    assertEquals(p.domain, "ts");
    assertArrayIncludes(p.preStages, ["one", "two"]);
    assertArrayIncludes(p.postStages, ["min", "gzip"]);
  });

  await t.step("parses simple name without pre/post", () => {
    const p = parseCapExecName("def.sql.ts");
    assert(p);
    assertEquals(p.basename, "def");
    assertEquals(p.nature, "sql");
    assertEquals(p.isMulti, false);
    assertEquals(p.preStages.length, 0);
    assertEquals(p.postStages.length, 0);
  });

  await t.step("rejects empty pre/post blocks", () => {
    // Note: our regex simply won't match `.[].` (empty block)
    const p = parseCapExecName("bad.[].sql.ts");
    assertEquals(p, null);
  });

  await t.step("accepts comma and whitespace separators", () => {
    const p = parseCapExecName("ghi.[preA, preB].md.[fmt  tidy].py");
    assert(p);
    assertEquals(p.preStages, ["preA", "preB"]);
    assertEquals(p.postStages, ["fmt", "tidy"]);
  });
});

Deno.test("walkCapExecs with FS adapter", async (t) => {
  const { base } = await setupTempFS();
  try {
    await t.step(
      "discovers valid CapExec sinks (ignores non-matching)",
      async () => {
        const adapter = createFSAdapter();
        const it = walkCapExecs({
          adapter,
          specs: [{ root: "src", baseDir: base, include: ["**/*"] }],
          selectName: (enc) => basename(enc.item.path),
        });
        const hits = await collect(it);
        const names = hits.map((h) => h.name).sort();

        // Should include the valid CapExec-like files, excluding non-matching and invalid-empty list
        assertArrayIncludes(names, [
          "abc.[one two].sql.[min].ts",
          "def.sql.ts",
          "assets.[pack].sql+.ts",
          "ghi.[preA,preB].md.[fmt].py",
        ]);
        assertEquals(names.includes("notcapexec.txt"), false);
        assertEquals(names.includes("bad.[].sql.ts"), false);
      },
    );

    await t.step("parses fields correctly", async () => {
      const adapter = createFSAdapter();
      const it = walkCapExecs({
        adapter,
        specs: [{ root: "src", baseDir: base }],
        selectName: (enc) => basename(enc.item.path),
      });
      const hits = await collect(it);
      const byName = new Map(hits.map((h) => [h.name, h]));

      const abc = byName.get("abc.[one two].sql.[min].ts")!;
      assertEquals(abc.parsed.basename, "abc");
      assertEquals(abc.parsed.nature, "sql");
      assertEquals(abc.parsed.isMulti, false);
      assertEquals(abc.parsed.domain, "ts");
      assertEquals(abc.parsed.preStages, ["one", "two"]);
      assertEquals(abc.parsed.postStages, ["min"]);

      const assets = byName.get("assets.[pack].sql+.ts")!;
      assertEquals(assets.parsed.isMulti, true);
      assertEquals(assets.parsed.nature, "sql");
      assertEquals(assets.parsed.preStages, ["pack"]);
      assertEquals(assets.parsed.postStages.length, 0);
    });

    await t.step("respects filter predicate", async () => {
      // Filter to only accept *.ts sink files (reject the .py one)
      const adapter = createFSAdapter();
      const it = walkCapExecs({
        adapter,
        specs: [{ root: "src", baseDir: base }],
        selectName: (enc) => basename(enc.item.path),
        filter: (enc) => enc.item.path.endsWith(".ts"),
      });
      const hits = await collect(it);
      const names = hits.map((h) => h.name);

      assertEquals(names.includes("ghi.[preA,preB].md.[fmt].py"), false);
      assertArrayIncludes(names, [
        "abc.[one two].sql.[min].ts",
        "def.sql.ts",
        "assets.[pack].sql+.ts",
      ]);
    });

    await t.step("onInvalidSpec hook is called for bad roots", async () => {
      const adapter = createFSAdapter();
      const missing = join(base, "nope"); // non-existent
      const reasons: string[] = [];

      const it = walkCapExecs({
        adapter,
        specs: [
          { root: "src", baseDir: base }, // valid
          { root: missing, baseDir: base }, // invalid
        ],
        selectName: (enc) => basename(enc.item.path),
        onInvalidSpec: ({ reason }) => {
          reasons.push(reason);
        },
      });

      // Just iterate to trigger walking; don't care about results here.
      await collect(it);
      assert(reasons.length >= 1);
      assert(
        reasons.some((r) =>
          r.includes("does not exist") ||
          r.includes("not a directory")
        ),
      );
    });
  } finally {
    await cleanup(base);
  }
});
