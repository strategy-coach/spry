import { assert, assertEquals } from "jsr:@std/assert@1.0.8";

import { localDriver } from "./local-fs.ts";
import { memoryDriver } from "./memory-fs.ts";
import { parseRel, relativeToRoot, RootLiteral, toAbs } from "./path.ts";
import { reactiveFs, rel, rootFs } from "./reactive-fs.ts";

// Helper: safely coerce a runtime string to RootLiteral after validating it's absolute.
function asRoot(s: string): RootLiteral {
  if (!s.startsWith("/")) throw new Error(`Root must be absolute, got: ${s}`);
  return s as RootLiteral;
}

async function withTempDir(fn: (root: RootLiteral) => Promise<void>) {
  const tmp = await Deno.makeTempDir({ prefix: "reactive-fs-" });
  try {
    await fn(asRoot(tmp));
  } finally {
    try {
      await Deno.remove(tmp, { recursive: true });
    } catch { /* ignore */ }
  }
}

Deno.test("Reactive FS — Memory driver + Rooted wrapper + Events", async (t) => {
  const ROOT = "/app" as const satisfies RootLiteral;
  const rfs = reactiveFs(rootFs(memoryDriver(), ROOT));

  const events: string[] = [];
  const off = rfs.events.all((type, e) => {
    events.push(`${type}:${e.path}`);
  });

  await t.step("mkdir + write/read text + list/stat", async () => {
    const dir = rel("content");
    const file = rel("content/hello.txt");
    await rfs.mkdir(dir, { recursive: true });
    await rfs.write(file, "Hello Memory!");
    const txt = await rfs.read(file, { as: "text" });
    assertEquals(txt, "Hello Memory!");
    const entries = await rfs.list(dir);
    assertEquals(entries.map(String), [String(file)]);
    const st = await rfs.stat(file);
    assert(st.exists && st.isFile);
  });

  await t.step("write/read binary", async () => {
    const file = rel("bin/data.bin");
    await rfs.mkdir(rel("bin"), { recursive: true });
    const bytes = crypto.getRandomValues(new Uint8Array(64));
    await rfs.write(file, bytes);
    const roundtrip = await rfs.read(file);
    assert(roundtrip instanceof Uint8Array);
    assertEquals((roundtrip as Uint8Array).byteLength, 64);
  });

  await t.step("move/copy/rm with directories (recursive)", async () => {
    await rfs.mkdir(rel("tree/a/b"), { recursive: true });
    await rfs.write(rel("tree/a/b/file.txt"), "x");
    await rfs.copy(rel("tree/a"), rel("tree/copy"), { overwrite: true });
    await rfs.move(rel("tree/copy"), rel("tree/moved"));
    await rfs.rm(rel("tree"), { recursive: true });
    const st = await rfs.stat(rel("tree"));
    assertEquals(st.exists, false);
  });

  await t.step("root escape attempts blocked by rooted driver", async () => {
    // Construct a rel containing ".." by relaxing policy in parseRel.
    // resolveAbs() MUST throw because join(root, rel) would escape after normalization.
    const dangerous = parseRel("../etc/passwd", { blockDotDot: false });
    let threw = false;
    try {
      // Invoke through public API to exercise full pipeline.
      await rfs.read(dangerous);
    } catch {
      threw = true;
    }
    assert(threw);
  });

  await t.step("events captured", () => {
    assert(events.some((s) => s.startsWith("mkdir:before:")));
    assert(events.some((s) => s.startsWith("write:before:")));
    assert(events.some((s) => s.startsWith("write:after:")));
    assert(events.some((s) => s.startsWith("read:before:")));
    assert(events.some((s) => s.startsWith("read:after:")));
    assert(events.some((s) => s.startsWith("list:before:")));
    assert(events.some((s) => s.startsWith("list:after:")));
    assert(events.some((s) => s.startsWith("move:before:")));
    assert(events.some((s) => s.startsWith("move:after:")));
    assert(events.some((s) => s.startsWith("copy:before:")));
    assert(events.some((s) => s.startsWith("copy:after:")));
    assert(events.some((s) => s.startsWith("rm:before:")));
    assert(events.some((s) => s.startsWith("rm:after:")));
    assert(events.some((s) => s.startsWith("watch:change:")));
  });

  off();
});

Deno.test("Reactive FS — Local driver (temp root) + Rooted wrapper + edge cases", async (t) => {
  await withTempDir(async (tmpRoot) => {
    const ROOT = tmpRoot;
    const rfs = reactiveFs(rootFs(localDriver(), ROOT));

    const ev: string[] = [];
    const off = rfs.events.all((type, e) => {
      ev.push(`${type}:${e.path}`);
    });

    await t.step("mkdir (recursive) and write/read text", async () => {
      await rfs.mkdir(rel("a/b/c"), { recursive: true });
      await rfs.write(rel("a/b/c/hello.txt"), "Local Hello");
      const got = await rfs.read(rel("a/b/c/hello.txt"), { as: "text" });
      assertEquals(got, "Local Hello");
    });

    await t.step("write/read binary, list children, stat", async () => {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      await rfs.write(rel("a/b/c/bin.dat"), bytes);
      const back = await rfs.read(rel("a/b/c/bin.dat"));
      assert(back instanceof Uint8Array);
      assertEquals((back as Uint8Array).byteLength, 32);

      const list = await rfs.list(rel("a/b/c"));
      const names = list.map((p) => String(p)).sort();
      assert(names.includes("a/b/c/hello.txt"));
      assert(names.includes("a/b/c/bin.dat"));

      const st = await rfs.stat(rel("a/b/c"));
      assert(st.exists && st.isDir);
    });

    await t.step(
      "move (overwrite=false/true) and copy directories",
      async () => {
        await rfs.mkdir(rel("dst"), { recursive: true });
        await rfs.copy(rel("a"), rel("dst/a"), { overwrite: true });
        await rfs.move(rel("dst/a"), rel("dst/moved-a"), {
          overwrite: true,
        });
        const st = await rfs.stat(rel("dst/moved-a/b/c/hello.txt"));
        assert(st.exists && st.isFile);
      },
    );

    await t.step("rm recursive directory", async () => {
      await rfs.rm(rel("dst"), { recursive: true });
      const st = await rfs.stat(rel("dst"));
      assertEquals(st.exists, false);
    });

    await t.step("root escape attempts blocked (..)", async () => {
      const p = parseRel("../../outside", { blockDotDot: false });
      let threw = false;
      try {
        await rfs.read(p);
      } catch {
        threw = true;
      }
      assert(threw);
    });

    await t.step("abs/rel conversions stable", () => {
      const relPath = rel("a/b/c/hello.txt");
      const absPath = toAbs(ROOT, relPath);
      const back = relativeToRoot(absPath, ROOT);
      assertEquals(String(back), String(relPath));
    });

    await t.step("events sanity", () => {
      assert(ev.some((s) => s.startsWith("mkdir:before:")));
      assert(ev.some((s) => s.startsWith("write:after:")));
      assert(ev.some((s) => s.startsWith("copy:after:")));
      assert(ev.some((s) => s.startsWith("move:after:")));
      assert(ev.some((s) => s.startsWith("rm:after:")));
      assert(ev.some((s) => s.startsWith("stat:after:")));
    });

    off();
  });
});
