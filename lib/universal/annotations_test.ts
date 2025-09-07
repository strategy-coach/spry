// annotations_test.ts
import { z } from "jsr:@zod/zod@^4.1.5";
import {
  assert,
  assertArrayIncludes,
  assertEquals,
  assertFalse,
} from "jsr:@std/assert@^1.0.14";
import { annotationsParser } from "./annotations.ts";

Deno.test("parses multiple annotations per line and coerces types", () => {
  const schema = z.object({
    X: z.coerce.number(),
    mode: z.enum(["fast", "slow"]).optional(),
    // accept one or many
    tag: z.union([z.string(), z.array(z.string())]),
    meta: z.string().transform((s, ctx) => {
      try {
        return JSON.parse(s);
      } catch {
        ctx.addIssue({ code: "custom", message: "Invalid JSON" });
        return z.NEVER; // tell Zod to fail this transform
      }
    }).optional(),
  }).strict();

  const parser = annotationsParser("ann", schema);

  const sql = `
-- @ann.X 42 @ann.mode "fast" @ann.tag alpha
-- @ann.tag beta @ann.meta {"a":1,"b":[2,3]}
SELECT 1;
`;

  const res = parser.parse(sql);
  assert(res?.success, res?.success ? "" : res?.error.toString());

  // X coerced to number
  assertEquals(res.data.X, 42);
  // mode enum
  assertEquals(res.data.mode, "fast");
  // tags aggregated into array (because multiple occurrences)
  assert(Array.isArray(res.data.tag));
  assertArrayIncludes(res.data.tag as string[], ["alpha", "beta"]);
  // meta JSON transformed
  assertEquals(res.data.meta, { a: 1, b: [2, 3] });
});

Deno.test("strict schema rejects unknown args", () => {
  const schema = z.object({
    X: z.coerce.number(),
  }).strict();

  const parser = annotationsParser("ann", schema);

  const sql = `
-- @ann.X 1 @ann.unknown nope
`;
  const res = parser.parse(sql);
  assertFalse(res?.success);
});

Deno.test("duplicate scalar values cause error (define as array to allow multiples)", () => {
  const schema = z.object({
    mode: z.enum(["fast", "slow"]),
  }).strict();

  const parser = annotationsParser("ann", schema);

  const sql = `
-- @ann.mode fast @ann.mode slow
`;

  const res = parser.parse(sql);
  // parser will coalesce into an array; schema expects scalar => error
  assertFalse(res?.success);
});

Deno.test("array schema accepts multiple values", () => {
  const schema = z.object({
    tag: z.array(z.string()),
  }).strict();

  const parser = annotationsParser("ann", schema);

  const sql = `
-- @ann.tag alpha @ann.tag beta @ann.tag gamma
`;
  const res = parser.parse(sql);

  // NOTE: parser makes first occurrence a scalar until a duplicate is seen.
  // With >=2 values, the final value becomes an array, satisfying the schema.
  assert(res?.success, res?.success ? "" : res?.error.toString());
  assertEquals(res.data.tag, ["alpha", "beta", "gamma"]);
});

Deno.test("parses annotations inside block comments when enabled", () => {
  const schema = z.object({
    X: z.coerce.number(),
    name: z.string().optional(),
  }).strict();

  const parser = annotationsParser("ann", schema, {
    blockComments: true,
    coalesce: "first",
  });

  const sql = `
/* Header
 * @ann.X 9 @ann.name alpha
 */
SELECT 1; /* trailer @ann.X 10 */
`;

  const res = parser.parse(sql);
  assert(res?.success, res?.success ? "" : res?.error.toString());
  assertEquals(res.data.X, 9); // "first" wins
  assertEquals(res.data.name, "alpha");
});

Deno.test("custom comment markers and prefix", () => {
  const schema = z.object({
    X: z.coerce.number(),
  }).strict();

  const parser = annotationsParser("ann", schema, {
    commentMarkers: ["--", "--!"],
    prefix: "%",
  });

  const sql = `
--! %ann.X 7
SELECT 1;
`;

  const res = parser.parse(sql);
  assert(res?.success, res?.success ? "" : res?.error.toString());
  assertEquals(res.data.X, 7);
});

Deno.test("normalizeArg lowercases keys", () => {
  const schema = z.object({
    titlecase: z.string(),
  }).strict();

  const parser = annotationsParser("ann", schema, {
    normalizeArg: (s) => s.toLowerCase(),
  });

  const sql = `
-- @ann.TitleCase HelloWorld
`;

  const res = parser.parse(sql);
  assert(res?.success, res?.success ? "" : res?.error.toString());
  assertEquals(res.data.titlecase, "HelloWorld");
});

Deno.test("custom findValueEnd ends at semicolon", () => {
  const schema = z.object({
    note: z.string(),
    X: z.coerce.number(),
  }).strict();

  const parser = annotationsParser("ann", schema, {
    findValueEnd(comment, start) {
      const semi = comment.indexOf(";", start);
      if (semi >= 0) return semi;
      // fallback to default: stop at next whitespace+@
      const rel = comment.slice(start).search(/\s@/);
      return rel >= 0 ? start + rel : comment.length;
    },
  });

  const sql = `
-- @ann.note Hello world; @ann.X 1
`;

  const res = parser.parse(sql);
  assert(res?.success, res?.success ? "" : res?.error.toString());
  assertEquals(res.data.note, "Hello world");
  assertEquals(res.data.X, 1);
});

Deno.test("trim=false preserves whitespace", () => {
  const schema = z.object({
    v: z.string(),
  }).strict();

  const parser = annotationsParser("ann", schema, { trim: false });

  const sql = `
-- @ann.v  alpha  
`;

  const res = parser.parse(sql);
  assert(res?.success, res?.success ? "" : res?.error.toString());
  // leading/trailing spaces remain (minus the initial split token spacing)
  assertEquals(res.data.v, "alpha  ");
});

Deno.test("custom argName regex (lowercase + hyphen)", () => {
  const schema = z.object({
    ["long-name"]: z.string(),
  }).strict();

  const parser = annotationsParser("ann", schema, {
    argName: /[a-z-]+/,
  });

  const sql = `
-- @ann.long-name value
`;

  const res = parser.parse(sql);
  assert(res?.success, res?.success ? "" : res?.error.toString());
  assertEquals(res.data["long-name"], "value");
});

Deno.test("discover(): collects counts, values, uniques, first/last, and order", () => {
  const schema = z.object({
    X: z.coerce.number(),
    mode: z.enum(["fast", "slow"]).optional(),
    tag: z.union([z.string(), z.array(z.string())]),
  }).strict();

  const parser = annotationsParser("ann", schema);

  const sql = `-- @ann.X 42 @ann.mode "fast" @ann.tag alpha
-- @ann.tag beta
SELECT 1;`;

  const d = parser.discover(sql);

  // identity/prefix
  assertEquals(d.identity, "ann");
  assertEquals(d.prefix, "@");

  // totals
  assertEquals(d.total, 4);
  assert(Object.hasOwn(d.args, "X"));
  assert(Object.hasOwn(d.args, "mode"));
  assert(Object.hasOwn(d.args, "tag"));

  // X
  assertEquals(d.args.X.count, 1);
  assertEquals(d.args.X.values, ["42"]);
  assertEquals(d.args.X.uniqueValues, ["42"]);
  assertEquals(d.args.X.first, "42");
  assertEquals(d.args.X.last, "42");

  // mode (quotes should be stripped by default normalizeValue)
  assertEquals(d.args.mode.count, 1);
  assertEquals(d.args.mode.values, ["fast"]);

  // tag (multiple)
  assertEquals(d.args.tag.count, 2);
  assertArrayIncludes(d.args.tag.values, ["alpha", "beta"]);
  assertEquals(d.args.tag.uniqueValues.length, 2);
  assertEquals(d.args.tag.first, "alpha");
  assertEquals(d.args.tag.last, "beta");

  // order (by appearance)
  assertEquals(d.order.length, 4);
  assertEquals(d.order.map((o) => o.arg), ["X", "mode", "tag", "tag"]);
  assertEquals(d.order.map((o) => o.value), ["42", "fast", "alpha", "beta"]);

  // basic line expectations (no leading newline so first line is 1)
  assertEquals(d.order[0].line, 1); // X
  assertEquals(d.order[1].line, 1); // mode
  assertEquals(d.order[2].line, 1); // tag alpha
  assertEquals(d.order[3].line, 2); // tag beta
});

Deno.test("discover(): captures precise occurrences with line/column/start/end", () => {
  const schema = z.object({
    a: z.string(),
    b: z.string(),
  }).strict();

  const parser = annotationsParser("ann", schema);

  const sql = `-- lead text @ann.a foo @ann.b "bar"\nSELECT 1; -- tail`;

  const d = parser.discover(sql);

  // two hits
  assertEquals(d.total, 2);
  assertEquals(d.order[0].arg, "a");
  assertEquals(d.order[0].value, "foo");
  assertEquals(d.order[0].line, 1);
  // start/end are absolute offsets; sanity check increasing
  assert(d.order[0].start < d.order[0].end);

  assertEquals(d.order[1].arg, "b");
  assertEquals(d.order[1].value, "bar"); // quotes stripped
  assertEquals(d.order[1].line, 1);
  assert(d.order[0].end <= d.order[1].start);
});

Deno.test("discover(): scans block comments when enabled and preserves appearance order", () => {
  const schema = z.object({
    note: z.string().optional(),
  }).strict();

  const parser = annotationsParser("ann", schema, { blockComments: true });

  const sql =
    `/* head @ann.note "hello" */ SELECT 1; /* tail @ann.note "world" */`;

  const d = parser.discover(sql);

  assertEquals(d.total, 2);
  assertEquals(d.args.note.count, 2);
  assertEquals(d.args.note.values, ["hello", "world"]);
  assertEquals(d.args.note.first, "hello");
  assertEquals(d.args.note.last, "world");
  assertEquals(d.order.map((o) => o.value), ["hello", "world"]);
});

Deno.test("discover(): respects arg normalization and custom argName regex", () => {
  const schema = z.object({
    ["long-name"]: z.string().optional(),
  }).strict();

  const parser = annotationsParser("ann", schema, {
    argName: /[A-Za-z-]+/,
    normalizeArg: (s) => s.toLowerCase(),
  });

  const sql = `-- @ann.Long-Name "VAL"`;
  const d = parser.discover(sql);

  assertEquals(d.total, 1);
  assert(Object.hasOwn(d.args, "long-name"));
  assertEquals(d.args["long-name"].values, ["VAL"]);
});
