/**
 * properties_test.ts
 *
 * Dev-doc test for Spry properties (camelCase schemas + naming strategies):
 *  - Define schema in camelCase with Zod v4 (.describe, .meta)
 *  - Load via env/json/sql, mapping names via strategies
 *  - Observe events
 *  - Query with list()/byTag()/pick() and redaction
 *  - Resolve presented names back to canonical keys
 *  - Extend schemas and keep values
 *
 * Run:
 *   deno test -A lib/universal/properties_test.ts
 */

import { z } from "jsr:@zod/zod@4";
import {
  assert,
  assertEquals,
  assertMatch,
  assertObjectMatch,
  assertRejects,
} from "jsr:@std/assert@1";
import {
  envLoader,
  flatten,
  jsonLoader,
  Naming,
  propertiesBag,
  propertiesQuery,
  sqlRowLoader,
} from "./properties.ts";

function expect(cond: unknown, msg = "Expectation failed"): asserts cond {
  if (!cond) throw new Error(msg);
}

/* --------------------- Canonical camelCase schema ---------------------- */

const SpryProps = z.object({
  databaseUrl: z
    .string()
    .url()
    .describe("Primary DB connection string")
    .meta({ tags: ["infra", "sql"], required: true, sourceHint: "env" }),

  pageLimit: z
    .coerce.number()
    .int()
    .positive()
    .max(10_000)
    .default(100)
    .describe("Default LIMIT for pagination")
    .meta({ tags: ["sql"], sourceHint: "env" }),

  mode: z
    .enum(["discovery", "materialization", "both"])
    .default("both")
    .describe("Active phases")
    .meta({ tags: ["spry"], externalName: "assembly_mode" }),

  // Optional to avoid parse() failing during loadAll when unset
  secretToken: z
    .string()
    .min(12)
    .optional()
    .describe("Foundry token (keep secret)")
    .meta({ tags: ["secret"], redact: true }),
});

const URL_EXAMPLE = "https://db.example.com/postgres";

/* -------------------------------- Tests -------------------------------- */

Deno.test("assemblerProperties — developer doc (camelCase + naming)", async (t) => {
  const bag = propertiesBag(SpryProps);
  const q = propertiesQuery(bag);

  // Capture all events (doc + verification)
  const captured: Array<{ type: string; payload: unknown }> = [];
  const stopAll = bag.bus.all((type, detail) => {
    captured.push({ type, payload: detail });
  });

  await t.step("1) Zod defaults + required semantics", async () => {
    assertEquals(bag.get("mode"), "both");
    assertEquals(bag.get("pageLimit"), 100);

    await assertRejects(
      async () => {
        await Promise.resolve(bag.require("databaseUrl"));
      },
      Error,
      "Missing required property",
    );
  });

  await t.step("2) set() validates and emits 'prop:set'", () => {
    const parsed = bag.set("databaseUrl", URL_EXAMPLE, "manual-test");
    assertEquals(parsed, URL_EXAMPLE);
    assertEquals(bag.require("databaseUrl"), URL_EXAMPLE);

    const setEvent = captured.find((e) => e.type === "prop:set");
    expect(setEvent, "prop:set should have been captured");
    const pl = setEvent.payload as {
      key?: string;
      source?: string;
      value?: unknown;
    };
    expect(pl && pl.key === "databaseUrl", "prop:set key mismatch");
    expect(pl && pl.source === "manual-test", "prop:set source mismatch");
    expect(pl && pl.value === URL_EXAMPLE, "prop:set value mismatch");
  });

  await t.step(
    "3) Loader precedence with naming: env(SCREAMING_SNAKE) -> json(snake) -> sql(snake)",
    async () => {
      const bag2 = propertiesBag(SpryProps);
      const envName = "SPRY_DATABASE_URL"; // from camelCase + SCREAMING_SNAKE + prefix
      const prev = Deno.env.get(envName);

      try {
        Deno.env.set(envName, URL_EXAMPLE);

        // Attach waitFor BEFORE loadAll (event fires during load)
        const readyP = bag2.bus.waitFor("props:ready");

        await bag2.loadAll([
          envLoader({ prefix: "SPRY" }), // default: SCREAMING_SNAKE
          jsonLoader({ assembly_mode: "discovery", page_limit: 250 }), // default: snake_case
          sqlRowLoader({ page_limit: 777 }), // ignored: json already set
        ]);

        const ready = await readyP;
        assertEquals(bag2.require("databaseUrl"), URL_EXAMPLE);
        assertEquals(bag2.get("mode"), "discovery");
        assertEquals(bag2.get("pageLimit"), 250);

        const obj = ready.object;
        assertEquals(obj.databaseUrl, URL_EXAMPLE);
        assertEquals(obj.mode, "discovery");
        assertEquals(obj.pageLimit, 250);
      } finally {
        if (prev == null) Deno.env.delete(envName);
        else Deno.env.set(envName, prev);
      }
    },
  );

  await t.step(
    "4) Query facade: naming, redaction, byTag, pick, resolveName",
    () => {
      bag.set("secretToken", "supersecret_token_value", "manual-test");

      // Present names as SCREAMING_SNAKE for a CLI
      const listed = q.list({
        redactSecrets: true,
        nameAs: Naming.screamingSnake,
      });
      const secretRow = listed.find((r) => r.name === "SECRET_TOKEN");
      expect(secretRow, "SECRET_TOKEN row present");
      assertMatch(String(secretRow!.value), /\*\*\*/); // mask contains ***

      // Also verify snake_case naming
      const snake = q.list({ nameAs: Naming.snake });
      expect(
        snake.some((r) => r.name === "database_url"),
        "snake naming should transform keys",
      );

      // Filter by tag
      const onlySql = q.byTag("sql", Naming.snake);
      expect(
        onlySql.every((r) => Array.isArray(r.tags) && r.tags.includes("sql")),
        "byTag('sql') must filter correctly",
      );

      // resolveName: external name -> canonical key
      const key = q.resolveName("DATABASE_URL", Naming.screamingSnake);
      expect(
        key === "databaseUrl",
        "resolveName should map back to canonical key",
      );

      // Pick returns typed subset
      const picked = q.pick("databaseUrl", "pageLimit");
      assertEquals(typeof picked.databaseUrl, "string");
      assertEquals(typeof picked.pageLimit, "number");
    },
  );

  await t.step("5) extend() merges schemas and keeps values", async () => {
    const Extra = z.object({
      newFlag: z.boolean().default(true)
        .describe("Example extension flag").meta({ tags: ["spry"] }),
    });

    const merged = bag.extend(Extra);

    // Carry-forward works for existing keys
    assertEquals(merged.require("databaseUrl"), URL_EXAMPLE);
    // New default realizes
    assertEquals(merged.get("newFlag"), true);

    const readyP = merged.bus.waitFor("props:ready");
    await merged.loadAll([]);
    const ready = await readyP;
    expect(
      ready && ready.object && typeof ready.object.newFlag !== "undefined",
    );
    assertEquals(ready.object.newFlag, true);

    // Check naming still works after extend
    const snake = propertiesQuery(merged).list({ nameAs: Naming.snake });
    expect(
      snake.some((r) => r.name === "new_flag"),
      "extended key should appear in naming",
    );
  });

  await t.step("Appendix: developer snapshot (SCREAMING_SNAKE)", () => {
    // deno-lint-ignore no-console
    // console.table(
    //   q.list({ redactSecrets: true, nameAs: Naming.screamingSnake }),
    // );
  });

  stopAll();
});

Deno.test("flatten — unified behavior", async (t) => {
  function indexByName<T extends { name: string }>(rows: Iterable<T>) {
    const m = new Map<string, T>();
    for (const r of rows) m.set(r.name, r);
    return m;
  }

  // ── Fixtures (shared across subtests) ────────────────────────────────────
  const Schema = z.object({
    id: z.string().describe("Project ID"),
    paths: z.object({
      projectHome: z.string().describe("Project home"),
      projectSrcHome: z.string().describe("Project src"),
      numbers: z.array(z.number()).describe("Numeric list"),
      flags: z.object({
        debug: z.boolean().describe("Debug flag"),
      }).describe("Flags"),
    }).describe("Paths"),
    labels: z.record(z.string(), z.string()).describe("Labels"),
    mode: z.enum(["dev", "prod"]).describe("Mode"),
    count: z.number().describe("Count"),
    maybe: z.string().optional().describe("Maybe string"),
    nully: z.string().nullable().describe("Nullable string"),
    secrets: z.object({
      token: z.string().describe("Secret token"),
    }).describe("Secrets"),
  });

  type Props = z.infer<typeof Schema>;
  const sampleBase: Props = {
    id: "abc",
    paths: {
      projectHome: "/p",
      projectSrcHome: "/p/src",
      numbers: [1, 2, 3],
      flags: { debug: true },
    },
    labels: { a: "x", b: "y" },
    mode: "dev",
    count: 5,
    // maybe intentionally omitted
    nully: null,
    secrets: { token: "shh" },
  };

  const bag = propertiesBag(Schema);
  const f = flatten(bag);

  // ── 1) Default traversal, naming, comments, hints ───────────────────────
  await t.step("default traversal, naming, comments, hints", () => {
    const rows = [...f.entries(sampleBase)];
    const by = indexByName(rows);

    // Scalars
    assert(by.has("ID"));
    assertEquals(by.get("ID")!.value, "abc");
    assertEquals(by.get("ID")!.comment, "Project ID");
    assertEquals(by.get("ID")!.valueHint, "string");

    // Nested object
    assert(by.has("PATHS_PROJECT_HOME"));
    assertEquals(by.get("PATHS_PROJECT_HOME")!.value, "/p");
    assertEquals(by.get("PATHS_PROJECT_HOME")!.comment, "Project home");
    assertEquals(by.get("PATHS_PROJECT_HOME")!.valueHint, "string");

    // Boolean leaf
    assert(by.has("PATHS_FLAGS_DEBUG"));
    assertEquals(by.get("PATHS_FLAGS_DEBUG")!.value, "true");
    assertEquals(by.get("PATHS_FLAGS_DEBUG")!.comment, "Debug flag");
    assertEquals(by.get("PATHS_FLAGS_DEBUG")!.valueHint, "boolean");

    // Arrays by index
    assert(by.has("PATHS_NUMBERS_0"));
    assertEquals(by.get("PATHS_NUMBERS_0")!.value, "1");
    assertEquals(by.get("PATHS_NUMBERS_0")!.valueHint, "number");
    assert(by.has("PATHS_NUMBERS_2"));
    assertEquals(by.get("PATHS_NUMBERS_2")!.value, "3");

    // Record<string,string>
    assert(by.has("LABELS_A"));
    assertEquals(by.get("LABELS_A")!.value, "x");
    assertEquals(by.get("LABELS_A")!.valueHint, "string");
    assert(by.has("LABELS_B"));
    assertEquals(by.get("LABELS_B")!.value, "y");

    // Enum hint
    assert(by.has("MODE"));
    assertEquals(by.get("MODE")!.value, "dev");
    assertEquals(by.get("MODE")!.valueHint, "enum");

    // Optional omitted → no row
    assert(!by.has("MAYBE"));

    // Nullable null → skipped by default
    assert(!by.has("NULLY"));

    // Secrets present by default
    assert(by.has("SECRETS_TOKEN"));
    assertEquals(by.get("SECRETS_TOKEN")!.value, "shh");

    // record(prefix)
    const rec = f.record("FOUNDRY_", sampleBase);
    assertObjectMatch(rec, {
      FOUNDRY_ID: "abc",
      FOUNDRY_MODE: "dev",
      FOUNDRY_COUNT: "5",
      FOUNDRY_PATHS_PROJECT_HOME: "/p",
      FOUNDRY_SECRETS_TOKEN: "shh",
    });
    assertEquals("FOUNDRY_MAYBE" in rec, false);
  });

  // ── 2) Aggregate (emit once) & skip subtree ─────────────────────────────
  await t.step("aggregate (emit once) & skip subtree", () => {
    // Aggregate: emit PATHS_JSON once; suppress child leaves
    const aggregated = [
      ...f.entries(sampleBase, {
        name: (segs) =>
          segs.length === 1 && segs[0] === "paths"
            ? "PATHS_JSON"
            : segs.map((s) =>
              s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()
            ).join("_"),
        value: (v, segs, _znode) => {
          if (segs.length === 1 && segs[0] === "paths") {
            return JSON.stringify(v);
          }
          if (v == null) return false;
          if (
            typeof v === "string" || typeof v === "number" ||
            typeof v === "boolean"
          ) {
            return String(v);
          }
          return undefined;
        },
      }),
    ];
    const agBy = indexByName(aggregated);
    assert(agBy.has("PATHS_JSON"));
    assertEquals(agBy.get("PATHS_JSON")!.comment, "Paths");
    assertEquals(agBy.get("PATHS_JSON")!.valueHint, "object");
    assertEquals(
      agBy.get("PATHS_JSON")!.value,
      JSON.stringify(sampleBase.paths),
    );

    const hasPathLeaf = aggregated.some((r) =>
      r.name.startsWith("PATHS_PROJECT_") ||
      r.name.startsWith("PATHS_FLAGS_") ||
      r.name.startsWith("PATHS_NUMBERS_")
    );
    assertEquals(hasPathLeaf, false);

    // Skip: drop entire 'secrets' subtree
    const noSecrets = [
      ...f.entries(sampleBase, {
        value: (_v, segs) => (segs[0] === "secrets" ? false : undefined),
      }),
    ];
    const hasSecrets = noSecrets.some((r) => r.name.startsWith("SECRETS_"));
    assertEquals(hasSecrets, false);
  });

  // ── 3) Per-call naming overrides, aliasing, and record() ────────────────
  await t.step("per-call naming overrides, aliasing, and record()", () => {
    // entries(): drop 'paths' and alias projectSrcHome → SRC_HOME
    const rows = [
      ...f.entries(sampleBase, {
        name: (segs) => {
          const alias: Record<string, string> = { projectSrcHome: "SRC_HOME" };
          let s = [...segs];
          if (s[0] === "paths") s = s.slice(1);
          s = s.map((seg) => alias[seg] ?? seg);
          return s
            .map((seg) =>
              seg.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()
            )
            .join("_");
        },
      }),
    ];
    const by = indexByName(rows);
    assert(by.has("PROJECT_HOME"));
    assert(by.has("SRC_HOME"));
    assert(!rows.some((r) => r.name.startsWith("PATHS_")));

    // record(): same naming logic, plus prefix
    const out = f.record(
      "APP_",
      sampleBase,
      {
        name: (segs) => {
          const alias: Record<string, string> = { projectSrcHome: "SRC_HOME" };
          let s = [...segs];
          if (s[0] === "paths") s = s.slice(1); // <-- FIX: drop 'paths' for record() too
          s = s.map((seg) => alias[seg] ?? seg);
          return s
            .map((seg) =>
              seg.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()
            )
            .join("_");
        },
        value: (v) => {
          if (v == null) return false;
          if (
            typeof v === "string" || typeof v === "number" ||
            typeof v === "boolean"
          ) {
            return String(v);
          }
          return undefined;
        },
      },
    );

    assertObjectMatch(out, {
      APP_ID: "abc",
      APP_MODE: "dev",
      APP_COUNT: "5",
      APP_PROJECT_HOME: "/p",
      APP_SRC_HOME: "/p/src",
    });
  });

  // ── 4) Optional present and nullable non-null ───────────────────────────
  await t.step("optional present and nullable non-null emitted", () => {
    const withOptionals: Props = { ...sampleBase, maybe: "hello", nully: "ok" };
    const rows = [...f.entries(withOptionals)];
    const by = indexByName(rows);

    assert(by.has("MAYBE"));
    assertEquals(by.get("MAYBE")!.value, "hello");
    assertEquals(by.get("MAYBE")!.valueHint, "string");

    assert(by.has("NULLY"));
    assertEquals(by.get("NULLY")!.value, "ok");
    assertEquals(by.get("NULLY")!.valueHint, "string");
  });
});
