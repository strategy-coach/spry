import { assert, assertArrayIncludes, assertEquals } from "jsr:@std/assert@1";
import { omitPathsReplacer } from "./json.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("omitPathsReplacer – end to end", async (t) => {
    const base = {
        a: { b: { c: 1, d: 2 }, bcd: 3 },
        users: [
            { id: 1, password: "x", profile: { email: "u1@example.com" } },
            { id: 2, password: "y", profile: { email: "u2@example.com" } },
        ],
        secrets: { token: "abcd", refresh: "efgh" },
        yearMap: { "2024": { "1": { value: 42 } } },
    };

    await t.step("omit a single nested path (a.b.c)", () => {
        const json = JSON.stringify(
            base,
            omitPathsReplacer(base, [["a", "b", "c"]]),
        );
        const obj = JSON.parse(json);
        assertEquals(obj.a.b.c, undefined);
        assertEquals(obj.a.b.d, 2);
        assertEquals(obj.a.bcd, 3);
    });

    await t.step("omit array index path (users[1].password)", () => {
        const json = JSON.stringify(
            base,
            omitPathsReplacer(base, [["users", 1, "password"]]),
        );
        const obj = JSON.parse(json);
        assertEquals(obj.users[0].password, "x");
        assertEquals(obj.users[1].password, undefined);
        assertArrayIncludes(obj.users.map((u: Any) => u.id), [1, 2]);
    });

    await t.step("omit multiple paths at once", () => {
        const json = JSON.stringify(
            base,
            omitPathsReplacer(base, [
                ["a", "b", "c"],
                ["users", 1, "password"],
                ["secrets", "token"],
            ]),
        );
        const obj = JSON.parse(json);
        assertEquals(obj.a.b.c, undefined);
        assertEquals(obj.users[1].password, undefined);
        assertEquals(obj.secrets.token, undefined);
        // untouched neighbors
        assertEquals(obj.a.b.d, 2);
        assertEquals(obj.secrets.refresh, "efgh");
    });

    await t.step("non-matching path is a no-op", () => {
        const json = JSON.stringify(
            base,
            omitPathsReplacer(base, [["does", "not", "exist"]]),
        );
        const obj = JSON.parse(json);
        assertEquals(obj, base); // deep-equal if nothing removed
    });

    await t.step("numeric keys as path segments", () => {
        const json = JSON.stringify(
            base,
            omitPathsReplacer(base, [["yearMap", "2024", "1", "value"]]),
        );
        const obj = JSON.parse(json);
        assertEquals(obj.yearMap["2024"]["1"].value, undefined);
    });

    await t.step(
        "stringifyOmitting wrapper behaves like JSON.stringify with replacer",
        () => {
            const json = JSON.stringify(
                base,
                omitPathsReplacer(base, [["secrets", "token"]]),
            );
            const obj = JSON.parse(json);
            assertEquals(obj.secrets.token, undefined);
            // pretty print with space should still work
            const pretty = JSON.stringify(
                base,
                omitPathsReplacer(base, [["secrets", "token"]]),
                2,
            );
            assert(pretty.includes("\n")); // has indentation/newlines
        },
    );

    await t.step(
        "only exact path is omitted (no prefix/suffix confusion)",
        () => {
            // Omit a.b.c but keep a.bcd intact and a.b.cx intact
            const extended = {
                ...base,
                a: {
                    ...base.a,
                    b: { ...base.a.b, cx: 9 },
                    bcd: 7,
                },
            };
            const json = JSON.stringify(
                extended,
                omitPathsReplacer(extended, [["a", "b", "c"]]),
            );
            const obj = JSON.parse(json);
            assertEquals(obj.a.b.c, undefined);
            assertEquals(obj.a.b.cx, 9);
            assertEquals(obj.a.bcd, 7);
        },
    );
});
