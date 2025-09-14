import { assert, assertArrayIncludes, assertEquals } from "jsr:@std/assert@1";
import { z } from "jsr:@zod/zod@4";

import { getLanguageByIdOrAlias, openCodeFile } from "./code.ts";
import {
  type AnnotationCatalog,
  extractAnnotations,
  extractAnnotationsFromText,
  scanComments,
  scanCommentsStream,
} from "./code-comments.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/* helpers */
async function writeTempFile(suffix: string, text: string): Promise<string> {
  const p = await Deno.makeTempFile({ suffix });
  await Deno.writeTextFile(p, text);
  return p;
}
function streamFromString(s: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const third = Math.max(1, Math.floor(s.length / 3));
  const chunks = [
    s.slice(0, third),
    s.slice(third, 2 * third),
    s.slice(2 * third),
  ];
  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(enc.encode(c));
      ctrl.close();
    },
  });
}

/* -------------------------------------------------------------------------------------------------
 * Multi-tag per line + typed values + boolean tags
 * -------------------------------------------------------------------------------------------------*/

Deno.test("tags: multiple on one line (typed values + boolean tags)", async (t) => {
  const ts = getLanguageByIdOrAlias("typescript")!;

  await t.step("three tags with string, number, JSON object", async () => {
    const src = `// @a.one foo @a.two 42 @a.three {"x":1,"y":[2,3]}`;
    const cat = await extractAnnotationsFromText(src, ts, {
      tags: { multi: true, valueMode: "json" },
      kv: false,
      yaml: false,
      json: false,
    });
    const tags = cat.items.filter((i) => i.kind === "tag");
    assertEquals(tags.length, 3);
    assertEquals(tags[0].key, "a.one");
    assertEquals(tags[0].value, "foo");
    assertEquals(tags[1].key, "a.two");
    assertEquals(tags[1].value, 42);
    assertEquals(tags[2].key, "a.three");
    assertEquals((tags[2].value as Any).x, 1);
    assertEquals((tags[2].value as Any).y, [2, 3]);
  });

  await t.step(
    "quoted @ inside value should not split; following tag read",
    async () => {
      const src = `// @user.email "dev@company.com" @env prod`;
      const cat = await extractAnnotationsFromText(src, ts, {
        tags: { multi: true, valueMode: "json" },
      });
      const email = cat.items.find((i) =>
        i.kind === "tag" && i.key === "user.email"
      )!;
      const env = cat.items.find((i) => i.kind === "tag" && i.key === "env")!;
      assertEquals(email.value, "dev@company.com");
      assertEquals(env.value, "prod");
    },
  );

  await t.step("boolean tag (no value) equals true", async () => {
    const src = `// @enabled @role admin`;
    const cat = await extractAnnotationsFromText(src, ts, {
      tags: { multi: true, valueMode: "json" },
    });
    const enabled = cat.items.find((i) =>
      i.kind === "tag" && i.key === "enabled"
    )!;
    const role = cat.items.find((i) => i.kind === "tag" && i.key === "role")!;
    assertEquals(enabled.value, true);
    assertEquals(role.value, "admin");
  });

  await t.step("JSDoc starred line with multiple tags", async () => {
    const src = `
/**
 * @a.x foo @a.y bar
 * @a.z baz
 */
`.trim();

    const cat = await extractAnnotationsFromText(src, ts, {
      tags: { multi: true, valueMode: "json" },
    });
    const keys = cat.items.filter((i) => i.kind === "tag").map((i) => i.key)
      .sort();
    assertArrayIncludes(keys, ["a.x", "a.y", "a.z"]);
  });

  await t.step(
    "JSON inline value containing @ inside JSON string doesn't split",
    async () => {
      const src =
        `// @cfg {"contact":"ops@company.com","flags":["a","b"]} @mode fast`;
      const cat = await extractAnnotationsFromText(src, ts, {
        tags: { multi: true, valueMode: "json" },
      });
      const cfg = cat.items.find((i) => i.kind === "tag" && i.key === "cfg")!;
      const mode = cat.items.find((i) => i.kind === "tag" && i.key === "mode")!;
      assertEquals((cfg.value as Any).contact, "ops@company.com");
      assertEquals((cfg.value as Any).flags, ["a", "b"]);
      assertEquals(mode.value, "fast");
    },
  );
});

/* -------------------------------------------------------------------------------------------------
 * YAML / JSON blocks still work; JSDoc stars normalized
 * -------------------------------------------------------------------------------------------------*/

Deno.test("extractors: tags + kv + yaml + json in TS (JSDoc-stars normalized)", async () => {
  const src = `
/**
 * ---
 * owner: bob
 * route: /api/users
 * flags:
 *   - beta
 *   - dark
 * ---
 * { "policy": { "retention": "30d" }, "enabled": true }
 */
 // @owner alice
 // key: value
 // timeout = 30
 export const A = 1;
  `.trim();

  const ts = getLanguageByIdOrAlias("typescript")!;
  const cat = await extractAnnotationsFromText(src, ts, {
    tags: { multi: true, valueMode: "json" },
    kv: true,
    yaml: true,
    json: true,
  });

  const kinds = new Set(cat.items.map((i) => i.kind));
  assert(kinds.has("tag"));
  assert(kinds.has("kv"));
  assert(kinds.has("yaml"));
  assert(kinds.has("json"));

  const ownerTag = cat.items.find((i) => i.kind === "tag" && i.key === "owner");
  assert(ownerTag);
  assertEquals(ownerTag.value, "alice");

  const yaml = cat.items.find((i) => i.kind === "yaml")!;
  assertEquals((yaml.value as Any).owner, "bob");
});

/* -------------------------------------------------------------------------------------------------
 * Streaming FSM still yields comments; works with typed tags too
 * -------------------------------------------------------------------------------------------------*/

Deno.test("streaming: comments + extract typed tags", async () => {
  const ts = getLanguageByIdOrAlias("typescript")!;
  const src = `// @a one
const x=1; /* { "k": 1 } */ // timeout = 20
// @b 3.14 @c true
`;
  const rs = streamFromString(src);
  const nodes = await scanCommentsStream(rs, ts);
  assert(nodes.some((n) => n.kind === "line" && /@a/.test(n.text)));
  assert(nodes.some((n) => n.kind === "block" && /{ "k": 1 }/.test(n.text)));

  const cat = await extractAnnotationsFromText(src, ts, {
    tags: { multi: true, valueMode: "json" },
    kv: true,
    json: true,
  });
  assert(
    cat.items.some((i) =>
      i.kind === "tag" && i.key === "a" && i.value === "one"
    ),
  );
  assert(cat.items.some((i) => i.kind === "json"));
  assert(
    cat.items.some((i) =>
      i.kind === "kv" && i.key === "timeout" && i.value === "20"
    ),
  );
  assert(
    cat.items.some((i) =>
      i.kind === "tag" && i.key === "b" && i.value === 3.14
    ),
  );
  assert(
    cat.items.some((i) =>
      i.kind === "tag" && i.key === "c" && i.value === true
    ),
  );
});

/* -------------------------------------------------------------------------------------------------
 * Typed catalogs with Zod still work: coerce YAML payload
 * -------------------------------------------------------------------------------------------------*/

Deno.test("typed catalogs with Zod: coerce YAML payload", async () => {
  const src = `
/*
---
owner: "alice"
route: "/v1/users"
flags: ["pii","beta"]
minutes: 15
---
*/
export {};
`.trim();

  const path = await writeTempFile(".ts", src);
  try {
    const code = await openCodeFile(path);
    const YamlAnno = z.object({
      owner: z.string(),
      route: z.string(),
      flags: z.array(z.string()).default([]),
      minutes: z.number(),
    });

    const cat = await extractAnnotations(code, {
      yaml: true,
      tags: { multi: true, valueMode: "json" },
      kv: false,
      json: false,
      validate: (item) => {
        if (item.kind === "yaml") return YamlAnno.parse(item.value);
        throw new Error("drop");
      },
    }) as AnnotationCatalog<z.infer<typeof YamlAnno>>;

    assert(cat.items.length >= 1);
    const anno = cat.items[0].value;
    assertEquals(anno?.owner, "alice");
    assertEquals(anno?.minutes, 15);
  } finally {
    await Deno.remove(path);
  }
});

/* -------------------------------------------------------------------------------------------------
 * Legacy behaviors contrasted (string-only mode)
 * -------------------------------------------------------------------------------------------------*/

Deno.test("tags: string-only mode keeps raw strings", async () => {
  const ts = getLanguageByIdOrAlias("typescript")!;
  const src = `// @num 3 @truth false @obj {"a":1}`;
  const cat = await extractAnnotationsFromText(src, ts, {
    tags: { multi: true, valueMode: "string" },
  });
  const num = cat.items.find((i) => i.kind === "tag" && i.key === "num")!;
  const truth = cat.items.find((i) => i.kind === "tag" && i.key === "truth")!;
  const obj = cat.items.find((i) => i.kind === "tag" && i.key === "obj")!;
  assertEquals(typeof num.value, "string");
  assertEquals(num.value, "3");
  assertEquals(truth.value, "false");
  assertEquals(typeof obj.value, "string");
  assertEquals((obj.value as string).startsWith("{"), true);
});

/* -------------------------------------------------------------------------------------------------
 * Basic scanners parity
 * -------------------------------------------------------------------------------------------------*/

Deno.test("scanner: HTML comment blocks", () => {
  const html = getLanguageByIdOrAlias("html")!;
  const src = `
<!doctype html>
<!-- @owner web -->
<div>hi</div>
<!--
multi
-->`.trim();

  const cs = scanComments(src, html);
  assert(cs.find((c) => /@owner/.test(c.text)));
  assert(cs.find((c) => /multi/.test(c.text)));
});

Deno.test("scanner: Rust nested block comments", () => {
  const rust = getLanguageByIdOrAlias("rust")!;
  const src = `
/* top
  /* inner */
end */
fn main() { /* inline */ }`.trim();

  const cs = scanComments(src, rust);
  const blocks = cs.filter((c) => c.kind === "block");
  assert(blocks.length >= 2);
});
