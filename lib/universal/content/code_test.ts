import {
  assert,
  assertArrayIncludes,
  assertEquals,
  assertThrows,
} from "jsr:@std/assert@1";
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

Deno.test("grouping + validation: svgAnnotations factory", async (t) => {
  // Compact, self-contained factory used by all subtests
  function svgAnnotations() {
    const schema = z.object({
      width: z.coerce.number().positive(),
      height: z.coerce.number().positive(),
      viewBox: z.string().regex(
        /^\d+\s+\d+\s+\d+\s+\d+$/,
        "must be 'minX minY width height'",
      ),
      ariaLabel: z.string().optional(),
      fill: z.string().optional(),
    });
    type SvgMeta = z.infer<typeof schema>;

    function group(
      catalog: Awaited<ReturnType<typeof extractAnnotationsFromText>>,
    ) {
      const out: Record<string, Record<string, unknown>> = {};
      for (const it of catalog.items) {
        if (it.kind === "tag" && it.key?.startsWith("svg.")) {
          const field = it.key.slice(4); // strip "svg."
          (out.svg ??= {})[field] = it.value ?? it.raw;
        }
      }
      return out;
    }

    function validate(
      catalog: Awaited<ReturnType<typeof extractAnnotationsFromText>>,
    ): SvgMeta {
      const g = group(catalog).svg;
      if (!g) throw new Error("No svg annotations found");
      const cleaned = Object.fromEntries(
        Object.entries(g).map((
          [k, v],
        ) => [k, typeof v === "string" ? v.replace(/^"(.*)"$/, "$1") : v]),
      );
      return schema.parse(cleaned);
    }

    return { schema, group, validate };
  }

  const ts = getLanguageByIdOrAlias("typescript")!;

  await t.step(
    "happy path: grouped + validated with types coerced",
    async () => {
      const source = `
// @svg.width  128
// @svg.height 256
// @svg.viewBox 0 0 128 256
// @svg.ariaLabel "Hero logo"
// @svg.fill #222
`.trim();

      const catalog = await extractAnnotationsFromText(source, ts, {
        tags: { multi: true, valueMode: "json" },
      });
      const { group, validate } = svgAnnotations();

      const grouped = group(catalog);
      assert(grouped.svg);
      assertEquals(grouped.svg.width, 128); // already typed via valueMode: "json"
      assertEquals(grouped.svg.height, 256);
      assertEquals(grouped.svg.viewBox, "0 0 128 256");

      const typed = validate(catalog);
      assertEquals(typed.width, 128);
      assertEquals(typed.height, 256);
      assertEquals(typed.viewBox, "0 0 128 256");
      assertEquals(typed.ariaLabel, "Hero logo");
      assertEquals(typed.fill, "#222");
    },
  );

  await t.step("multiple tags on the same line", async () => {
    const source = `// @svg.width 64 @svg.height 32 @svg.viewBox 0 0 64 32`;
    const catalog = await extractAnnotationsFromText(source, ts, {
      tags: { multi: true, valueMode: "json" },
    });
    const { validate } = svgAnnotations();
    const typed = validate(catalog);
    assertEquals(typed.width, 64);
    assertEquals(typed.height, 32);
    assertEquals(typed.viewBox, "0 0 64 32");
  });

  await t.step(
    "boolean tags without value are true (ignored if not in schema)",
    async () => {
      const source =
        `// @svg.width 10 @svg.height 20 @svg.viewBox 0 0 10 20 @svg.focusable`;
      const catalog = await extractAnnotationsFromText(source, ts, {
        tags: { multi: true, valueMode: "json" },
      });
      const { group, validate } = svgAnnotations();
      const grouped = group(catalog);
      // focusable is boolean true but not in schema; Zod will strip/ignore it
      assertEquals(grouped.svg.focusable, true);
      const typed = validate(catalog);
      assertEquals(typed.width, 10);
      assertEquals(typed.height, 20);
      assertEquals(typed.viewBox, "0 0 10 20");
      // @ts-expect-error - not part of the schema
      typed.focusable;
    },
  );

  await t.step("invalid viewBox fails validation", async () => {
    const source = `// @svg.width 100 @svg.height 200 @svg.viewBox bad-format`;
    const catalog = await extractAnnotationsFromText(source, ts, {
      tags: { multi: true, valueMode: "json" },
    });
    const { validate } = svgAnnotations();
    assertThrows(() => validate(catalog));
  });

  await t.step("missing group throws a friendly error", async () => {
    const source = `// @notSvg.foo 1`;
    const catalog = await extractAnnotationsFromText(source, ts, {
      tags: { multi: true, valueMode: "json" },
    });
    const { validate } = svgAnnotations();
    assertThrows(() => validate(catalog));
  });

  await t.step("coercions: numbers/strings preserved as expected", async () => {
    const source =
      `// @svg.width "300" @svg.height 150 @svg.viewBox 0 0 300 150`;
    const catalog = await extractAnnotationsFromText(source, ts, {
      tags: { multi: true, valueMode: "json" },
    });
    const { validate } = svgAnnotations();
    const typed = validate(catalog);
    assertEquals(typed.width, 300); // coerce from quoted string
    assertEquals(typed.height, 150); // already a number
    assertEquals(typed.viewBox, "0 0 300 150");
  });

  await t.step("quoted values containing @ shouldn't split tags", async () => {
    const source =
      `// @svg.width 10 @svg.height 20 @svg.viewBox 0 0 10 20 @svg.ariaLabel "dev@company.com"`;
    const catalog = await extractAnnotationsFromText(source, ts, {
      tags: { multi: true, valueMode: "json" },
    });
    const { validate } = svgAnnotations();
    const typed = validate(catalog);
    assertEquals(typed.ariaLabel, "dev@company.com");
  });
});

/* -------------------------------------------------------------------------------------------------
 * String-only values mode
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
