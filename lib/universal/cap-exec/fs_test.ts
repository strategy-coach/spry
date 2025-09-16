// fs_test.ts
import { assert, assertEquals, assertExists } from "jsr:@std/assert@1";
import { dirname, join } from "jsr:@std/path@1";
import { type PreparedOrExecuted } from "./prepare.ts";
import { type FSSinkBase, type FSStageBase, prepareCapExecsFs } from "./fs.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/* ------------------------------- helpers ------------------------------- */

async function touchFile(path: string) {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, ""); // empty file; not executable; used only for discovery
  await Deno.chmod(path, 0o111);
}

async function readText(path: string): Promise<string> {
  return await Deno.readTextFile(path);
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

/* --------------------------------- tests -------------------------------- */

Deno.test("fs adapter: single-file (pre → sink → post) using standard Linux commands only", async (t) => {
  const base = await Deno.makeTempDir({ prefix: "cecp-fs-single-" });
  try {
    const dir = join(base, "proj");

    // Create only the sink files so the walker discovers them by grammar.
    // We will resolve stage tokens and the sink to PATH commands (no wrapper scripts).
    const sinkName = "greet.[seed].txt.[upper addworld].sh";
    const sinkPath = join(dir, sinkName);
    await touchFile(sinkPath);

    await t.step(
      "prepare+execute writes greet.auto.txt with transformed content",
      async () => {
        const results = await collect(
          prepareCapExecsFs({
            specs: [{ root: dir, baseDir: "/" }],
            mode: "build",
            run: true,
            adapter: {
              // Resolve stage tokens to standard Linux commands via PATH
              // deno-lint-ignore require-await
              resolveStage: async (token, { found }) => {
                const cwd = dirname(
                  (found.item as { path: string }).path,
                );
                switch (token) {
                  case "seed":
                    // Produce "hello" on stdout
                    return {
                      argv: [
                        "sh",
                        "-c",
                        "printf 'hello'",
                      ],
                      cwd,
                    } satisfies FSStageBase;
                  case "upper":
                    // Upper-case stdin
                    return {
                      argv: [
                        "sh",
                        "-c",
                        "tr '[:lower:]' '[:upper:]'",
                      ],
                      cwd,
                    } satisfies FSStageBase;
                  case "addworld":
                    // Append " WORLD\n" (ensure newline)
                    return {
                      argv: [
                        "sh",
                        "-c",
                        "sed 's/$/ WORLD/' && printf '\\n' >/dev/null 2>&1 || true",
                      ],
                      cwd,
                    } satisfies FSStageBase;
                  default:
                    // Identity filter
                    return {
                      argv: ["cat"],
                      cwd,
                    } satisfies FSStageBase;
                }
              },
              // Resolve sink to a standard command
              // deno-lint-ignore require-await
              resolveSink: async ({ found }) => {
                const cwd = dirname(
                  (found.item as { path: string }).path,
                );
                // Identity sink (passes stdin through)
                return {
                  argv: ["cat"],
                  cwd,
                } satisfies FSSinkBase;
              },
            },
          }),
        );

        // Should have at least one executed result
        const executed = results.filter((r) => r.phase === "executed") as Array<
          PreparedOrExecuted<
            Any,
            Any,
            Any,
            Any,
            Any,
            Any,
            Any,
            Any,
            Any
          > & { phase: "executed" }
        >;
        assert(executed.length >= 1);

        const outPath = join(dir, "greet.auto.txt");
        assertExists(outPath);
        const content = await readText(outPath);
        assertEquals(content, "HELLO WORLD");
      },
    );
  } finally {
    try {
      await Deno.remove(base, { recursive: true });
    } catch { /** ignore */ }
  }
});

Deno.test("fs adapter: multi-file (nature+ NDJSON) using standard Linux commands only", async (t) => {
  const base = await Deno.makeTempDir({ prefix: "cecp-fs-multi-" });
  try {
    const dir = join(base, "proj");

    // Sink emits two NDJSON lines describing files to write; no pre/post needed
    const sinkName = "bundle.[seed].txt+.sh";
    const sinkPath = join(dir, sinkName);
    await touchFile(sinkPath);

    await t.step(
      "prepare+execute writes multiple files from NDJSON under sink dir",
      async () => {
        await collect(
          prepareCapExecsFs({
            specs: [{ root: dir, baseDir: "/" }],
            mode: "build",
            run: true,
            adapter: {
              // deno-lint-ignore require-await
              resolveStage: async (token, { found }) => {
                const cwd = dirname(
                  (found.item as { path: string }).path,
                );
                switch (token) {
                  case "seed":
                    // seed content isn't used by sink in this test, but keep as echo to validate stage runs
                    return {
                      argv: [
                        "sh",
                        "-c",
                        "printf 'alpha'",
                      ],
                      cwd,
                    } satisfies FSStageBase;
                  default:
                    return {
                      argv: ["cat"],
                      cwd,
                    } satisfies FSStageBase;
                }
              },
              // deno-lint-ignore require-await
              resolveSink: async ({ found }) => {
                const cwd = dirname(
                  (found.item as { path: string }).path,
                );
                // Print two NDJSON records via printf
                const cmd =
                  `printf '%s\\n' '{"path":"out/one.txt","content":"ONE\\n"}' '{"path":"out/two.txt","content":"TWO\\n"}'`;
                return {
                  argv: ["sh", "-c", cmd],
                  cwd,
                } satisfies FSSinkBase;
              },
            },
          }),
        );

        const p1 = join(dir, "out/one.txt");
        const p2 = join(dir, "out/two.txt");
        assertExists(p1);
        assertExists(p2);
        assertEquals(await readText(p1), "ONE\n");
        assertEquals(await readText(p2), "TWO\n");
      },
    );
  } finally {
    try {
      await Deno.remove(base, { recursive: true });
    } catch {
      /** ignore */
    }
  }
});

Deno.test("fs adapter: dry-run mode (no writes) using standard Linux commands only", async (t) => {
  const base = await Deno.makeTempDir({ prefix: "cecp-fs-dry-" });
  try {
    const dir = join(base, "proj");

    // Sink prints DRY; pre/post unused
    const sinkName = "just.txt.sh";
    await touchFile(join(dir, sinkName));

    await t.step(
      "prepare+execute in dry-run produces no output file",
      async () => {
        await collect(
          prepareCapExecsFs({
            specs: [{ root: dir, baseDir: "/" }],
            mode: "dry-run",
            run: true,
            adapter: {
              // deno-lint-ignore require-await
              resolveSink: async ({ found }) => {
                const cwd = dirname(
                  (found.item as { path: string }).path,
                );
                return {
                  argv: ["sh", "-c", "printf 'DRY\\n'"],
                  cwd,
                } satisfies FSSinkBase;
              },
            },
          }),
        );

        const outPath = join(dir, "just.auto.txt");
        let exists = true;
        try {
          await Deno.stat(outPath);
        } catch {
          exists = false;
        }
        assertEquals(exists, false);
      },
    );
  } finally {
    try {
      await Deno.remove(base, { recursive: true });
    } catch { /** ignore  */ }
  }
});

Deno.test("fs adapter: custom materializer returns a typed ResultPayload (using echo)", async (t) => {
  const base = await Deno.makeTempDir({ prefix: "cecp-fs-custom-mat-" });
  try {
    const dir = join(base, "proj");

    // Sink emits CUSTOM\n
    const sinkName = "x.txt.sh";
    await touchFile(join(dir, sinkName));

    type MyResult = { wrote: string; bytes: number };

    await t.step("materializeSingle returning MyResult", async () => {
      const results = await collect(
        prepareCapExecsFs<
          unknown,
          FSStageBase,
          FSSinkBase,
          unknown,
          unknown,
          MyResult
        >({
          specs: [{ root: dir, baseDir: "/" }],
          mode: "build",
          run: true,
          adapter: {
            // deno-lint-ignore require-await
            resolveSink: async ({ found }) => {
              const cwd = dirname(
                (found.item as { path: string }).path,
              );
              return {
                argv: ["sh", "-c", "printf 'CUSTOM\\n'"],
                cwd,
              } satisfies FSSinkBase;
            },
            materializeSingle: async (
              { output, suggestedPath },
            ) => {
              // accumulate bytes from the stream
              const reader = output.getReader();
              const chunks: Uint8Array[] = [];
              let size = 0;
              while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                chunks.push(value);
                size += value.byteLength;
              }
              const buf = new Uint8Array(size);
              let off = 0;
              for (const c of chunks) {
                buf.set(c, off);
                off += c.byteLength;
              }
              await Deno.mkdir(dirname(suggestedPath), {
                recursive: true,
              });
              await Deno.writeFile(suggestedPath, buf);
              return {
                wrote: suggestedPath,
                bytes: buf.byteLength,
              };
            },
          },
        }),
      );

      const executed = results.find((r) => r.phase === "executed") as
        | (
          & PreparedOrExecuted<
            Any,
            Any,
            Any,
            Any,
            Any,
            Any,
            Any,
            Any,
            MyResult
          >
          & { phase: "executed" }
        )
        | undefined;

      assert(executed);
      const res = executed.result as MyResult;
      assertExists(res.wrote);
      assertEquals(typeof res.bytes, "number");
      assertEquals(await readText(join(dir, "x.auto.txt")), "CUSTOM\n");
    });
  } finally {
    try {
      await Deno.remove(base, { recursive: true });
    } catch { /** ignore */ }
  }
});
