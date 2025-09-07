// sql-text_test.ts
// deno-lint-ignore-file no-explicit-any
import {
    assert,
    assertEquals,
    assertNotStrictEquals,
    assertStrictEquals,
} from "jsr:@std/assert@1";

import { ensureTrailingSemicolon, isSQL, raw, SQL } from "./sql-text.ts"; // adjust path

Deno.test("isSQL type guard", () => {
    const q = SQL`select ${1}`;
    assert(isSQL(q));
    assert(!isSQL(123));
    assert(!isSQL({}));
});

Deno.test("safe(): default identifier `$` with primitives and ordering", () => {
    const q =
        SQL`select * from users where id = ${123} and active = ${true} and name = ${"Ann"}`;
    const s = q.safe();
    assertEquals(
        s.text,
        "select * from users where id = $1 and active = $2 and name = $3",
    );
    assertEquals(s.values, [123, true, "Ann"]);
    assert(Object.isFrozen(s.values));
});

Deno.test("safe(): identifier ':' style", () => {
    const q = SQL`where a = ${1} and b in (${[2, 3]})`;
    const s = q.safe({ identifier: ":" });
    assertEquals(s.text, "where a = :1 and b in (:2, :3)");
    assertEquals(s.values, [1, 2, 3]);
});

Deno.test("safe(): custom identifier function (named)", () => {
    const q = SQL`update t set a = ${1}, b = ${2} where id = ${99}`;
    const s = q.safe({ identifier: (i) => `:p${i}` });
    assertEquals(s.text, "update t set a = :p1, b = :p2 where id = :p3");
    assertEquals(s.values, [1, 2, 99]);
});

Deno.test("safe(): arrays expand; multi-digit placeholders correct", () => {
    const vals = Array.from({ length: 12 }, (_, i) => i + 1); // [1..12]
    const q = SQL`insert into t ( ${vals} ) values ( ${vals} )`;
    const s = q.safe();
    assertEquals(
        s.text,
        "insert into t ( $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12 ) values ( $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24 )",
    );
    assertEquals(s.values, [...vals, ...vals]);
});

Deno.test("safe(): nested SQL merges and reindexes across boundaries", () => {
    const where = SQL`where a = ${1} and b in (${[2, 3]})`;
    const q = SQL`select * from t ${where} and c = ${"x"}`;
    const s = q.safe();
    assertEquals(
        s.text,
        "select * from t where a = $1 and b in ($2, $3) and c = $4",
    );
    assertEquals(s.values, [1, 2, 3, "x"]);
});

Deno.test("safe(): nested SQL inside arrays mixes with primitives", () => {
    const a = SQL`a = ${1}`;
    const b = SQL`b = ${2}`;
    const q = SQL`select * from t where (${[a, b, "c"]})`;
    const s = q.safe();
    assertEquals(s.text, "select * from t where (a = $1, b = $2, $3)");
    assertEquals(s.values, [1, 2, "c"]);
});

Deno.test("safe(): values array is frozen; each call returns a new instance", () => {
    const q = SQL`select * from x where a = ${1} and b = ${2}`;
    const s1 = q.safe();
    const s2 = q.safe();
    assertNotStrictEquals(s1.values, s2.values);
    assertEquals(s1.values, s2.values);
    assert(Object.isFrozen(s1.values));
    assert(Object.isFrozen(s2.values));
    let threw = false;
    try {
        (s1.values as any).push(999);
    } catch {
        threw = true;
    }
    assert(threw);
});

Deno.test("safe(): identifier propagates through nested SQL", () => {
    const inner = SQL`x = ${1} and y = ${2}`;
    const outer =
        SQL`update t set ${raw`flag = 1`} where ${inner} and z = ${3}`;
    const s = outer.safe({ identifier: (i) => `:p${i}` });
    assertEquals(
        s.text,
        "update t set flag = 1 where x = :p1 and y = :p2 and z = :p3",
    );
    assertEquals(s.values, [1, 2, 3]);
});

Deno.test("raw(): inserted verbatim and does not add to values", () => {
    const q = SQL`select * from t ${raw`where "a" IS NOT NULL`} and x = ${1}`;
    const s = q.safe();
    assertEquals(s.text, `select * from t where "a" IS NOT NULL and x = $1`);
    assertEquals(s.values, [1]);
});

Deno.test("raw(): nested SQL is inlined in text() and verbatim in safe()", () => {
    const inner = SQL`a = ${"O'Brien"}`; // would be parameterized if used directly
    const snippet = raw`(${inner}) OR (b = 1)`;
    const q = SQL`where ${snippet} and c = ${2}`;

    // text(): inline literals, including those from nested SQL inside raw()
    assertEquals(q.text(), "where (a = 'O''Brien') OR (b = 1) and c = 2");

    // safe(): raw chunk is verbatim; only 'c = ${2}' contributes a placeholder
    const s = q.safe();
    assertEquals(s.text, "where (a = 'O''Brien') OR (b = 1) and c = $1");
    assertEquals(s.values, [2]);
});

Deno.test("raw(): safe() keeps raw verbatim and does not parameterize nested SQL text", () => {
    const inner = SQL`a = ${"O'Brien"}`; // would be parameterized if used directly
    const snippet = raw`(${inner}) OR (b = 1)`;
    const q = SQL`where ${snippet} and c = ${2}`;
    const s = q.safe();
    // The raw chunk is literal; only trailing 'c = ${2}' produces a placeholder
    assertEquals(s.text, "where (a = 'O''Brien') OR (b = 1) and c = $1");
    assertEquals(s.values, [2]);

    // And text() shows fully inlined output as well
    assertEquals(q.text(), "where (a = 'O''Brien') OR (b = 1) and c = 2");
});

Deno.test("text(): inlines primitives, arrays, nested SQL; escapes strings; booleans uppercased", () => {
    const where = SQL`where id in (${[1, 2]}) and active = ${false}`;
    const q = SQL`select * from users ${where} and name = ${"O'Brien"}`;
    assertEquals(
        q.text(),
        "select * from users where id in (1, 2) and active = FALSE and name = 'O''Brien'",
    );
});

Deno.test("text(): date formatter via options.ifDate including nested SQL", () => {
    const d = new Date("2025-01-02T03:04:05.678Z");
    const inner = SQL`created_at >= ${d}`;
    const outer = SQL`where ${inner} and level = ${"info"}`;

    const formatted = outer.text({
        ifDate: (dt) =>
            `to_timestamp('${dt.toISOString()}', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')`,
    });

    assertEquals(
        formatted,
        "where created_at >= to_timestamp('2025-01-02T03:04:05.678Z', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') and level = 'info'",
    );
});

Deno.test("toString() delegates to text()", () => {
    const d = new Date("2025-09-06T12:00:00Z");
    const q = SQL`insert into t (d, s) values (${d}, ${"a'b"})`;
    assertStrictEquals(String(q), q.text());
});

Deno.test("ensureTrailingSemicolon()", () => {
    assertEquals(ensureTrailingSemicolon("select 1"), "select 1;");
    assertEquals(ensureTrailingSemicolon("select 1;   "), "select 1;");
    assertEquals(ensureTrailingSemicolon("select 1;;; \n"), "select 1;");
});
