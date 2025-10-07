// deno-lint-ignore-file no-explicit-any
// Path: lib/sqlpage/notebook_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  type SqlFenceTyped,
  SqlPageContentBuilder,
  SqlPageMaterializer,
} from "./notebook.ts";

/** Load fixture text via URL relative to this test file */
async function loadFixture(name: string) {
  const url = new URL(`./${name}`, import.meta.url);
  return await Deno.readTextFile(url);
}

/** Helper: make a 1-source provenance generator */
function sourcesFromText(identifier: string, markdown: string) {
  return (async function* () {
    yield { identifier, markdown };
  })();
}

/** Helper: build content from the fixture each time (fresh stream per test group) */
function makeContentFromFixture(fixtureName: string) {
  return (async () => {
    const md = await loadFixture(fixtureName);
    const provenance = sourcesFromText(fixtureName, md);
    // Defaults are safe; they include SQL schema + FM schema
    const builder = new SqlPageContentBuilder();
    return builder.build(provenance);
  })();
}

/** Drain an async iterator to array (for fences) */
async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

/* ------------------------------------------------------------------------- */
/* Unrelated area: parsing & validation behavior                              */
/* ------------------------------------------------------------------------- */

Deno.test("SqlPageContent: parses and validates fences", async (t) => {
  const content = await makeContentFromFixture("notebook_test-01.fixture.md");
  const fences = await collect<SqlFenceTyped<any>>(content.SQL());

  await t.step("yields all fences including control fence", () => {
    // 5 fences: head, control(section-defaults), page(kind), page(no kind), tail
    assertEquals(fences.length, 5);
  });

  await t.step(
    "typed fences are validated (attrsSafe present) for head/page/tail",
    () => {
      const typedCount =
        fences.filter((f) =>
          (f as { attrsSafe?: unknown }).attrsSafe !== undefined
        ).length;
      // head, page(kind), page(no kind), tail => 4 typed
      assertEquals(typedCount, 4);
    },
  );

  await t.step("control fence is yielded but not typed", () => {
    const control = fences[1];
    assertEquals((control as any).attrsSafe, undefined);
  });

  await t.step(
    "page without explicit kind still validates due to default('page') and required path",
    () => {
      const pageNoKind = fences.find((f) => f.code.includes("select 2;"));
      assert(pageNoKind);
      const attrs = (pageNoKind as { attrsSafe?: Record<string, unknown> })
        .attrsSafe!;
      assertEquals((attrs as { kind?: string }).kind ?? "page", "page");
      assertEquals((attrs as { path: string }).path, "users/list");
    },
  );

  await t.step("fence provenance is set", () => {
    for (const f of fences) {
      assertEquals(f.sourceId, "notebook_test-01.fixture.md");
      assert(typeof f.blockIndex === "number");
      assert(f.code.length > 0);
    }
  });
});

// NEW top-level test
Deno.test("SqlPageMaterializer: emitSqlPackage() yields heads, upserts, tails (sqlite)", async () => {
  const content = await makeContentFromFixture("notebook_test-01.fixture.md");
  const mat = new SqlPageMaterializer(content, {});

  // Collect the full package stream
  const parts: string[] = [];
  for await (const chunk of mat.emitSqlPackage("sqlite")) parts.push(chunk);

  // Sanity: at least head + some upserts + tail
  assert(parts.length >= 3);

  // Head SQL is first
  assertEquals(parts[0].trim(), "PRAGMA foreign_keys = ON;");

  // Tail SQL is last
  assertEquals(parts[parts.length - 1].trim(), "-- done");

  // DML statements are in the middle and target sqlpage_files
  const dmls = parts.slice(1, -1).filter((s) =>
    s.startsWith("INSERT INTO sqlpage_files")
  );
  // Expect upserts for head, tail, and two pages = 4 statements
  assertEquals(dmls.length, 4);

  // Paths present in the DML batch
  const hasHead = dmls.some((s) => s.includes("'sql.d/head/pragma.sql'"));
  const hasTail = dmls.some((s) => s.includes("'sql.d/tail/000.sql'"));
  const hasPage1 = dmls.some((s) => s.includes("'admin/index.sql'"));
  const hasPage2 = dmls.some((s) => s.includes("'users/list.sql'"));
  assert(hasHead && hasTail && hasPage1 && hasPage2);
});
