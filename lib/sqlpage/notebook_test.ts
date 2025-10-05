// lib/sqlpage/notebook_test.ts
// Uses ReadableStream<Uint8Array> in addition to string sources.

import { z } from "jsr:@zod/zod@4";
import { type SqlFenceTyped, sqlPageContent } from "./notebook.ts";

Deno.test("sqlPageContent — streaming & validation (synthetic sources, strings & streams)", async (t) => {
  const fmSchema = z.object({
    siteName: z.string().min(1),
  }).strict();

  // Keep head strict (so extraneous key fails),
  // make tail passthrough (so section-defaults extras don't fail),
  // keep page non-strict (so defaults merge is accepted).
  const sqlAttrs = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("head") }).strict(),
    z.object({ kind: z.literal("tail") }).passthrough(),
    z.object({
      kind: z.literal("page"),
      name: z.string().min(1).optional(),
      filename: z.string().min(1).optional(),
    }),
  ]);

  type FM = z.infer<typeof fmSchema>;
  type M = { sql: z.infer<typeof sqlAttrs> };
  type Fence = SqlFenceTyped<M>;

  // NOTE: Real triple-backticks (no escaping) so remark sees code fences.
  const goodMd = "---\n" +
    "siteName: Demo\n" +
    "---\n" +
    "## Intro to Head\n\n" +
    '```sql { kind: "head" }\n' +
    "PRAGMA foreign_keys = ON;\n" +
    "```\n\n" +
    "Some prose in between.\n\n" +
    '```sql { role: "section-defaults" }\n' +
    '{ name: "Home From Defaults" }\n' +
    "```\n\n" +
    '```sql { kind: "page" }\n' +
    "select 1 as one;\n" +
    "```\n\n" +
    "```bash\n" +
    'echo "ignored";\n' +
    "```\n\n" +
    '```sql { kind: "tail" }\n' +
    "-- tail block\n" +
    "```\n\n" +
    '```sql { kind: "weird" }\n' +
    "select 2 as two; -- invalid kind for our schema\n" +
    "```\n\n" +
    '```sql { kind: "head", extraneous: 42 }\n' +
    "-- extra key not allowed by strict() schema\n" +
    "```\n";

  const badFmMd = "---\n" +
    "siteTitle: MissingRequiredSiteName\n" +
    "---\n" +
    '```sql { kind: "page", name: "Should Be Skipped" }\n' +
    "select 9;\n" +
    "```\n";

  async function* sources(
    ...pairs: Array<[id: string, md: string | ReadableStream<Uint8Array>]>
  ) {
    for (const [identifier, markdown] of pairs) {
      yield { identifier, markdown };
    }
  }

  await t.step(
    "streams typed fences; validates attrs; collects issues (string source)",
    async () => {
      const content = sqlPageContent<FM, M>(
        sources(["good.md", goodMd]),
        {
          fmSchema,
          attrSchemas: { sql: sqlAttrs },
        },
      );

      const fences: Fence[] = [];
      for await (const f of content.SQL()) {
        fences.push(f);
      }

      // 6 sql fences in the doc.
      if (fences.length !== 6) {
        throw new Error(`Expected 6 sql fences, got ${fences.length}`);
      }

      // Exactly 3 typed fences: head + page + tail
      const typed = fences.filter((f) =>
        (f as { attrsSafe?: unknown }).attrsSafe !== undefined
      );
      if (typed.length !== 3) {
        throw new Error(
          `Expected 3 typed fences (head/page/tail), got ${typed.length}`,
        );
      }

      const headFence = typed.find(
        (f): f is Fence & { attrsSafe: { kind: "head" } } =>
          (f as { attrsSafe?: { kind?: unknown } }).attrsSafe?.kind === "head",
      );
      const pageFence = typed.find(
        (f): f is Fence & { attrsSafe: { kind: "page"; name?: string } } =>
          (f as { attrsSafe?: { kind?: unknown } }).attrsSafe?.kind === "page",
      );
      const tailFence = typed.find(
        (f): f is Fence & { attrsSafe: { kind: "tail" } } =>
          (f as { attrsSafe?: { kind?: unknown } }).attrsSafe?.kind === "tail",
      );

      if (!headFence) throw new Error("Missing typed head fence");
      if (!pageFence) throw new Error("Missing typed page fence");
      if (!tailFence) throw new Error("Missing typed tail fence");

      if (!headFence.code.includes("PRAGMA foreign_keys")) {
        throw new Error("Head fence SQL not captured/trimmed as expected.");
      }
      if (!tailFence.code.includes("-- tail block")) {
        throw new Error("Tail fence SQL not captured/trimmed as expected.");
      }
      if (!pageFence.code.includes("select 1 as one")) {
        throw new Error("Page fence SQL not captured/trimmed as expected.");
      }

      // Page attrs reflect instruction-defaults merge.
      if (
        (pageFence as { attrsSafe?: { name?: string } }).attrsSafe?.name !==
          "Home From Defaults"
      ) {
        throw new Error(
          `Expected page name resolved from section-defaults, got: ${
            (pageFence as { attrsSafe?: { name?: string } }).attrsSafe?.name
          }`,
        );
      }

      // Issues sanity checks
      const issues = content.issues();

      const hasAttrsValidate = issues.some((i) => {
        const o = i as Record<string, unknown>;
        return o.kind === "attrs-validate" &&
          typeof o["blockIndex"] === "number";
      });
      if (!hasAttrsValidate) {
        throw new Error("Expected at least one 'attrs-validate' issue.");
      }

      const hasUnknownLangForBash = issues.some((i) => {
        const o = i as Record<string, unknown>;
        return o.kind === "unknown-language" && o["lang"] === "bash";
      });
      if (!hasUnknownLangForBash) {
        throw new Error("Expected an 'unknown-language' lint for bash fence.");
      }

      const hasFrontmatterErr = issues.some((i) =>
        (i as Record<string, unknown>).kind === "frontmatter-parse"
      );
      if (hasFrontmatterErr) {
        throw new Error("Did not expect frontmatter-parse error for good.md");
      }
    },
  );

  await t.step(
    "streams & validates from ReadableStream<Uint8Array> source",
    async () => {
      const goodStream = new Response(goodMd).body as ReadableStream<
        Uint8Array
      >;
      const content = sqlPageContent<FM, M>(
        sources(["good.stream.md", goodStream]),
        {
          fmSchema,
          attrSchemas: { sql: sqlAttrs },
        },
      );

      let count = 0;
      let sawPage = false;
      for await (const f of content.SQL()) {
        count++;
        if (
          (f as { attrsSafe?: { kind?: unknown } }).attrsSafe?.kind === "page"
        ) sawPage = true;
      }

      if (count !== 6) {
        throw new Error(`Streamed source: expected 6 sql fences, got ${count}`);
      }
      if (!sawPage) {
        throw new Error("Streamed source: did not see a typed 'page' fence.");
      }
    },
  );

  await t.step("strict attr validation drops failing fences", async () => {
    const contentStrict = sqlPageContent<FM, M>(
      sources(["good.md", goodMd]),
      {
        fmSchema,
        attrSchemas: { sql: sqlAttrs },
        strictAttrValidation: true,
      },
    );

    const strictFences: Fence[] = [];
    for await (const f of contentStrict.SQL()) {
      strictFences.push(f);
    }

    // Still 3 (head/page/tail) because the failing ones are dropped.
    if (strictFences.length !== 3) {
      throw new Error(
        `Expected 3 fences in strict mode, got ${strictFences.length}`,
      );
    }

    const kinds = strictFences
      .map((f) =>
        (f as { attrsSafe?: { kind?: "head" | "page" | "tail" } }).attrsSafe
          ?.kind
      )
      .sort();
    const expectKinds = ["head", "page", "tail"].sort();
    if (JSON.stringify(kinds) !== JSON.stringify(expectKinds)) {
      throw new Error(
        `Expected kinds ${expectKinds} in strict mode, got ${kinds}`,
      );
    }
  });

  await t.step(
    "frontmatter errors are captured and source is skipped",
    async () => {
      const badStream = new Response(badFmMd).body as ReadableStream<
        Uint8Array
      >;
      const contentBad = sqlPageContent<FM, M>(
        sources(["bad.stream.md", badStream]),
        {
          fmSchema,
          attrSchemas: { sql: sqlAttrs },
        },
      );

      const out: Fence[] = [];
      for await (const f of contentBad.SQL()) {
        out.push(f);
      }

      if (out.length !== 0) {
        throw new Error(
          `Expected 0 fences from bad frontmatter source, got ${out.length}`,
        );
      }

      const issues = contentBad.issues();
      const hasFmErr = issues.some((i) =>
        (i as Record<string, unknown>).kind === "frontmatter-parse"
      );
      if (!hasFmErr) {
        throw new Error(
          "Expected a 'frontmatter-parse' issue for bad frontmatter.",
        );
      }
    },
  );
});
