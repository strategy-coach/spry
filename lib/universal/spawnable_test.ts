// Unit tests for Spawnable (Deno 2.4+)
import { Spawnable } from "./spawnable.ts";

Deno.test("Spawnable: basic runs", async (t) => {
    const deno = Spawnable.from(Deno.execPath());

    await t.step("prints version", async () => {
        const r = await deno.withArgs(["--version"]).run();
        const out = r.stdout();
        if (!out.toLowerCase().includes("deno")) {
            throw new Error(`unexpected version output: ${out}`);
        }
    });

    await t.step("stdout text", async () => {
        const r = await deno.withArgs(["eval", "console.log('hi')"]).run();
        if (!/hi\n?$/.test(r.stdout())) {
            throw new Error("stdout did not contain 'hi'");
        }
    });

    await t.step("stdin: string", async () => {
        const code =
            "const s = await new Response(Deno.stdin.readable).text(); console.log(s.toUpperCase());";
        const r = await deno.withArgs(["eval", code]).withStdin("abc").run();
        if (r.stdout().trim() !== "ABC") {
            throw new Error(`expected ABC got: ${r.stdout()}`);
        }
    });

    await t.step("stdin: async iterable", async () => {
        async function* src() {
            yield "A";
            await new Promise((r) => setTimeout(r, 5));
            yield "B";
        }
        const code =
            "const s = await new Response(Deno.stdin.readable).text(); console.log(s)";
        const r = await deno.withArgs(["eval", code]).withStdin(src()).run();
        if (r.stdout().trim() !== "AB") {
            throw new Error(`expected AB got: ${r.stdout()}`);
        }
    });

    await t.step("stdin: writer callback", async () => {
        const code =
            "const s = await new Response(Deno.stdin.readable).text(); console.log(s.replaceAll('x','y'))";
        const r = await deno
            .withArgs(["eval", code])
            .withStdin(async (w) => {
                const te = new TextEncoder();
                await w.write(te.encode("xx"));
            })
            .run();
        if (r.stdout().trim() !== "yy") {
            throw new Error(`expected yy got: ${r.stdout()}`);
        }
    });

    await t.step("env: override (generic)", async () => {
        const r = await deno
            .withEnv<{ FOO: string }>({ FOO: "bar" })
            .withArgs(["eval", "console.log(Deno.env.get('FOO')||'')"])
            .run();
        if (r.stdout().trim() !== "bar") {
            throw new Error(`expected bar got: ${r.stdout()}`);
        }
    });

    await t.step("cwd: set working directory", async () => {
        const tmp = Deno.makeTempDirSync();
        const r = await deno
            .withCwd(tmp)
            .withArgs(["eval", "console.log(Deno.cwd())"])
            .run();
        if (r.stdout().trim() !== tmp) {
            throw new Error(`cwd mismatch: ${r.stdout()} !== ${tmp}`);
        }
    });
});

Deno.test("Spawnable: non-zero exit does not throw", async (t) => {
    const deno = Spawnable.from(Deno.execPath());
    await t.step("returns code on failure", async () => {
        const r = await deno.withArgs(["eval", "Deno.exit(2)"]).run();
        if (r.code !== 2 || r.success) {
            throw new Error(
                `expected code 2 + success=false, got code=${r.code} success=${r.success}`,
            );
        }
    });
});
