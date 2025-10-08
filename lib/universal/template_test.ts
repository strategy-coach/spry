// Deno 2.x tests for template.ts (no unstable flags required)
import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import { safeDenoEvaluator, unsafeJsEvaluator } from "./template.ts";

Deno.test("template.ts — evaluator", async (t) => {
  await t.step(
    "basic render with ctx generic (no function globals)",
    async () => {
      const { evaluate } = safeDenoEvaluator<{ user: string }>({
        globals: { app: "spry" },
        timeoutMs: 1500,
      });

      const runner = await evaluate(
        `Hello \${ctx.user.toUpperCase()} from \${globals.app}!
List: \${["a","b","c"].join(", ")}
`,
      );
      const out = await runner({ user: "shahid" });
      assert(out.includes("Hello SHAHID from spry!"));
      assert(out.includes("List: a, b, c"));
    },
  );

  await t.step("one-shot evaluate(code, ctx) overload", async () => {
    const { evaluate } = safeDenoEvaluator<{ n: number }>();
    const out = await evaluate("Value: ${ctx.n + 1}", { n: 41 });
    assertEquals(out.trim(), "Value: 42");
  });

  await t.step("imports: remote std (uuid) without net perms", async () => {
    const { evaluate } = safeDenoEvaluator({
      imports: [
        { spec: "https://deno.land/std@0.224.0/uuid/mod.ts", as: "uuid" },
      ],
    });
    const out = await evaluate(
      `UUID: \${uuid.v1.generate()}`,
      {},
    );
    assert(out.startsWith("UUID: "));
    assertMatch(out, /UUID:\s+[0-9a-f-]{36}/);
  });

  await t.step(
    "safety: Deno.* unavailable (shadowed) on stable worker",
    async () => {
      const { evaluate } = safeDenoEvaluator();
      await assertRejects(
        () => evaluate(`\${Deno.env.get("HOME")}`, {}),
        Error,
      );
    },
  );

  await t.step("timeout: long-running template is killed", async () => {
    const { evaluate } = safeDenoEvaluator({ timeoutMs: 200 });
    await assertRejects(
      () => evaluate("Begin ${await new Promise<string>(() => {})} End", {}),
      Error,
      "timed out",
    );
  });

  await t.step(
    "ctx must be structured-cloneable; functions belong in imports, not ctx/globals",
    async () => {
      const { evaluate } = safeDenoEvaluator<{ msg: string }>({});
      const out = await evaluate(`OK: \${ctx.msg.toUpperCase()}`, {
        msg: "fine",
      });
      assertEquals(out.trim(), "OK: FINE");

      const run = await evaluate("X");
      // IMPORTANT: run(...) is async, so use assertRejects
      await assertRejects(
        () =>
          run({
            fn: (() => {}) as unknown as string,
          } as unknown as { msg: string }),
        Error,
        "ctx must be structured-cloneable",
      );
    },
  );

  await t.step(
    "requesting granular perms without unstableWorkerOptions throws",
    () => {
      assertThrows(
        () =>
          safeDenoEvaluator({
            allowRead: ["./somewhere"],
          }),
        Error,
        "unstable-worker-options",
      );
    },
  );

  await t.step(
    "mustache wrapper: simple interpolation via sandbox",
    async () => {
      const makeMustacheRenderer = async (tpl: string) => {
        const { evaluate } = safeDenoEvaluator<Record<string, unknown>>({
          imports: [{ spec: "npm:mustache", as: "mustache" }],
          globals: { tpl },
          timeoutMs: 1500,
        });
        // Support both namespace and default-export shapes.
        return await evaluate(
          `\${mustache.render ?? mustache.default.render(globals.tpl as string, ctx)}`,
        );
      };

      const render = await makeMustacheRenderer("Hello {{name}}!");
      const out = await render({ name: "Shahid" });
      assertEquals(out, "Hello Shahid!");
    },
  );

  await t.step("mustache wrapper: sections and lists via sandbox", async () => {
    const makeMustacheRenderer = async (tpl: string) => {
      const { evaluate } = safeDenoEvaluator<Record<string, unknown>>({
        imports: [{ spec: "npm:mustache", as: "mustache" }],
        globals: { tpl },
        timeoutMs: 1500,
      });
      return await evaluate(
        `\${mustache.render ?? mustache.default.render(globals.tpl as string, ctx)}`,
      );
    };

    // Mustache doesn't read "." from objects; use a named key.
    const tpl = "Items: {{#items}}{{value}}{{^last}}, {{/last}}{{/items}}";
    const items = ["A", "B", "C"].map((v, i, a) => ({
      value: v,
      last: i === a.length - 1,
    }));

    const render = await makeMustacheRenderer(tpl);
    const out = await render({ items });
    assertEquals(out, "Items: A, B, C");
  });
});

Deno.test("unsafeJsEvaluator — capabilities", async (t) => {
  const { evaluate } = unsafeJsEvaluator({
    globals: {
      shout: (s: string) => s.toUpperCase(),
      add: (a: number, b: number) => a + b,
      nowMs: () => Date.now(),
    },
  });

  await t.step(
    "can execute functions from globals and ctx (data)",
    async () => {
      const code = `
      Hello, \${globals.shout(ctx.name)}!
      2+3=\${globals.add(2,3)}
      doubled=\${ctx.double(21)}
    `;
      const run = await evaluate(code);
      const out = await run({
        name: "spry",
        double: (n: number) => n * 2,
      });
      const norm = out.replace(/\s+/g, " ").trim();

      // Fix: only "SPRY" is uppercased
      if (!norm.includes("Hello, SPRY!")) {
        throw new Error(
          "Expected greeting with SPRY uppercased via globals.shout",
        );
      }
      if (!norm.includes("2+3=5")) {
        throw new Error("Expected math via globals.add");
      }
      if (!norm.includes("doubled=42")) {
        throw new Error("Expected doubled=42 via ctx.double");
      }
    },
  );

  await t.step("can access environment variables (Deno.env)", async () => {
    const envPerm = await Deno.permissions.query({ name: "env" });
    if (envPerm.state === "denied") {
      console.warn("Skipping env subtest (no --allow-env)");
      return;
    }

    const KEY = "UNSAFE_EVAL_TEST_KEY";
    Deno.env.set(KEY, "spicy🌶️");
    const code = `env:\${Deno.env.get(${JSON.stringify(KEY)})}`;
    const out = await evaluate(code, {});
    if (!out.includes("spicy🌶️")) {
      throw new Error("Expected to read env var via Deno.env.get");
    }
  });

  await t.step(
    "can read/write filesystem (Deno.readTextFile/writeTextFile)",
    async () => {
      const readPerm = await Deno.permissions.query({ name: "read" });
      const writePerm = await Deno.permissions.query({ name: "write" });
      if (readPerm.state === "denied" || writePerm.state === "denied") {
        console.warn(
          "Skipping fs subtest (need --allow-read and --allow-write)",
        );
        return;
      }

      const tmpFile = await Deno.makeTempFile({ prefix: "unsafe-eval-" });
      const payload = `hello from ${tmpFile}`;
      await Deno.writeTextFile(tmpFile, payload);

      const code = `
      [FILE START]
      \${await Deno.readTextFile(ctx.filePath)}
      [FILE END]
    `;
      const out = await evaluate(code, { filePath: tmpFile });
      if (!out.includes(payload)) {
        throw new Error("Expected to read file contents via Deno.readTextFile");
      }
      await Deno.remove(tmpFile);
    },
  );

  await t.step(
    "can perform network fetch (optional, requires --allow-net)",
    async () => {
      const netPerm = await Deno.permissions.query({ name: "net" });
      if (netPerm.state === "denied") {
        console.warn("Skipping net subtest (no --allow-net)");
        return;
      }

      const code = `
  \${await (async () => {
    const res = await fetch("https://example.com");
    const text = await res.text();
    return 'status=' + res.status + '; hasExample=' + (text.includes("Example Domain"));
  })()}
`;
      const out = await evaluate(code, {});
      if (!out.includes("status=200") || !out.includes("hasExample=true")) {
        throw new Error("Expected successful fetch to example.com");
      }
    },
  );

  await t.step("can use timers/async directly (setTimeout/await)", async () => {
    const code = `
      \${await new Promise((resolve) => {
        setTimeout(() => resolve("timer-ok"), 10);
      })}
    `;
    const out = await evaluate(code, {});
    if (!out.includes("timer-ok")) {
      throw new Error("Expected timer-ok via setTimeout-based Promise");
    }
  });

  await t.step("can use dynamic imports inside template", async () => {
    const code = `
      \${await (async () => {
        const mod = await import("data:application/javascript,export const x='ok';");
        return 'dyn:' + mod.x;
      })()}
    `;
    const out = await evaluate(code, {});
    if (!out.includes("dyn:ok")) {
      throw new Error("Expected dynamic import to succeed");
    }
  });
});
