import {
    assert,
    assertEquals,
    assertStringIncludes,
    assertThrows,
} from "jsr:@std/assert@1";
import { includeTextRegions, TextRegions } from "./region.ts";

Deno.test("textRegions schema", async (t) => {
    await t.step(
        "parses include/includeEnd with ${vars}, quoted name, and captures line numbers",
        () => {
            const { schema } = includeTextRegions({
                vars: (name) => {
                    if (name === "spryHome") return "./spry";
                    if (name === "sprydHome") return "./spry.d";
                    throw new Error("unknown var");
                },
                lineNums: () => ({ include: 3, includeEnd: 7 }),
            });

            const parsed = schema.parse({
                include: '${spryHome}/components/table.sql "Main Table"',
                includeEnd: '"Main Table"',
            });

            assertEquals(parsed.include.relPath, "./spry/components/table.sql");
            assertEquals(parsed.include.name, "Main Table");
            assertEquals(parsed.include.lineNum, 3);

            assertEquals(parsed.includeEnd.name, "Main Table");
            assertEquals(parsed.includeEnd.lineNum, 7);
        },
    );

    await t.step("defaults name to basename when second token omitted", () => {
        const { schema } = includeTextRegions({
            vars: () => "",
            lineNums: () => ({ include: 10, includeEnd: 20 }),
        });

        const parsed = schema.parse({
            include: "partials/list.sql", // no explicit name -> defaults to basename
            includeEnd: "list.sql",
        });

        assertEquals(parsed.include.relPath, "partials/list.sql");
        assertEquals(parsed.include.name, "list.sql"); // basename with extension
        assertEquals(parsed.includeEnd.name, "list.sql");
    });

    await t.step("unquoted name without spaces is accepted", () => {
        const { schema } = includeTextRegions({
            vars: () => "",
            lineNums: () => ({ include: 1, includeEnd: 2 }),
        });

        const parsed = schema.parse({
            include: "partials/list.sql list",
            includeEnd: "list",
        });

        assertEquals(parsed.include.name, "list");
    });

    await t.step("rejects POSIX absolute path (leading slash)", () => {
        const { schema } = includeTextRegions({
            vars: () => "",
            lineNums: () => ({ include: 1, includeEnd: 2 }),
        });

        assertThrows(() => {
            schema.parse({ include: "/abs/file.sql", includeEnd: "file" });
        });
    });

    await t.step("rejects unknown ${templateVar}", () => {
        const { schema } = includeTextRegions({
            vars: (name) => {
                // no vars are allowed here => force error
                throw new Error(`unknown var: ${name}`);
            },
            lineNums: () => ({ include: 1, includeEnd: 2 }),
        });

        assertThrows(() => {
            schema.parse({ include: "${notDefined}/x.sql", includeEnd: "x" });
        });
    });
});

Deno.test("TextRegions.include replacement", async (t) => {
    await t.step(
        "replaces content strictly between include and includeEnd, preserves directives",
        async () => {
            const built = includeTextRegions({
                vars: (name) => {
                    if (name === "spryHome") return "./spry";
                    return "";
                },
                lineNums: () => ({ include: 3, includeEnd: 7 }), // 1-based lines
            });

            const schema = built.schema;

            // A target file with known lines; include at line 3, includeEnd at line 7
            // 1: -- preamble
            // 2: SELECT 1;
            // 3: -- @region.include ...
            // 4: old a
            // 5: old b
            // 6: old c
            // 7: -- @region.includeEnd ...
            // 8: SELECT 2;
            const target = [
                "-- preamble",
                "SELECT 1;",
                '-- @region.include ${spryHome}/components/table.sql "Main Table"', // line 3
                "old a",
                "old b",
                "old c",
                '-- @region.includeEnd "Main Table"', // line 7
                "SELECT 2;",
            ].join("\n");

            const directives = schema.parse({
                include: '${spryHome}/components/table.sql "Main Table"',
                includeEnd: '"Main Table"',
            });

            const tr = new TextRegions();

            const output = await tr.include(
                directives,
                // src: produce new content:
                () => ["new line 1", "new line 2"].join("\n"),
                // getTarget
                () => target,
            );

            const expected = [
                "-- preamble",
                "SELECT 1;",
                '-- @region.include ${spryHome}/components/table.sql "Main Table"',
                "new line 1",
                "new line 2",
                '-- @region.includeEnd "Main Table"',
                "SELECT 2;",
            ].join("\n");

            assertEquals(output, expected);
        },
    );

    await t.step("preserves CRLF end-of-line style", async () => {
        const built = includeTextRegions({
            vars: () => "",
            lineNums: () => ({ include: 2, includeEnd: 4 }),
        });
        const schema = built.schema;

        const targetCRLF = [
            "-- include line", // line 1
            "-- @region.include ./a.sql name", // line 2
            "old", // line 3
            "-- @region.includeEnd name", // line 4
            "-- after", // line 5
        ].join("\r\n");

        const directives = schema.parse({
            include: "./a.sql name",
            includeEnd: "name",
        });

        const tr = new TextRegions();
        const output = await tr.include(
            directives,
            "X\r\nY",
            () => targetCRLF,
        );

        // Ensure CRLF preserved
        assert(output.includes("\r\n"), "Output should contain CRLF");
        assertStringIncludes(
            output,
            "-- @region.include ./a.sql name\r\nX\r\nY\r\n-- @region.includeEnd name",
        );
    });

    await t.step("onError handler is used when an error occurs", async () => {
        const built = includeTextRegions({
            vars: () => "",
            lineNums: () => ({ include: 3, includeEnd: 5 }),
        });
        const schema = built.schema;

        const target = [
            "one",
            "two",
            "-- @region.include ./x.sql x", // line 3
            "-- @region.includeEnd x", // line 4
            "five",
        ].join("\n");

        const directives = schema.parse({
            include: "./x.sql x",
            includeEnd: "x",
        });

        const tr = new TextRegions();
        const output = await tr.include(
            directives,
            // cause src generation to fail
            () => {
                throw new Error("boom");
            },
            () => target,
            (err, _dirs, tgt) => {
                // custom fallback: annotate error but keep original file
                return `-- error: ${(err as Error).message}\n${tgt}`;
            },
        );

        assertStringIncludes(output, "-- error: boom");
        assertStringIncludes(output, "-- @region.include ./x.sql x");
        assertStringIncludes(output, "-- @region.includeEnd x");
    });

    await t.step(
        "silently returns original on error if onError is not provided",
        async () => {
            const built = includeTextRegions({
                vars: () => "",
                lineNums: () => ({ include: 2, includeEnd: 4 }),
            });
            const schema = built.schema;

            const target = [
                "a",
                "-- @region.include ./x.sql x", // line 2
                "old",
                "-- @region.includeEnd x", // line 4
                "z",
            ].join("\n");

            const directives = schema.parse({
                include: "./x.sql x",
                includeEnd: "x",
            });

            const tr = new TextRegions();
            const output = await tr.include(
                directives,
                // src throws
                () => {
                    throw new Error("src failure");
                },
                () => target,
            );

            assertEquals(output, target);
        },
    );

    await t.step("mismatched include/includeEnd names are rejected", () => {
        const { schema } = includeTextRegions({
            vars: () => "",
            lineNums: () => ({ include: 1, includeEnd: 2 }),
        });

        assertThrows(() =>
            schema.parse({
                include: "./x.sql sectionA",
                includeEnd: "sectionB",
            })
        );
    });
});
