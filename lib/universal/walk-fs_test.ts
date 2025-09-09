import { assert, assertEquals } from "jsr:@std/assert@1";
import { dirname, fromFileUrl, join, relative, resolve } from "jsr:@std/path@1";
import { type Encountered, walkRoots } from "./walk-fs.ts";

function hereDir() {
    return dirname(fromFileUrl(import.meta.url));
}

/** Create a temp directory tree with convenience helpers. */
async function withTempTree(
    build: (root: string) => Promise<void>,
    fn: (root: string) => Promise<void>,
) {
    const tmp = await Deno.makeTempDir({ prefix: "walk-fs_test_" });
    try {
        await build(tmp);
        await fn(tmp);
    } finally {
        // Best-effort cleanup
        await Deno.remove(tmp, { recursive: true }).catch(() => {});
    }
}

async function write(root: string, p: string, contents = "") {
    const full = join(root, p);
    await Deno.mkdir(dirname(full), { recursive: true });
    await Deno.writeTextFile(full, contents);
    return full;
}

Deno.test("walkRoots: includes all files when include is empty", async () => {
    await withTempTree(
        async (root) => {
            await write(root, "a.txt", "A");
            await write(root, "b.md", "B");
            await write(root, "sub/c.ts", "C");
            await Deno.mkdir(join(root, "emptydir"), { recursive: true });
        },
        async (root) => {
            const seen: Encountered[] = [];
            await walkRoots(
                {
                    ctx: { seen },
                    root: [root],
                    baseDir: dirname(fromFileUrl(import.meta.url)),
                },
                (ctx, enc) => {
                    ctx.seen.push(enc);
                },
            );
            // Should emit only files (no directories), so 3 entries
            assertEquals(seen.length, 3);
            const rels = new Set(seen.map((e) => e.relPath));
            assert(rels.has("a.txt"));
            assert(rels.has(join("sub", "c.ts")));
            assert(rels.has("b.md"));

            // All roots should be absolute and equal to `root`
            for (const e of seen) {
                assertEquals(e.root, root);
                assert(e.path.startsWith(root));
                assertEquals(relative(root, e.path), e.relPath);
            }
        },
    );
});

Deno.test("walkRoots: include filters absolute-matched files", async () => {
    await withTempTree(
        async (root) => {
            await write(root, "a.txt", "A");
            await write(root, "sub/b.txt", "B");
            await write(root, "sub/c.md", "C");
        },
        async (root) => {
            const absOnly = resolve(root, "sub/b.txt");
            const seen: string[] = [];
            await walkRoots(
                {
                    ctx: { seen },
                    root: [root],
                    // Absolute include: should emit only b.txt
                    include: [absOnly],
                    baseDir: dirname(fromFileUrl(import.meta.url)),
                },
                (ctx, { path }) => {
                    ctx.seen.push(path);
                },
            );
            assertEquals(seen, [absOnly]);
        },
    );
});

Deno.test("walkRoots: include (relative to root) + exclude", async () => {
    await withTempTree(
        async (root) => {
            await write(root, "keep/a.ts", "A");
            await write(root, "keep/b.ts", "B");
            await write(root, "skip/c.ts", "C");
            await write(root, "skip/d.ts", "D");
            await write(root, "keep/readme.md", "md");
        },
        async (root) => {
            const seenRel: string[] = [];
            await walkRoots(
                {
                    ctx: { seenRel },
                    root: [root],
                    include: ["**/*.ts"], // include only TS files
                    exclude: ["**/skip/**"], // but drop anything in skip/
                    baseDir: dirname(fromFileUrl(import.meta.url)),
                },
                (ctx, { relPath }) => {
                    ctx.seenRel.push(relPath);
                },
            );
            // Only the two TS files under keep/ should remain
            seenRel.sort();
            assertEquals(seenRel, [join("keep", "a.ts"), join("keep", "b.ts")]);
        },
    );
});

Deno.test("walkRoots: overlapping roots de-duplicates absolute paths", async () => {
    await withTempTree(
        async (root) => {
            await write(root, "one.txt", "1");
            await write(root, "two.txt", "2");
        },
        async (root) => {
            const seenAbs = new Set<string>();
            const seenArr: string[] = [];

            await walkRoots(
                {
                    ctx: { seenAbs, seenArr },
                    // Same path twice to simulate perfect overlap
                    root: [root, root],
                    baseDir: dirname(fromFileUrl(import.meta.url)),
                },
                (ctx, { path }) => {
                    ctx.seenArr.push(path);
                    ctx.seenAbs.add(path);
                },
            );

            // Should have emitted each file exactly once.
            assertEquals(seenArr.length, seenAbs.size);
            assertEquals(seenAbs.size, 2);
        },
    );
});

Deno.test("walkRoots: relative root resolution is based on module directory", async () => {
    await withTempTree(
        async (tmpRoot) => {
            // Create a small tree next to this test file's directory,
            // then refer to it RELATIVE to the module that imports walkRoots.
            // We simulate this by creating the tree under a subdir and using a relative root path.
            // (walkRoots resolves relative roots against the module's directory.)
            await write(tmpRoot, "nested/box/file.txt", "x");
        },
        async (tmpRoot) => {
            const moduleDir = hereDir();
            const relFromModule = relative(moduleDir, join(tmpRoot, "nested"));
            const collected: string[] = [];

            await walkRoots(
                {
                    ctx: { collected },
                    root: [relFromModule],
                    baseDir: dirname(fromFileUrl(import.meta.url)),
                },
                (ctx, { path }) => {
                    ctx.collected.push(path);
                },
            );

            // Ensure we saw the file we created
            assertEquals(collected.length, 1);
            assert(collected[0].endsWith(join("nested", "box", "file.txt")));
        },
    );
});
