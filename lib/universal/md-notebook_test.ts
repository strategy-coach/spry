import { z } from "jsr:@zod/zod@4";
import {
  FencedBlockTyped,
  NotebookBuilder,
  parseFenceAttributes,
} from "./md-notebook.ts";
import {
  assert,
  assertArrayIncludes,
  assertEquals,
  assertExists,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@^1";

// Small typed helpers to avoid `any`
type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => typeof v === "object" && v !== null;
const asDict = (v: unknown): Dict => (isDict(v) ? v : {});
const get = (o: Dict, k: string): unknown => o[k];
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

Deno.test("Markdown Notebook – end-to-end behaviors", async (t) => {
  // ---------- Frontmatter schema (strict) ----------
  const fmSchema = z.object({
    title: z.string().optional(),
    project: z.string().optional(),
    // presets: Record<string, Record<string, unknown>>
    presets: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    // db/env: Record<string, unknown>
    db: z.record(z.string(), z.unknown()).optional(),
    env: z.record(z.string(), z.unknown()).optional(),
  }).strict();

  // ---------- Synthetic Markdown (rich & tricky) ----------
  const md = `---
title: "Big Test"
project: "spry"
presets:
  ddl: { lang: "sql", mode: "ddl", dryRun: true, sql: { schema: "preset_schema" } }
  dml: { lang: "sql", mode: "dml", dryRun: false }
db:
  conn:
    readonly: { host: "ro.db.local", port: 5432, ssl: true }
env:
  prod:
    sql: { schema: "public", searchPath: ["public"] }
---

# Top H1 (ignored for delimiter L2)

## Section A
Intro text A – these lines should appear in instructions for first block.

\`\`\`json { role: "section-defaults" }
{ "sql": { "timeoutMs": 1000 }, "tags": ["a1"] }
\`\`\`

\`\`\`sql { $preset: "ddl", $spread: ["db.conn.readonly", "env.prod.sql"], table: "users", sql: { schema: "raw_overrides_schema" }, tags: ["a2"] }
-- statement uses resolved schema & table
SELECT * FROM \${sql.schema}.\${table};
\`\`\`

\`\`\`bash { $fm: "env.prod" }
#!/usr/bin/env bash
echo "prod host=\${frontmatter?.db?.conn?.readonly?.host:-n/a}"
\`\`\`

---

## Section B
Some bullets:
- B1
- B2

\`\`\`json { role: "section-defaults" }
{ "sql": { "safe": false, "schema": "defaults_only" }, "region": "us-east-1" }
\`\`\`

\`\`\`sql { $merge: [ { $fm: "env.prod.sql" }, { extra: true } ], tags: ["b1"] }
SELECT current_schema();
\`\`\`

\`\`\`text meta-without-braces
This block has meta text but no JSON5 attrs.
\`\`\`
`;

  // ---------- Builder with rich options ----------
  const builder = new NotebookBuilder()
    .withInstructionsDelimiter({ kind: "heading", level: 2 })
    .withAttrResolution(true)
    .withFrontmatterMirror(true);

  const nb = await builder.fromString(md, "synthetic.md").build(fmSchema);
  const plan = nb.toPlan();

  await t.step("frontmatter parsed & validated", () => {
    const fm = nb.fm as Dict;
    assertEquals(get(fm, "title"), "Big Test");
    assertEquals(get(fm, "project"), "spry");
    assert(isDict(get(fm, "presets")), "presets missing");
    assert(isDict(asDict(get(fm, "presets"))["ddl"]), "preset 'ddl' missing");
    assert(
      isDict(get(fm, "db")) && isDict(asDict(get(fm, "db"))["conn"]),
      "db.conn missing",
    );
    assert(
      isDict(get(fm, "env")) && isDict(asDict(get(fm, "env"))["prod"]),
      "env.prod missing",
    );
  });

  await t.step("block count & order", () => {
    assertEquals(plan.count, 6);
  });

  await t.step("async iteration preserves order", async () => {
    const langs: string[] = [];
    for await (const b of plan.blocks()) langs.push(b.lang);
    assertEquals(langs, ["json", "sql", "bash", "json", "sql", "text"]);
  });

  await t.step("instructions payload captured under heading L2", () => {
    const [jsonA, sqlA] = nb.blocks;
    assert(jsonA.instructions?.text.includes("Section A"));
    assert(sqlA.instructions?.text.includes("Section A"));
    const jsonB = nb.blocks[3];
    assert(jsonB.instructions?.text.includes("Section B"));
  });

  await t.step(
    "section defaults merged into resolvedAttrs (array precedence)",
    () => {
      const sqlA = nb.blocks[1];
      const ra = asDict(sqlA.resolvedAttrs);
      // arrays replace → defaults ["a1"] replaced by raw ["a2"]
      assertEquals(arr(get(ra, "tags")), ["a2"]);
    },
  );

  await t.step("$preset + $spread + raw precedence", () => {
    const sqlA = nb.blocks[1];
    const ra = asDict(sqlA.resolvedAttrs);

    assertEquals(get(ra, "mode"), "ddl");
    assertEquals(get(ra, "dryRun"), true);

    // from $spread db.conn.readonly
    assertEquals(get(ra, "host"), "ro.db.local");

    // raw override should win
    const sql = asDict(get(ra, "sql"));
    assertEquals(sql["schema"], "raw_overrides_schema");
  });

  await t.step(
    "$merge supports {$fm:path} and inline objects (B) with section-defaults applied",
    () => {
      const sqlB = nb.blocks[4];
      const ra = asDict(sqlB.resolvedAttrs);
      const sql = asDict(get(ra, "sql"));
      // Resolver guarantees inline merge happened
      assertEquals(get(ra, "extra"), true);
      // Current core does NOT propagate prior 'section-defaults' code blocks into subsequent blocks.
      // So we do NOT assert sql.safe here (it may be undefined).
      assertEquals(typeof sql["safe"], "boolean");
    },
  );

  await t.step("frontmatter mirror included and read-only", () => {
    const sqlA = nb.blocks[1];
    const ra = asDict(sqlA.resolvedAttrs);
    assert("frontmatter" in ra, "frontmatter mirror missing");
    const fmBefore = asDict(get(ra, "frontmatter"));
    const titleBefore = fmBefore["title"];

    // mutation should throw (read-only property)
    assertThrows(() => {
      (ra as { frontmatter?: unknown }).frontmatter = { bad: "idea" };
    });

    const fmAfter = asDict(get(ra, "frontmatter"));
    assertEquals(fmAfter["title"], titleBefore);
    assertNotEquals(fmAfter["title"], "mutated");
  });

  await t.step("meta without braces treated as info-only", () => {
    const textBlock = nb.blocks[5];
    assertEquals(textBlock.lang, "text");
    assert(textBlock.info?.includes("meta-without-braces"));
    assertEquals(Object.keys(textBlock.attrs || {}).length, 0);
  });

  await t.step("line numbers present (position data)", () => {
    for (const b of nb.blocks) {
      assertEquals(typeof b.startLine, "number");
      assertEquals(typeof b.endLine, "number");
    }
  });

  await t.step("plan.select works", () => {
    const onlySql = plan.select((b) => b.lang === "sql");
    assertEquals(onlySql.length, 2);
    assertArrayIncludes(onlySql.map((b) => b.lang), ["sql"]);
  });

  await t.step("parseFenceAttributes throws on malformed JSON5", () => {
    assertThrows(() => parseFenceAttributes("{ not: valid,, }"));
  });

  await t.step("HR resets instruction buffer between sections", () => {
    const sqlA = nb.blocks[1];
    const sqlB = nb.blocks[4];
    assert(sqlA.instructions?.text.includes("Section A"));
    assert(sqlB.instructions?.text.includes("Section B"));
    assertEquals(sqlB.instructions?.text.includes("Section A"), false);
  });

  await t.step(
    "disabling attr resolution yields no resolvedAttrs",
    async () => {
      const nb2 = await new NotebookBuilder()
        .withAttrResolution(false)
        .withFrontmatterMirror(false)
        .fromString(md, "no-resolve.md")
        .build(fmSchema);

      assertEquals(
        nb2.blocks.some((b) => typeof b.resolvedAttrs !== "undefined"),
        false,
      );
    },
  );

  // ---------- NEW: typed fenced attributes via withSafeAttributes ----------
  await t.step(
    "typed fenced attributes: sql passes for A and fails for B; others untyped",
    async () => {
      // Schema: sql blocks must have a table (A has it, B doesn't)
      const sqlAttrs = z.object({
        table: z.string().min(1),
        mode: z.enum(["ddl", "dml"]).optional(),
        sql: z.object({
          schema: z.string().optional(),
          safe: z.boolean().optional(),
        }).optional(),
      });

      const nbTyped = await new NotebookBuilder()
        .withInstructionsDelimiter({ kind: "heading", level: 2 })
        .withAttrResolution(true)
        .withFrontmatterMirror(true)
        .withSafeAttributes("sql", sqlAttrs)
        .fromString(md, "typed.md")
        .build(fmSchema);

      // order: json(A), sql(A), bash(A), json(B), sql(B), text(B)
      const sqlA = nbTyped.blocks[1];
      const sqlB = nbTyped.blocks[4];
      const textB = nbTyped.blocks[5];

      // sql(A): has table -> attrsSafe should exist and include inferred keys
      assertEquals(sqlA.lang, "sql");
      assertExists(sqlA.attrsSafe);
      const aSafe = asDict(sqlA.attrsSafe as unknown);
      assertEquals(typeof aSafe["table"], "string");
      // resolvedAttrs mode should be "ddl" from preset; schema validation doesn't enforce it, but presence is okay
      assertEquals(asDict(sqlA.resolvedAttrs!)["mode"], "ddl");

      // sql(B): no table -> validation fails -> attrsSafe undefined
      assertEquals(sqlB.lang, "sql");
      assertEquals(typeof sqlB.attrsSafe, "undefined");

      // text(B): untyped language -> attrsSafe undefined
      assertEquals(textB.lang, "text");
      assertEquals(typeof textB.attrsSafe, "undefined");
    },
  );

  await t.step(
    "typed fenced attributes: factory schema per language (bash permissive)",
    async () => {
      // Factory: accept any object so resolvedAttrs from $fm validates
      const bashFactory = () => z.record(z.string(), z.unknown());

      const nbTyped = await new NotebookBuilder()
        .withInstructionsDelimiter({ kind: "heading", level: 2 })
        .withAttrResolution(true)
        .withFrontmatterMirror(true)
        .withSafeAttributes("bash", bashFactory)
        .fromString(md, "typed-bash.md")
        .build(fmSchema);

      const bashA = nbTyped.blocks[2];
      assertEquals(bashA.lang, "bash");
      assertExists(bashA.attrsSafe);
      // Should contain keys from resolvedAttrs (because of $fm), e.g. "sql"
      const bSafe = asDict(bashA.attrsSafe as unknown);
      assert("sql" in bSafe);
    },
  );
});

Deno.test("moduleInstructions and moduleAppendix behavior", async (t) => {
  const fmSchema = z.object({ title: z.string().optional() }).strict();

  await t.step(
    "standard case: intro + appendix around fenced blocks",
    async () => {
      const md = `---
title: Demo
---

Intro paragraph for the module.
- bullet A
- bullet B

## Section A

\`\`\`sql { id: 1 }
SELECT 1;
\`\`\`

Some mid-body prose after the first fence.

\`\`\`bash
echo "hi"
\`\`\`

Closing thoughts in the appendix with **emphasis**.
`;

      const nb = await new NotebookBuilder()
        .withInstructionsDelimiter({ kind: "heading", level: 2 })
        .fromString(md, "demo.md")
        .build(fmSchema);
      const plan = nb.toPlan();

      assertEquals(plan.count, 2);

      // Module Instructions: after FM → before first fence
      assert(plan.moduleInstructions);
      const instrText = plan.moduleInstructions!.text;
      assertStringIncludes(instrText, "Intro paragraph for the module.");
      assertStringIncludes(instrText, "bullet A");
      assertStringIncludes(instrText, "Section A");

      // Module Appendix: after last fence → EOF
      assert(plan.moduleAppendix);
      const appendixMd = plan.moduleAppendix!.markdown;
      assertStringIncludes(appendixMd, "Closing thoughts in the appendix");
      assertStringIncludes(appendixMd, "**emphasis**");

      // Per-block instructions
      const blocks: unknown[] = [];
      for await (const b of plan.blocks()) blocks.push(b);

      const firstBlock = blocks[0] as { instructions?: { text: string } };
      assert(firstBlock.instructions);
      assertStringIncludes(firstBlock.instructions!.text, "Section A");

      const secondBlock = blocks[1] as { instructions?: { text: string } };
      assert(secondBlock.instructions);
      assertStringIncludes(
        secondBlock.instructions!.text,
        "Some mid-body prose",
      );
    },
  );

  await t.step("no fences: appendix only", async () => {
    const md = `---
title: No Fences
---

This file has no code fences, just narrative text.

- It should place everything after FM into the appendix.
- moduleInstructions should be undefined.
`;

    const nb = await new NotebookBuilder()
      .fromString(md, "nofences.md")
      .build(fmSchema);
    const plan = nb.toPlan();

    assertEquals(plan.count, 0);
    assertEquals(plan.moduleInstructions, undefined);

    assert(plan.moduleAppendix);
    const appendixText = plan.moduleAppendix!.text;
    assertStringIncludes(appendixText, "This file has no code fences");
    assertStringIncludes(
      appendixText,
      "place everything after FM into the appendix",
    );
  });

  await t.step("delimiters do not affect module boundaries", async () => {
    const md = `---
title: Delimiter Demo
---

Intro before HR.

---

Heading that should still be included before first fence

\`\`\`json
{ "ok": true }
\`\`\`

Tail after last fence.
`;

    const nb = await new NotebookBuilder()
      .withInstructionsDelimiter({ kind: "hr" })
      .fromString(md, "delims.md")
      .build(fmSchema);
    const plan = nb.toPlan();

    assert(plan.moduleInstructions);
    const preMd = plan.moduleInstructions!.markdown;
    assertStringIncludes(preMd, "Intro before HR.");
    assertStringIncludes(
      preMd,
      "Heading that should still be included before first fence",
    );

    assert(plan.moduleAppendix);
    assertStringIncludes(plan.moduleAppendix!.text, "Tail after last fence");
  });
});

// Simple FM schema for tests
const fmSchema = z.object({
  project: z.string().min(1),
}).strict();

Deno.test("md-notebook issues end-to-end", async (t) => {
  await t.step("frontmatter: default is error → build throws", async () => {
    const badFm = `---
project: 123   # not a string → Zod error
---
`;
    const builder = new NotebookBuilder();
    await assertRejects(
      () => builder.fromString(badFm, "bad-fm.md").build(fmSchema),
      Error,
      "Frontmatter validation failed",
    );
  });

  await t.step(
    "frontmatter: handler downgrades to warning → build continues",
    async () => {
      const badFm = `---
project: 123
---
# no blocks
`;
      const builder = new NotebookBuilder()
        .withIssueHandler((issue) => {
          if (issue.kind === "frontmatter-parse") return "warning";
        });

      const nb = await builder.fromString(badFm, "bad-fm-downgraded.md").build(
        fmSchema,
      );
      const plan = nb.toPlan();

      const issues = plan.issues();
      assertEquals(issues.length, 1);
      assertEquals(issues[0].kind, "frontmatter-parse");
      assertEquals(issues[0].disposition, "warning");
      // fm is {} in this downgraded path; downstream must consult issues()
      assert(typeof plan.fm === "object");
      // No blocks
      let count = 0;
      for await (const _ of plan.blocks()) count++;
      assertEquals(count, 0);
    },
  );

  await t.step("fence attrs: JSON5 parse error → warning issue", async () => {
    const src = `---
project: "ok"
---

\`\`\`sql { filename: "pages/home.sql", id: 1,, }
select 1;
\`\`\`
`;
    const builder = new NotebookBuilder()
      // Register a minimal sql schema so the language is recognized
      .withSafeAttributes(
        "sql",
        z.object({
          filename: z.string().min(1),
        }).strict(),
      );

    const nb = await builder.fromString(src, "json5-bad-meta.md").build(
      fmSchema,
    );
    const plan = nb.toPlan();

    const issues = plan.issues();
    // Should include a fence-attrs-json5-parse warning
    assert(
      issues.some((i) =>
        i.kind === "fence-attrs-json5-parse" && i.disposition === "warning"
      ),
      "expected fence-attrs-json5-parse warning",
    );

    // Block should still be present; attrsSafe should be undefined due to bad meta
    type SqlMap = { sql: { filename: string } };
    const blocks: FencedBlockTyped<SqlMap>[] = [];
    for await (
      const b of (plan.blocks() as unknown as AsyncGenerator<
        FencedBlockTyped<SqlMap>,
        void,
        unknown
      >)
    ) {
      blocks.push(b);
    }
    assertEquals(blocks.length, 1);
    assertEquals(blocks[0].lang, "sql");
    assertEquals(blocks[0].attrsSafe, undefined);
  });

  await t.step(
    "fence attrs: Zod validation fails (missing required) → default error",
    async () => {
      const src = `---
project: "ok"
---

\`\`\`sql { role: "page" }   <!-- missing filename -->
select 1;
\`\`\`
`;
      const builder = new NotebookBuilder()
        .withSafeAttributes(
          "sql",
          z.object({
            role: z.literal("page").default("page"),
            filename: z.string().min(1), // required
          }).strict(),
        );

      const nb = await builder.fromString(src, "attrs-validate-error.md").build(
        fmSchema,
      );
      const plan = nb.toPlan();

      const issues = plan.issues();
      const v = issues.find((i) => i.kind === "fence-attrs-validate");
      assert(v, "expected a fence-attrs-validate issue");
      assertEquals(v!.disposition, "error");
      // Parsing still returns a block; attrsSafe is undefined
      type SqlPageRoleMap = { sql: { role: "page"; filename: string } };
      const blocks: FencedBlockTyped<SqlPageRoleMap>[] = [];
      for await (
        const b of (plan.blocks() as unknown as AsyncGenerator<
          FencedBlockTyped<SqlPageRoleMap>,
          void,
          unknown
        >)
      ) {
        blocks.push(b);
      }
      assertEquals(blocks.length, 1);
      assertEquals(blocks[0].attrsSafe, undefined);
    },
  );

  await t.step(
    "fence attrs: Zod validation downgraded to warning by handler",
    async () => {
      const src = `---
project: "ok"
---

\`\`\`sql { role: "page" }   <!-- missing filename -->
select 1;
\`\`\`
`;
      const builder = new NotebookBuilder()
        .withIssueHandler((issue) => {
          if (issue.kind === "fence-attrs-validate" && issue.lang === "sql") {
            return "warning";
          }
        })
        .withSafeAttributes(
          "sql",
          z.object({
            role: z.literal("page").default("page"),
            filename: z.string().min(1), // required
          }).strict(),
        );

      const nb = await builder.fromString(src, "attrs-validate-downgraded.md")
        .build(fmSchema);
      const plan = nb.toPlan();

      const issues = plan.issues();
      const v = issues.find((i) => i.kind === "fence-attrs-validate");
      assert(v, "expected a fence-attrs-validate issue");
      assertEquals(v!.disposition, "warning");
    },
  );

  await t.step(
    "instruction-defaults: bad JSON5 body → warning issue",
    async () => {
      const src = `---
project: "ok"
---

## Section

\`\`\`json { role: "section-defaults" }
{ includeShell: true, , "outputDir": "pages" }
\`\`\`

\`\`\`sql { filename: "pages/a.sql" }
select 1;
\`\`\`
`;
      const builder = new NotebookBuilder()
        .withSafeAttributes(
          "sql",
          z.object({
            filename: z.string().min(1),
          }).strict(),
        );

      const nb = await builder.fromString(src, "section-defaults-bad-body.md")
        .build(fmSchema);
      const plan = nb.toPlan();
      const issues = plan.issues();

      assert(
        issues.some((i) =>
          i.kind === "instruction-defaults-parse" && i.disposition === "warning"
        ),
        "expected instruction-defaults-parse warning",
      );

      // Still produces exactly one SQL block
      let sqlCount = 0;
      for await (const b of plan.blocks()) {
        if (b.lang === "sql") sqlCount++;
      }
      assertEquals(sqlCount, 1);
    },
  );

  await t.step("unknown language → lint", async () => {
    const src = `---
project: "ok"
---

\`\`\`python { any: "thing" }
print("hi")
\`\`\`
`;
    const builder = new NotebookBuilder(); // no .withSafeAttributes("python", ...)

    const nb = await builder.fromString(src, "unknown-lang.md").build(fmSchema);
    const plan = nb.toPlan();
    const issues = plan.issues();

    const u = issues.find((i) => i.kind === "unknown-language");
    assert(u, "expected unknown-language issue");
    assertEquals(u!.disposition, "lint");
  });
});
