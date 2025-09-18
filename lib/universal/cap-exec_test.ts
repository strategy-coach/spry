import { CapExec } from "./cap-exec.ts";
import { join } from "jsr:@std/path@^1.0.6";
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";

function td(u8: Uint8Array) {
    return new TextDecoder().decode(u8);
}

Deno.test("CapExec (executable-centric): core behaviors", async (t) => {
    const deno = Deno.execPath();

    // helper: write a temp text file
    function tmpFile(dir: string, name: string, text: string) {
        const p = join(dir, name);
        Deno.writeTextFileSync(p, text);
        return p;
    }

    await t.step(
        "default materialize to candidate outPath (3 jobs)",
        async () => {
            const dir = await Deno.makeTempDir();

            const exec = CapExec.create()
                .withCandidates([
                    {
                        cmd: deno,
                        args: ["eval", "console.log('one')"],
                        outPath: join(dir, "one.auto"),
                        label: "one",
                    },
                    {
                        cmd: deno,
                        args: ["eval", "console.log('two')"],
                        outPath: join(dir, "two.auto"),
                        label: "two",
                    },
                    {
                        cmd: deno,
                        args: ["eval", "console.log('three')"],
                        outPath: join(dir, "three.auto"),
                        label: "three",
                    },
                ])
                .withConcurrency(3);

            const results = await exec.run();
            if (results.length !== 3) throw new Error("expected 3 results");

            if (
                Deno.readTextFileSync(join(dir, "one.auto")).trim() !== "one"
            ) throw new Error("bad content: one");
            if (
                Deno.readTextFileSync(join(dir, "two.auto")).trim() !== "two"
            ) throw new Error("bad content: two");
            if (
                Deno.readTextFileSync(join(dir, "three.auto")).trim() !==
                    "three"
            ) throw new Error("bad content: three");
        },
    );

    await t.step("resultMapper + custom materialize (memory)", async () => {
        const seen: Record<string, string> = {};
        const exec = CapExec.create()
            .withCandidates([{
                cmd: deno,
                args: ["eval", "console.log('hello')"],
                label: "hi",
            }])
            .withResultMapper((raw) => td(raw.stdoutRaw).toUpperCase()) // R = string
            .withMaterialize((_c, mapped, _outPath) => {
                seen["hi"] = mapped;
            });

        await exec.run();
        if (seen["hi"]?.trim() !== "HELLO") {
            throw new Error("resultMapper/materialize failed");
        }
    });

    await t.step("filter + pre/post flight ordering", async () => {
        const log: string[] = [];
        const dir = await Deno.makeTempDir();
        const keep = {
            cmd: deno,
            args: ["eval", "console.log('K')"],
            label: "keep",
            outPath: join(dir, "k.auto"),
        };
        const skip = {
            cmd: deno,
            args: ["eval", "console.log('S')"],
            label: "skip",
            outPath: join(dir, "s.auto"),
        };

        const exec = CapExec.create()
            .withCandidates([keep, skip])
            .withFilter((c) => c.label === "keep")
            .withPreflight(() => {
                log.push("pre");
            })
            .withPostflight(() => {
                log.push("post");
            });

        const res = await exec.run();
        if (res.length !== 1) throw new Error("filter failed to exclude");
        if (log.join(",") !== "pre,post") {
            throw new Error("pre/post order wrong");
        }
        if (Deno.readTextFileSync(join(dir, "k.auto")).trim() !== "K") {
            throw new Error("materialize content wrong");
        }
        let created = true;
        try {
            Deno.lstatSync(join(dir, "s.auto"));
        } catch {
            created = false;
        }
        if (created) {
            throw new Error("skip candidate should not produce output");
        }
    });

    await t.step("concurrency cap with progress & events", async () => {
        const dir = await Deno.makeTempDir();
        const candidates = Array.from({ length: 8 }, (_, i) => ({
            cmd: deno,
            args: [
                "eval",
                "const s=`" + i +
                "`; await new Promise(r=>setTimeout(r,25)); console.log(s);",
            ],
            outPath: join(dir, `c${i}.auto`),
            label: `c${i}`,
        }));

        let active = 0;
        let maxActive = 0;
        let progressSeen = 0;

        const exec = CapExec.create()
            .withCandidates(candidates)
            .withConcurrency(3)
            .on("start", () => {
                active++;
                maxActive = Math.max(maxActive, active);
            })
            .on("success", () => {
                active--;
            })
            .on("error", () => {
                active--;
            })
            .on("progress", () => {
                progressSeen++;
            });

        const results = await exec.run();
        if (maxActive > 3) {
            throw new Error(`concurrency exceeded: ${maxActive}`);
        }
        if (results.length !== candidates.length) {
            throw new Error("not all tasks completed");
        }
        if (progressSeen < candidates.length) {
            throw new Error("insufficient progress events");
        }
    });

    await t.step(
        "retry with backoff + custom retryOn (force exactly 3 attempts on success)",
        async () => {
            let attempts = 0;

            const exec = CapExec.create()
                .withCandidates([{
                    cmd: deno,
                    args: ["eval", "console.log('R')"],
                    label: "r",
                }])
                .withRetry({
                    times: 3,
                    backoff: (a) => a * 5,
                    retryOn: ({ attempt }) => {
                        attempts = attempt;
                        return attempt < 3;
                    },
                });

            const results = await exec.run();
            if (results.length !== 1) throw new Error("retry run incomplete");
            if (attempts !== 3) {
                throw new Error(`expected 3 attempts, got ${attempts}`);
            }
        },
    );

    await t.step("dry-run (no files created, result null)", async () => {
        const dir = await Deno.makeTempDir();
        const out = join(dir, "dry.auto");

        const exec = CapExec.create()
            .withCandidates([{
                cmd: deno,
                args: ["eval", "console.log('DRY')"],
                outPath: out,
            }])
            .withDryRun();

        const results = await exec.run();
        let created = true;
        try {
            Deno.lstatSync(out);
        } catch {
            created = false;
        }
        if (created) throw new Error("dry-run should not write files");
        if (results.length !== 1 || results[0].result !== null) {
            throw new Error("dry-run should return null result");
        }
    });

    await t.step("env propagation to all jobs", async () => {
        const dir = await Deno.makeTempDir();
        const out = join(dir, "env.auto");

        const exec = CapExec.create()
            .withEnv<{ FOO: string }>({ FOO: "bar" }, { inherit: false })
            .withCandidates([{
                cmd: deno,
                args: ["eval", "console.log(Deno.env.get('FOO')||'')"],
                outPath: out,
            }]);

        await exec.run();
        if (Deno.readTextFileSync(out).trim() !== "bar") {
            throw new Error("env not applied to job");
        }
    });

    await t.step(
        "runSettled returns rejected for failing command",
        async () => {
            const exec = CapExec.create()
                .withCandidates([{ cmd: deno, args: ["eval", "Deno.exit(3)"] }])
                .withRetry({ times: 1 });

            const settled = await exec.runSettled();
            if (settled.length !== 1) {
                throw new Error(
                    "settled length mismatch",
                );
            }
            if (settled[0].status !== "rejected") {
                throw new Error(
                    "expected rejection",
                );
            }
        },
    );

    await t.step(
        "prepend/append args composition (Deno.args inside eval)",
        async () => {
            const dir = await Deno.makeTempDir();
            const out = join(dir, "pos.auto");

            const code = `
      // print the args visible to this eval script
      console.log(JSON.stringify(Deno.args));
    `.trim();

            // final argv: [ "eval", code, ...candidate.args, "TAIL" ]
            const exec = CapExec.create()
                .withPrependArgs("eval", code)
                .withAppendArgs("TAIL")
                .withCandidates([{
                    cmd: deno,
                    args: ["A", "B"],
                    outPath: out,
                }]);

            await exec.run();
            const arr = JSON.parse(
                Deno.readTextFileSync(out).trim(),
            ) as string[];
            const expect = ["A", "B", "TAIL"];
            if (
                arr.length !== expect.length ||
                arr.some((v, i) => v !== expect[i])
            ) {
                throw new Error(
                    `args composition failed: got ${
                        JSON.stringify(arr)
                    } expected ${JSON.stringify(expect)}`,
                );
            }
        },
    );

    await t.step("per-candidate cwd & stdin override", async () => {
        const dir = await Deno.makeTempDir();
        const file = tmpFile(dir, "msg.txt", "HELLO");
        const out = join(dir, "stdin.auto");

        // global stdin set, but candidate overrides with its own (file content)
        const readFileCode = `
      const buf = await new Response(Deno.stdin.readable).text();
      console.log(buf.trim());
    `.trim();

        const exec = CapExec.create()
            .withStdin("GLOBAL") // will be ignored for this candidate because it sets its own stdin
            .withCwd(dir)
            .withCandidates([{
                cmd: deno,
                args: ["eval", readFileCode],
                outPath: out,
                // candidate-specific stdin comes from reading the file (simulate manual piping)
                stdin: (async function* () {
                    yield new TextEncoder().encode(Deno.readTextFileSync(file));
                })(),
            }]);

        await exec.run();
        if (Deno.readTextFileSync(out).trim() !== "HELLO") {
            throw new Error("candidate-specific stdin not used");
        }
    });
});

async function exists(p: string) {
    try {
        await Deno.lstat(p);
        return true;
    } catch {
        return false;
    }
}

async function writeDenoGenScript(
    dir: string,
    name: string,
    lines: Array<{ path: string; content: string }>,
) {
    const p = join(dir, name);
    const body = [
        "#!/usr/bin/env -S deno run",
        // emit JSONL lines
        ...lines.map((l) =>
            `console.log(${JSON.stringify(JSON.stringify(l))});`
        ),
        "",
    ].join("\n");
    await Deno.writeTextFile(p, body);
    await Deno.chmod(p, 0o755);
    return p;
}

Deno.test("CapExec (multi-file generator): behaviors", async (t) => {
    await t.step(
        "detect via second-to-last extension (abc.sql+.ts) and write files",
        async () => {
            const dir = await Deno.makeTempDir();
            const rel1 = "gen/a.txt";
            const rel2 = "gen/nested/b.txt";
            const script = await writeDenoGenScript(dir, "emit.sql+.ts", [
                { path: rel1, content: "A" },
                { path: rel2, content: "B" },
            ]);

            const generated: string[] = [];
            let materializedPaths: string[] | undefined;

            const res = await CapExec.create()
                .withCandidates([{ cmd: script, cwd: dir }])
                .on("generated", (_c, file) => {
                    generated.push(String(file)); // coerce to string and return void
                })
                .on("materialized", (_c, out) => {
                    if (Array.isArray(out)) materializedPaths = out as string[];
                })
                .run();

            // verify results array
            if (res.length !== 1) throw new Error("expected 1 result");
            if (!res[0].generatedPaths || res[0].generatedPaths.length !== 2) {
                throw new Error("expected 2 generated paths in result");
            }

            // verify files exist with correct content
            const out1 = join(dir, rel1);
            const out2 = join(dir, rel2);
            if (await Deno.readTextFile(out1) !== "A") {
                throw new Error("content A mismatch");
            }
            if (await Deno.readTextFile(out2) !== "B") {
                throw new Error("content B mismatch");
            }

            // events
            if (generated.length !== 2) {
                throw new Error("expected 2 'generated' events");
            }
            if (!materializedPaths || materializedPaths.length !== 2) {
                throw new Error("expected 'materialized' array of 2");
            }
        },
    );

    await t.step(
        "detect via basename (abc+.sql.ts) and write absolute+relative files",
        async () => {
            const dir = await Deno.makeTempDir();
            const abs = join(dir, "abs.txt");
            const rel = "rel.txt";
            const script = await writeDenoGenScript(dir, "emit+.sql.ts", [
                { path: abs, content: "ABS" },
                { path: rel, content: "REL" },
            ]);

            const res = await CapExec.create()
                .withCandidates([{ cmd: script, cwd: dir }])
                .run();

            // verify generatedPaths recorded
            const gp = res[0].generatedPaths!;
            if (gp.length !== 2) throw new Error("expected 2 generated paths");
            if (!gp.some((p) => p === abs)) {
                throw new Error("absolute path missing in generatedPaths");
            }
            if (
                !gp.some((p) =>
                    p.endsWith("/rel.txt") || p.endsWith("\\rel.txt")
                )
            ) {
                throw new Error("relative path missing in generatedPaths");
            }

            // verify files
            if (await Deno.readTextFile(abs) !== "ABS") {
                throw new Error("ABS content mismatch");
            }
            if (await Deno.readTextFile(join(dir, rel)) !== "REL") {
                throw new Error("REL content mismatch");
            }
        },
    );

    await t.step("malformed JSONL line => rejected in runSettled", async () => {
        const dir = await Deno.makeTempDir();
        const scriptPath = join(dir, "bad.sql+.ts");
        const body = [
            "#!/usr/bin/env -S deno run",
            `console.log("{\\"path\\": \\"ok.txt\\", \\"content\\": \\"OK\\"}");`,
            `console.log("NOT JSON");`, // malformed
            "",
        ].join("\n");
        await Deno.writeTextFile(scriptPath, body);
        await Deno.chmod(scriptPath, 0o755);

        const settled = await CapExec.create()
            .withCandidates([{ cmd: scriptPath, cwd: dir }])
            .runSettled();

        if (settled.length !== 1) throw new Error("settled length mismatch");
        if (settled[0].status !== "rejected") {
            throw new Error("expected rejection for malformed JSONL");
        }
    });

    await t.step(
        "dry-run generator => no files written, generatedPaths empty",
        async () => {
            const dir = await Deno.makeTempDir();
            const script = await writeDenoGenScript(dir, "emit.sql+.ts", [
                { path: "x.txt", content: "X" },
                { path: "y.txt", content: "Y" },
            ]);

            const results = await CapExec.create()
                .withCandidates([{ cmd: script, cwd: dir }])
                .withDryRun()
                .run();

            if (
                !results[0].generatedPaths ||
                results[0].generatedPaths.length !== 0
            ) {
                throw new Error("dry-run should return empty generatedPaths");
            }

            // ensure no files created
            if (await exists(join(dir, "x.txt"))) {
                throw new Error(
                    "x.txt should not exist in dry-run",
                );
            }
            if (await exists(join(dir, "y.txt"))) {
                throw new Error(
                    "y.txt should not exist in dry-run",
                );
            }
        },
    );

    await t.step(
        "reject on missing fields (must have both path and content)",
        async () => {
            const dir = await Deno.makeTempDir();
            const scriptPath = join(dir, "missing.sql+.ts");
            const body = [
                "#!/usr/bin/env -S deno run",
                `console.log("{\\"path\\": \\"ok.txt\\", \\"content\\": \\"OK\\"}");`,
                `console.log("{\\"path\\": \\"bad.txt\\"}");`, // missing content
                "",
            ].join("\n");
            await Deno.writeTextFile(scriptPath, body);
            await Deno.chmod(scriptPath, 0o755);

            const settled = await CapExec.create()
                .withCandidates([{ cmd: scriptPath, cwd: dir }])
                .runSettled();

            if (settled[0].status !== "rejected") {
                throw new Error(
                    "expected rejection for missing content",
                );
            }
        },
    );
});

Deno.test("CapExec.capExecCandidacy & CapExec.isExecutable (updated rules)", async (t) => {
    const dir = await Deno.makeTempDir();

    // helper: create a file with mode and content
    async function mk(name: string, mode: number, text = "// noop\n") {
        const p = join(dir, name);
        await Deno.writeTextFile(p, text);
        await Deno.chmod(p, mode);
        return p;
    }

    await t.step(
        "multi via <nature>+: <name>.<nature>+.<domain> (abc.sql+.ts)",
        async () => {
            const p = await mk("abc.sql+.ts", 0o755);
            const info = CapExec.capExecCandidacy(p);

            assertEquals(info.base, "abc.sql+.ts");
            assert(info.isMulti, "isMulti should be true");
            assertEquals(info.markerPosition, "secondExt");
            assertEquals(info.nature, ".sql");
            assertEquals(info.extension, "ts");
            assert(CapExec.isExecutable(p), "file should be executable (755)");
            assert(info.isCapExec, "isCapExec should be true (exec + nature)");
        },
    );

    await t.step(
        "multi via <name>+: <name>+.<nature>.<domain> (abc+.sql.ts)",
        async () => {
            const p = await mk("abc+.sql.ts", 0o755);
            const info = CapExec.capExecCandidacy(p);

            assert(info.isMulti, "isMulti should be true");
            assertEquals(info.markerPosition, "basename");
            assertEquals(info.nature, ".sql");
            assertEquals(info.extension, "ts");
            assert(CapExec.isExecutable(p), "file should be executable (755)");
            assert(info.isCapExec, "isCapExec should be true (exec + nature)");
        },
    );

    await t.step(
        "multi via both markers: <name>+.<nature>+.<domain> (foo+.sql+.ts)",
        async () => {
            const p = await mk("foo+.sql+.ts", 0o755);
            const info = CapExec.capExecCandidacy(p);

            assert(info.isMulti);
            assertEquals(info.nature, ".sql");
            assertEquals(info.extension, "ts");
            assert(CapExec.isExecutable(p));
            assert(info.isCapExec);
        },
    );

    await t.step(
        "non-multi but has nature: <name>.<nature>.<domain> (emit.sql.ts) => CapExec true if executable",
        async () => {
            const p = await mk("emit.sql.ts", 0o755);
            const info = CapExec.capExecCandidacy(p);

            assertFalse(info.isMulti, "isMulti should be false");
            assertEquals(info.nature, ".sql");
            assertEquals(info.extension, "ts");
            assert(CapExec.isExecutable(p));
            assert(info.isCapExec, "should be CapExec: exec + nature");
        },
    );

    await t.step(
        "no nature: <name>.<domain> (plain.ts) => CapExec false even if executable=false",
        async () => {
            const p = await mk("plain.ts", 0o644);
            const info = CapExec.capExecCandidacy(p);

            assertFalse(info.isMulti);
            assertEquals(info.nature, null);
            assertEquals(info.extension, "ts");
            assertFalse(CapExec.isExecutable(p));
            assertFalse(info.isCapExec, "no nature => not CapExec");
        },
    );

    await t.step("dotfile handling: .env (no extensions)", async () => {
        const p = await mk(".env", 0o644, "FOO=bar\n");
        const info = CapExec.capExecCandidacy(p);

        assertEquals(info.base, ".env");
        assertEquals(info.extensions.length, 0);
        assertEquals(info.extension, null);
        assertFalse(info.isMulti);
        assertEquals(info.nature, null);
        assertFalse(info.isCapExec);
    });

    await t.step(
        "isCapExec requires executable + nature (multi optional)",
        async () => {
            const exePlus = await mk("emit.sql+.ts", 0o755); // exec + nature + multi
            const exeNoPlus = await mk("emit.sql.ts", 0o755); // exec + nature, no multi
            const noExePlus = await mk("emit+.sql.ts", 0o644); // nature + multi, not exec

            const a = CapExec.capExecCandidacy(exePlus);
            const b = CapExec.capExecCandidacy(exeNoPlus);
            const c = CapExec.capExecCandidacy(noExePlus);

            assert(CapExec.isExecutable(exePlus));
            assert(a.isMulti);
            assert(a.isCapExec, "exec + nature + multi");

            assert(CapExec.isExecutable(exeNoPlus));
            assertFalse(b.isMulti);
            assert(b.isCapExec, "exec + nature (no multi)");

            assertFalse(CapExec.isExecutable(noExePlus));
            assert(c.isMulti);
            assertFalse(c.isCapExec, "multi + nature but not executable");
        },
    );
});
