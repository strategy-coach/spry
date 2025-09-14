/**
 * content/code_test.ts
 * Tests for content/code.ts and content/code-comments.ts
 * Run: deno test -A content/code_test.ts
 */

import {
    assert,
    assertEquals,
    assertGreaterOrEqual,
    assertMatch,
} from "jsr:@std/assert@1";

import {
    detectLanguageByPath,
    getLanguageByIdOrAlias,
    openCodeFile,
    registerLanguage,
} from "./code.ts";

import {
    annotateCodeContent,
    type AnnotationCatalog,
    extractAnnotations,
    extractAnnotationsFromText,
    generateCodeAnnotationCatalog,
    iterateCommentsStream,
    scanComments,
    scanCommentsStream,
} from "./code-comments.ts";

import { createFileContent } from "./fs.ts";
import { isText } from "./core.ts";
import { z } from "npm:zod@3";

/* helpers */
async function writeTempFile(suffix: string, text: string): Promise<string> {
    const p = await Deno.makeTempFile({ suffix });
    await Deno.writeTextFile(p, text);
    return p;
}
function streamFromString(s: string): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    const mid = Math.max(1, Math.floor(s.length / 2));
    const chunks = [enc.encode(s.slice(0, mid)), enc.encode(s.slice(mid))];
    return new ReadableStream<Uint8Array>({
        start(ctrl) {
            for (const c of chunks) ctrl.enqueue(c);
            ctrl.close();
        },
    });
}

/* ---------------------------------- code.ts ---------------------------------- */

Deno.test("code.ts: openCodeFile detects TS by extension and exposes language spec", async (t) => {
    const text = `// hello\nexport const x=1;\n`;
    const path = await writeTempFile(".ts", text);
    try {
        const code = await openCodeFile(path);
        await t.step("language id", () => {
            assertEquals(code.language.id, "typescript");
            assertEquals(code.governance.code?.languageId, "typescript");
        });
        await t.step("nature is text", () => assert(isText(code)));
        await code.close();
    } finally {
        await Deno.remove(path);
    }
});

Deno.test("code.ts: shebang detection when no extension", async () => {
    const path = await writeTempFile(
        "",
        `#!/usr/bin/env python3\n# hi\nprint(1)\n`,
    );
    try {
        const code = await openCodeFile(path);
        assertEquals(code.language.id, "python");
        await code.close();
    } finally {
        await Deno.remove(path);
    }
});

Deno.test("code.ts: registry override/extension works", () => {
    registerLanguage({
        id: "mylang",
        extensions: [".mlg"],
        comment: { line: ["#"], block: [] },
    });
    const spec = detectLanguageByPath("a.mlg");
    assert(spec && spec.id === "mylang");
});

/* ------------------------------ code-comments.ts ----------------------------- */

Deno.test("comments: in-memory scanner finds line and block (with loc)", () => {
    const ts = getLanguageByIdOrAlias("typescript")!;
    const src = `// one
const a=1; /* mid */ const b=2;
/*
multi
line
*/`.trim();

    const cs = scanComments(src, ts);
    assertGreaterOrEqual(cs.length, 3);
    const line = cs.find((c) => c.kind === "line" && /one/.test(c.text));
    const block = cs.find((c) => c.kind === "block" && /mid/.test(c.text));
    const multi = cs.find((c) => c.kind === "block" && /multi/.test(c.text));
    assert(line && block && multi);
    assert(line!.loc && block!.loc && multi!.loc);
});

Deno.test("comments: streaming FSM handles cross-chunk line+block", async () => {
    const ts = getLanguageByIdOrAlias("typescript")!;
    const src = `// one
const a=1; /* block */ const b=2;
`;
    const rs = streamFromString(src);
    const nodes = await scanCommentsStream(rs, ts);
    const hasLine = nodes.some((n) => n.kind === "line" && /one/.test(n.text));
    const hasBlock = nodes.some((n) =>
        n.kind === "block" && /block/.test(n.text)
    );
    assert(hasLine && hasBlock);
});

Deno.test("comments: streaming FSM yields incrementally (SQL)", async () => {
    const sql = getLanguageByIdOrAlias("sql")!;
    const src = `-- title: users
SELECT * /* all columns */ FROM users -- end
;`;
    const rs = streamFromString(src);
    const kinds: string[] = [];
    for await (const n of iterateCommentsStream(rs, sql)) kinds.push(n.kind);
    assert(kinds.includes("line") && kinds.includes("block"));
});

Deno.test("comments: nested block handling (Rust)", () => {
    const rust = getLanguageByIdOrAlias("rust")!;
    const src = `
/* top
  /* inner */
end */
fn main() { /* inline */ }`.trim();

    const cs = scanComments(src, rust);
    const blocks = cs.filter((c) => c.kind === "block");
    assertGreaterOrEqual(blocks.length, 2);
    const first = blocks[0];
    assertMatch(first.text, /top/);
    assertMatch(first.text, /inner/);
    const inline = blocks.find((b) => /inline/.test(b.text));
    assert(inline);
});

Deno.test("comments: HTML comment fences", () => {
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

/* --------------------------------- extractors -------------------------------- */

Deno.test("extractors: tags + kv + yaml + json in TS", async () => {
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
        tags: true,
        kv: true,
        yaml: true,
        json: true,
    });

    const kinds = new Set(cat.items.map((i) => i.kind));
    assert(kinds.has("tag"));
    assert(kinds.has("kv"));
    assert(kinds.has("yaml"));
    assert(kinds.has("json"));

    const ownerTag = cat.items.find((i) =>
        i.kind === "tag" && i.key === "owner"
    );
    assert(ownerTag);
    assertEquals(ownerTag.value, "alice");

    const yaml = cat.items.find((i) => i.kind === "yaml")!;
    // deno-lint-ignore no-explicit-any
    assertEquals((yaml.value as any).owner, "bob");
});

Deno.test("extractors: spry markers (@, !, ...)", async () => {
    const src = `
// @feature user-search
// !build beta
// ...
// key: inside-fence
// ...
export const noop = 1;
  `.trim();

    const path = await writeTempFile(".ts", src);
    try {
        const code = await openCodeFile(path);
        const cat = await extractAnnotations(code, {
            spry: { enabled: true, at: "@", bang: "!", blockFence: "..." },
            tags: false,
            kv: false,
        });
        const kinds = new Set(cat.items.map((i) => i.kind));
        assert(kinds.has("spry-annotation"));
        assert(kinds.has("spry-directive"));
        assert(kinds.has("spry-block"));
    } finally {
        await Deno.remove(path);
    }
});

Deno.test("extractors: one-shot catalog from path", async () => {
    const path = await writeTempFile(".js", `// @owner ops\nconst z=0;`);
    try {
        const cat = await generateCodeAnnotationCatalog(path, {
            tags: true,
            kv: false,
        });
        const owner = cat.items.find((i) =>
            i.kind === "tag" && i.key === "owner"
        );
        assert(owner);
        assertEquals(owner.value, "ops");
    } finally {
        await Deno.remove(path);
    }
});

/* ------------------------------ governance attach ---------------------------- */

Deno.test("governance: attach catalog into governance.annotations", async () => {
    const path = await writeTempFile(".ts", `// @owner platform\nexport {};`);
    try {
        const code = await openCodeFile(path);
        const annotated = await annotateCodeContent(
            code,
            { tags: true },
            "governance",
        );
        // deno-lint-ignore no-explicit-any
        const govAny = annotated.governance as any;
        assert(govAny.annotations?.codeAnnotations);
        assertEquals(
            govAny.annotations.codeAnnotations.languageId,
            "typescript",
        );
        await annotated.close();
    } finally {
        await Deno.remove(path);
    }
});

/* ------------------------------ typed catalogs ------------------------------- */

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
            tags: false,
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

/* ------------------------------------ fs ------------------------------------ */

Deno.test("fs adapter smoke: readText and scan", async () => {
    const path = await writeTempFile(".ts", `// note\nexport const X=1;`);
    try {
        const fc = createFileContent({
            contentId: path,
            path,
            known: { nature: "text" },
        });
        const text = await fc.readText();
        const ts = getLanguageByIdOrAlias("typescript")!;
        const cs = scanComments(text, ts);
        assertEquals(cs[0].kind, "line");
        await fc.close();
    } finally {
        await Deno.remove(path);
    }
});
