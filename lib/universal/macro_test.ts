import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1.0.6";
import {
    type CandidateDefn,
    Emitter,
    includeStream,
    type IsCandidate,
    type IsMacro,
    lineCommentDirectiveParser,
    type ReplaceErrorContext,
    ReplaceStream,
    type ReplaceStreamEvents,
    textToShellArgv,
} from "./macro.ts";

async function streamToString(rs: ReadableStream<string>) {
    const r = rs.getReader();
    const chunks: string[] = [];
    while (true) {
        const { value, done } = await r.read();
        if (done) break;
        chunks.push(value);
    }
    return chunks.join("");
}

Deno.test("includeStream: basic block replacement with default markers", async (t) => {
    await t.step(
        "replaces inner region; preserves begin/end lines",
        async () => {
            const input = [
                "-- before",
                "-- #include libs --from a --from b",
                "-- old interior should be replaced",
                "-- #includeEnd libs",
                "-- after",
                "",
            ].join("\n");

            const rs = includeStream(input, {
                render: (name, ctx) => {
                    const out: string[] = [];
                    const argv = ctx.argsText.trim().length
                        ? ctx.argsText.trim().split(/\s+/)
                        : [];
                    for (let i = 0; i < argv.length; i++) {
                        if (argv[i] === "--from" && i + 1 < argv.length) {
                            out.push(argv[++i]);
                        }
                    }
                    return [`[${name}]`, ...out];
                },
            });

            const out = await streamToString(rs);
            const lines = out.split("\n");
            const begin = lines.findIndex((l) =>
                l.includes("-- #include libs")
            );
            const end = lines.findIndex((l) =>
                l.includes("-- #includeEnd libs")
            );

            assert(begin >= 0 && end > begin);
            assertEquals(lines[begin + 1], "[libs]");
            assertEquals(lines[begin + 2], "a");
            assertEquals(lines[begin + 3], "b");
            assertEquals(lines.at(-1), "");
        },
    );

    await t.step(
        "uses CRLF from parent by default; can be overridden via eol",
        async () => {
            const inputCRLF = [
                "-- #include libs --from X",
                "-- to be replaced",
                "-- #includeEnd libs",
                "",
            ].join("\r\n");

            const rsDefault = includeStream(inputCRLF, {
                render: () => ["A", "B"],
            });
            const outDefault = await streamToString(rsDefault);
            assert(outDefault.includes("\r\nA\r\nB\r\n"));

            const rsLF = includeStream(inputCRLF, {
                render: () => ["A", "B"],
                eol: "\n",
            });
            const outLF = await streamToString(rsLF);
            assert(outLF.includes("\nA\nB\n"));
        },
    );

    await t.step(
        "works as a stream input (Uint8Array chunks) and emits stream",
        async () => {
            const enc = new TextEncoder();
            const chunks = [
                enc.encode("-- #include libs --from 1 --from 2\n"),
                enc.encode("OLD\n"),
                enc.encode("-- #includeEnd libs\n"),
            ];
            const input = new ReadableStream<Uint8Array>({
                start(controller) {
                    for (const c of chunks) controller.enqueue(c);
                    controller.close();
                },
            });

            const rs = includeStream(input, {
                render: (_name, ctx) => {
                    const vals = ctx.argsText.split(/\s+/);
                    const out: string[] = [];
                    for (let i = 0; i < vals.length; i++) {
                        if (vals[i] === "--from" && i + 1 < vals.length) {
                            out.push(vals[++i]);
                        }
                    }
                    return out;
                },
            });

            const out = await streamToString(rs);
            const between = out.split("\n")[1];
            assertEquals(between, "1");
        },
    );

    await t.step(
        "unclosed block: with onError=continue, engine preserves begin + inner and emits error event",
        async () => {
            const input = [
                "-- before",
                "-- #include skip --from A",
                "INNER LINE",
                // missing: -- #includeEnd skip
            ].join("\n");

            const events = new Emitter<ReplaceStreamEvents<CandidateDefn>>();
            // Capture only the phase explicitly; avoids TS inferring `never`.
            let gotErrorPhase:
                | ReplaceErrorContext<CandidateDefn>["phase"]
                | undefined = undefined;

            events.on(
                "error",
                (_err, ctx: ReplaceErrorContext<CandidateDefn>) => {
                    gotErrorPhase = ctx.phase;
                },
            );

            const rs = includeStream(input, {
                render: () => ["SHOULD NOT APPEAR"],
                onError: () => "continue",
                events,
            });

            const out = await streamToString(rs);
            assert(
                out.includes("-- #include skip --from A"),
                "begin preserved",
            );
            assert(out.includes("INNER LINE"), "inner preserved");
            assert(!out.includes("SHOULD NOT APPEAR"));
            assertEquals(gotErrorPhase, "unterminatedBlock");
        },
    );
});

Deno.test("ReplaceStream: inline (single-line) macro replacement", async (t) => {
    await t.step("replaces a single line and preserves delimiter", async () => {
        const input = "hello\nREPLACE_ME\nworld\n";

        const isCandidate: IsCandidate<CandidateDefn, unknown> = (line) =>
            line === "REPLACE_ME"
                ? { directive: "inline", argsText: "" }
                : false;

        const isMacro: IsMacro<CandidateDefn> = () => ({
            render: () => ["X", "Y"],
        });

        const engine = new ReplaceStream(isCandidate, isMacro);
        const out = await engine.processToString(input);
        assertEquals(out.after, "hello\nX\nY\nworld\n");
    });

    await t.step(
        "no output from render keeps just the original line’s delimiter",
        async () => {
            const input = "A\r\nREPLACE_ME\r\nB\r\n";

            const isCandidate: IsCandidate<CandidateDefn, unknown> = (line) =>
                line === "REPLACE_ME"
                    ? ({ directive: "empty", argsText: "" })
                    : false;

            const isMacro: IsMacro<CandidateDefn> = () => ({
                render: () => [],
            });

            const engine = new ReplaceStream(isCandidate, isMacro);
            const out = await engine.processToString(input);
            assertEquals(out.after, "A\r\n\r\nB\r\n");
        },
    );
});

Deno.test("ReplaceStream: block macro with unknown macro at render-time preserves inner", async () => {
    const input = [
        "start",
        "#BEGIN x",
        "keep this",
        "#END x",
        "tail",
        "",
    ].join("\n");

    const isCandidate: IsCandidate<CandidateDefn, unknown> = (line) => {
        if (!line.startsWith("#BEGIN ")) return false;
        const name = line.slice("#BEGIN ".length).trim();
        const blockEnd = (probe: string) => probe.trim() === `#END ${name}`;
        return { directive: name, argsText: "", blockEnd };
    };

    const isMacro: IsMacro<CandidateDefn> = (
        id,
    ) => (id === "x" ? false : ({ render: () => ["NOOP"] }));

    const rs = new ReplaceStream(isCandidate, isMacro);
    const out = await rs.processToString(input);
    assert(out.after.includes("#BEGIN x\nkeep this\n#END x\n"));
});

Deno.test("ReplaceStream: two consecutive block macros", async () => {
    const input = [
        "-- #BLOCK a",
        "old",
        "-- #END a",
        "-- #BLOCK b",
        "old",
        "-- #END b",
        "",
    ].join("\n");

    const isCandidate: IsCandidate<CandidateDefn, unknown> = (line) => {
        if (!line.startsWith("-- #BLOCK ")) return false;
        const name = line.slice("-- #BLOCK ".length).trim();
        return {
            directive: name,
            argsText: "",
            blockEnd: (probe) => probe.trim() === `-- #END ${name}`,
        };
    };

    const isMacro: IsMacro<CandidateDefn> = (id) => ({
        render: () => [`<${id}-1>`, `<${id}-2>`],
    });

    const rs = new ReplaceStream(isCandidate, isMacro);
    const out = await rs.processToString(input);
    const lines = out.after.split("\n");
    const i1 = lines.findIndex((l) => l.includes("-- #BLOCK a"));
    assertEquals(lines[i1 + 1], "<a-1>");
    assertEquals(lines[i1 + 2], "<a-2>");
    const i2 = lines.findIndex((l) => l.includes("-- #BLOCK b"));
    assertEquals(lines[i2 + 1], "<b-1>");
    assertEquals(lines[i2 + 2], "<b-2>");
});

Deno.test("includeStream: custom markers", async () => {
    const input = ["#inc libs ARGS GO HERE", "old", "#end libs", ""].join("\n");

    const rs = includeStream(input, {
        start: "#inc",
        endPrefix: "#end",
        render: (name, ctx) => [`N=${name}`, `RAW=${ctx.argsText}`],
    });

    const out = await streamToString(rs);
    const lines = out.split("\n");
    const i = lines.findIndex((l) => l.startsWith("#inc libs"));
    assertEquals(lines[i + 1], "N=libs");
    assertEquals(lines[i + 2], "RAW=ARGS GO HERE");
});

Deno.test("Error handling and events: inline render throws -> continue preserves original; events fire", async () => {
    const input = "A\nRENDER_ME\nZ\n";

    const events = new Emitter<ReplaceStreamEvents<CandidateDefn>>();
    const calls: string[] = [];
    events.on("candidate", (c) => calls.push(`candidate:${c.identity}`));
    events.on("inlineRender", (i) => calls.push(`inline:${i.identity}`));
    events.on(
        "error",
        (_e, ctx: ReplaceErrorContext<CandidateDefn>) =>
            calls.push(`error:${ctx.phase}`),
    );
    events.on("emitChunk", (emit) => {
        if (emit.chunk.includes("RENDER_ME")) calls.push("emit:original");
    });

    const isCandidate: IsCandidate<CandidateDefn, unknown> = (line) =>
        line === "RENDER_ME" ? { directive: "boom", argsText: "" } : false;

    const isMacro: IsMacro<CandidateDefn> = () => ({
        render: () => {
            throw new Error("kaboom");
        },
    });

    const engine = new ReplaceStream(isCandidate, isMacro, {
        onError: () => "continue",
        events,
    });

    const out = await engine.processToString(input);
    assert(out.after.includes("RENDER_ME\n"));
    assertEquals(calls.includes("candidate:boom"), true);
    assertEquals(calls.includes("error:render"), true);
    assertEquals(calls.some((c) => c.startsWith("inline:")), false);
    assertEquals(calls.includes("emit:original"), true);
});

Deno.test("Error handling and events: unterminated block -> continue preserves; events fire blockStart + error", async () => {
    const input = ["-- #include cfg FLAGS", "old"].join("\n"); // no end

    const events = new Emitter<ReplaceStreamEvents<CandidateDefn>>();
    const seen: string[] = [];
    events.on("blockStart", (b) => seen.push(`start:${b.identity}`));
    events.on("blockEnd", (b) => seen.push(`end:${b.identity}`));
    events.on(
        "error",
        (_e, ctx: ReplaceErrorContext<CandidateDefn>) =>
            seen.push(`error:${ctx.phase}`),
    );

    const rs = includeStream(input, {
        render: () => ["NEW"], // never used
        onError: () => "continue",
        events,
    });

    const out = await streamToString(rs);
    assert(out.includes("-- #include cfg FLAGS"));
    assert(out.includes("old"));
    assertEquals(seen.includes("start:cfg"), true);
    assertEquals(seen.includes("error:unterminatedBlock"), true);
    assertEquals(seen.some((s) => s.startsWith("end:")), false);
});

Deno.test("textToShellArgv - core behavior", async (t) => {
    await t.step("simple tokens", () => {
        assertEquals(textToShellArgv("ls -la /tmp"), ["ls", "-la", "/tmp"]);
    });

    await t.step("whitespace splitting (spaces, tabs, newlines)", () => {
        assertEquals(textToShellArgv("a   b\tc\nd"), ["a", "b", "c", "d"]);
    });

    await t.step("empty and spaces-only", () => {
        assertEquals(textToShellArgv(""), []);
        assertEquals(textToShellArgv("   \t  \n  "), []);
    });

    await t.step("single quotes are literal", () => {
        assertEquals(textToShellArgv("echo 'hello world'"), [
            "echo",
            "hello world",
        ]);
        assertEquals(textToShellArgv("'a\"b\"c' d"), ['a"b"c', "d"]);
    });

    await t.step('double quotes with escapes for ", \\, $, `', () => {
        assertEquals(
            textToShellArgv(
                `echo "a \\"quote\\"" "\\\\ backslash" "\\$HOME" "\\\`cmd\`"`,
            ),
            ["echo", `a "quote"`, `\\ backslash`, `$HOME`, "`cmd`"],
        );
    });

    await t.step("double quotes: unknown escapes keep backslash", () => {
        assertEquals(textToShellArgv(`"hello\\nworld" "x\\y"`), [
            "hello\\nworld",
            "x\\y",
        ]);
    });

    await t.step("backslash outside quotes escapes next char", () => {
        assertEquals(textToShellArgv(`a\\ b c\\d e\\$ f\\"`), [
            "a b",
            "cd",
            "e$",
            'f"',
        ]);
    });

    await t.step(
        "trailing backslash outside quotes → literal backslash",
        () => {
            assertEquals(textToShellArgv(`foo\\`), ["foo\\"]);
        },
    );

    await t.step(
        "backslash at end inside double quotes → literal backslash",
        () => {
            assertEquals(textToShellArgv(`"foo\\"`), ["foo\\"]);
        },
    );

    await t.step("mixed quotes and escapes", () => {
        assertEquals(
            textToShellArgv(
                `cmd 'a b' "c d" e\\ f "\\$HOME and \\backslash" tail`,
            ),
            ["cmd", "a b", "c d", "e f", "$HOME and \\backslash", "tail"],
        );
    });

    await t.step(
        "multiple consecutive spaces collapse into token boundaries",
        () => {
            assertEquals(textToShellArgv("cmd   arg1    arg2"), [
                "cmd",
                "arg1",
                "arg2",
            ]);
        },
    );

    await t.step("no expansions performed", () => {
        assertEquals(textToShellArgv(`echo $HOME`), ["echo", "$HOME"]);
        assertEquals(textToShellArgv(`echo "\\$HOME"`), ["echo", "$HOME"]);
    });

    await t.step("unclosed single quote throws", () => {
        assertThrows(
            () => textToShellArgv("echo 'oops"),
            Error,
            "Unclosed quote",
        );
    });

    await t.step("unclosed double quote throws", () => {
        assertThrows(
            () => textToShellArgv('echo "oops'),
            Error,
            "Unclosed quote",
        );
    });
});

Deno.test("lineCommentDirectiveParser: SQL style -- with # directives", async (t) => {
    const parse = lineCommentDirectiveParser({
        comment: "--",
        directivePrefix: "#",
    });

    await t.step("marker only / marker + spaces → no token", () => {
        assertEquals(parse("--"), false);
        assertEquals(parse("--   "), false);
    });

    await t.step("<comment><ws?><token>", () => {
        assertEquals(parse("--include"), ["include", "", ""]);
        assertEquals(parse("-- include"), ["include", "", ""]);
        assertEquals(parse("   --    include"), ["include", "", ""]);
    });

    await t.step("<comment><ws?><token><ws><remainder>", () => {
        assertEquals(parse("-- include files"), ["include", "files", ""]);
        assertEquals(parse("--   include   users list"), [
            "include",
            "users list",
            "",
        ]);
    });

    await t.step("directive: <comment><ws?><prefix><token>", () => {
        assertEquals(parse("--#include"), ["include", "", "#"]);
        assertEquals(parse("-- #include"), ["include", "", "#"]);
        assertEquals(parse(" --   #include"), ["include", "", "#"]);
    });

    await t.step(
        "directive with remainder: <comment><ws?><prefix><token><ws><remainder>",
        () => {
            assertEquals(parse("--# name users"), ["name", "users", "#"]);
            assertEquals(parse("--   #name   users table"), [
                "name",
                "users table",
                "#",
            ]);
        },
    );

    await t.step("no marker at start → normal split", () => {
        assertEquals(parse("select * from t"), ["select", "* from t", ""]);
        assertEquals(parse("include stuff"), ["include", "stuff", ""]);
    });
});

Deno.test("lineCommentDirectiveParser: Bash style # with @ directives", async (t) => {
    const parse = lineCommentDirectiveParser({
        comment: "#",
        directivePrefix: "@",
    });

    await t.step("plain comment word", () => {
        assertEquals(parse("# note"), ["note", "", ""]);
        assertEquals(parse("# note this"), ["note", "this", ""]);
    });

    await t.step("directive immediate or spaced", () => {
        assertEquals(parse("#@todo"), ["todo", "", "@"]);
        assertEquals(parse("# @todo fix"), ["todo", "fix", "@"]);
        assertEquals(parse("   #   @tag release 1.2"), [
            "tag",
            "release 1.2",
            "@",
        ]);
    });

    await t.step("shebang-like (no remainder)", () => {
        assertEquals(parse("#!/usr/bin/env bash"), [
            "!/usr/bin/env",
            "bash",
            "",
        ]);
    });

    await t.step("no comment marker → normal split", () => {
        assertEquals(parse("echo hello"), ["echo", "hello", ""]);
    });
});

Deno.test("lineCommentDirectiveParser: JS/C style // with ! directives", async (t) => {
    const parse = lineCommentDirectiveParser({
        comment: "//",
        directivePrefix: "!",
    });

    await t.step("plain // comment", () => {
        assertEquals(parse("// region Name"), ["region", "Name", ""]);
        assertEquals(parse("   //   TODO later"), ["TODO", "later", ""]);
    });

    await t.step("directive with !", () => {
        assertEquals(parse("//!pragma once"), ["pragma", "once", "!"]);
        assertEquals(parse("// !enable feature-x"), [
            "enable",
            "feature-x",
            "!",
        ]);
    });

    await t.step("no marker → normal split", () => {
        assertEquals(parse("console.log(x)"), ["console.log(x)", "", ""]);
        assertEquals(parse("let x = 1;"), ["let", "x = 1;", ""]);
    });
});

Deno.test("lineCommentDirectiveParser: edge cases", async (t) => {
    const parseHash = lineCommentDirectiveParser({
        comment: "#",
        directivePrefix: ":",
    });

    await t.step("empty / whitespace-only lines", () => {
        assertEquals(parseHash(""), false);
        assertEquals(parseHash("   \t  "), false);
    });

    await t.step("comment with only prefix and spaces", () => {
        assertEquals(parseHash("#:"), false);
        assertEquals(parseHash("#:   "), false);
    });

    await t.step("marker not at the very start → normal split", () => {
        assertEquals(parseHash("x # y"), ["x", "# y", ""]);
        assertEquals(parseHash("path // comment"), ["path", "// comment", ""]);
    });
});
