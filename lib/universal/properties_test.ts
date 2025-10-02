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
  assertEquals,
  assertMatch,
  assertObjectMatch,
  assertRejects,
} from "jsr:@std/assert@1";
import {
  envLoader,
  flattenedEnvLike,
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

/** Helper used in tests: SCREAMING_SNAKE a single segment. */
const SNAKE = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();

Deno.test("flattenedEnvLike — behavior & docs", async (t) => {
  await t.step(
    "defaults: SCREAMING_SNAKE + primitives; arrays use indexes; null/undefined skipped",
    () => {
      const obj = {
        id: "abc",
        paths: {
          projectHome: "/p",
          projectSrcHome: "/p/src",
          nested: { deep: true },
          arr: [1, 2],
          nothing: null,
          undef: undefined,
        },
      };

      const out = flattenedEnvLike(obj); // default name transform
      const expected = {
        ID: "abc",
        PATHS_PROJECT_HOME: "/p",
        PATHS_PROJECT_SRC_HOME: "/p/src",
        PATHS_NESTED_DEEP: "true",
        PATHS_ARR_0: "1",
        PATHS_ARR_1: "2",
      };

      assertObjectMatch(out, expected);
      // ensure null/undefined not present
      assertEquals("PATHS_NOTHING" in out, false);
      assertEquals("PATHS_UNDEF" in out, false);
    },
  );

  await t.step(
    "name transform: drop top-level 'paths' and SCREAMING_SNAKE the rest",
    () => {
      const obj = {
        id: "abc",
        paths: { projectHome: "/p", projectSrcHome: "/p/src" },
      };

      const out = flattenedEnvLike(obj, {
        name: (segments) => {
          const s = segments[0] === "paths" ? segments.slice(1) : segments;
          return s.length ? s.map(SNAKE).join("_") : false;
        },
      });

      assertObjectMatch(out, {
        ID: "abc",
        PROJECT_HOME: "/p",
        PROJECT_SRC_HOME: "/p/src",
      });
      // default would include PATHS_*; confirm it does not
      assertEquals("PATHS_PROJECT_HOME" in out, false);
    },
  );

  await t.step(
    "value transform: emit whole subtree as JSON (single PATHS_JSON key)",
    () => {
      const obj = {
        id: "abc",
        paths: { projectHome: "/p", projectSrcHome: "/p/src" },
      };

      const out = flattenedEnvLike(obj, {
        name: (
          p,
        ) => (p.length === 1 && p[0] === "paths"
          ? "PATHS_JSON"
          : SNAKE(p.join(".")).replace(/\./g, "_")),
        value: (
          v,
          p,
        ) => (p.length === 1 && p[0] === "paths"
          ? JSON.stringify(v)
          : undefined),
      });

      assertEquals(Object.keys(out).sort(), ["ID", "PATHS_JSON"]);
      assertEquals(out.ID, "abc");
      assertEquals(out.PATHS_JSON, JSON.stringify(obj.paths));
    },
  );

  await t.step("value transform: skip secrets subtree entirely", () => {
    const obj = {
      mode: "dev",
      secrets: {
        token: "shh",
        nested: { inner: "nope" },
      },
    };

    const out = flattenedEnvLike(obj, {
      name: (p) => p.map(SNAKE).join("_"),
      value: (_v, p) => (p[0] === "secrets" ? false : undefined),
    });

    assertObjectMatch(out, { MODE: "dev" });
    // ensure secrets did not leak
    assertEquals(Object.keys(out).some((k) => k.startsWith("SECRETS")), false);
  });

  await t.step("arrays: indices included", () => {
    const obj = { items: ["a", "b"] };
    const out = flattenedEnvLike(obj, { name: (p) => p.map(SNAKE).join("_") });
    assertObjectMatch(out, { ITEMS_0: "a", ITEMS_1: "b" });
  });

  await t.step(
    "name transform: alias segments and drop 'fs' prefix on final segment",
    () => {
      const props = {
        paths: {
          spryStd: {
            sqlDropIn: {
              fsHeadHome: "/head",
              fsTailHome: "/tail",
            },
          },
        },
      };

      const out = flattenedEnvLike(props, {
        name: (segments) => {
          // remove top-level "paths"
          let s = segments[0] === "paths" ? segments.slice(1) : segments;

          // alias certain segments
          const alias: Record<string, string> = {
            spryStd: "SPRY_STD",
            projectSqlDropIn: "PROJECT_SQLD",
            sqlDropIn: "SQLD",
            spryDropIn: "SPRYD",
          };
          s = s.map((seg) => alias[seg] ?? seg);

          // drop a leading "fs" on the final segment
          if (s.length) {
            const last = s[s.length - 1];
            s[s.length - 1] = last.startsWith("fs") && last.length > 2
              ? last.slice(2)
              : last;
          }
          return s.map(SNAKE).join("_");
        },
      });
      assertObjectMatch(out, {
        SPRY_STD_SQLD_HEAD_HOME: "/head",
        SPRY_STD_SQLD_TAIL_HOME: "/tail",
      });
      assertEquals("PATHS_SPRY_STD_SQL_DROP_IN_FS_HEAD_HOME" in out, false);
    },
  );

  await t.step("name transform: return false to skip specific leaves", () => {
    const obj = { id: "abc", keepMe: 42 };
    const out = flattenedEnvLike(obj, {
      name: (
        p,
      ) => (p.length === 1 && p[0] === "id" ? false : p.map(SNAKE).join("_")),
    });
    assertObjectMatch(out, { KEEP_ME: "42" });
    assertEquals("ID" in out, false);
  });
});
