// Deno 2.x tests for template.ts (no unstable flags required)
import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import { createTsEvaluator } from "./template.ts";

Deno.test("template.ts — evaluator", async (t) => {
  await t.step(
    "basic render with ctx generic (no function globals)",
    async () => {
      const { evaluate } = createTsEvaluator<{ user: string }>({
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
    const { evaluate } = createTsEvaluator<{ n: number }>();
    const out = await evaluate("Value: ${ctx.n + 1}", { n: 41 });
    assertEquals(out.trim(), "Value: 42");
  });

  await t.step("imports: remote std (uuid) without net perms", async () => {
    const { evaluate } = createTsEvaluator({
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
      const { evaluate } = createTsEvaluator();
      await assertRejects(
        () => evaluate(`\${Deno.env.get("HOME")}`, {}),
        Error,
      );
    },
  );

  await t.step("timeout: long-running template is killed", async () => {
    const { evaluate } = createTsEvaluator({ timeoutMs: 200 });
    await assertRejects(
      () => evaluate("Begin ${await new Promise<string>(() => {})} End", {}),
      Error,
      "timed out",
    );
  });

  await t.step(
    "ctx must be structured-cloneable; functions belong in imports, not ctx/globals",
    async () => {
      const { evaluate } = createTsEvaluator<{ msg: string }>({});
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
          createTsEvaluator({
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
        const { evaluate } = createTsEvaluator<Record<string, unknown>>({
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
      const { evaluate } = createTsEvaluator<Record<string, unknown>>({
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
