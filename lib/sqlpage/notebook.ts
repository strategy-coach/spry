/**
 * @module sqlpage/notebook
 *
 * A tiny, DX-first wrapper that turns one or more Markdown sources into a
 * stream of **typed SQL fenced blocks** which can be used to materialize into a
 * partial or full SQLPage application without having to write each SQL file
 * individually.
 *
 * The single entrypoint {@link sqlPageContent}:
 * - accepts an async generator of sources (each a `{ identifier, markdown }` pair)
 * - parses frontmatter with your Zod schema
 * - validates per-language fence attributes with your Zod schemas (generic over `M`)
 * - yields fences as `FencedBlockTyped<M>` **plus** two provenance fields:
 *   `sourceId` and `blockIndex` (an alias of the core `index`), while preserving
 *   all core fields (`lang`, `code`, `attrs`, `resolvedAttrs`, `info`,
 *   `startLine`, `endLine`, `instructions`).
 *
 * Nothing here performs execution or output planning. No I/O is done other
 * than reading the provided source content. Use the stream in your kernel
 * to perform downstream work.
 *
 * ---
 *
 * ## Quick Start
 *
 * ```ts
 * import { z } from "jsr:@zod/zod@4";
 * import {
 *   sqlPageContent,
 *   type SqlFenceTyped,
 * } from "./notebook.ts";
 *
 * // 1) Frontmatter schema (FM)
 * const fmSchema = z.object({
 *   siteName: z.string().min(1),
 * }).strict();
 * type FM = z.infer<typeof fmSchema>;
 *
 * // 2) Per-language attribute schema map (M)
 * //    Example for "sql" with a `kind` discriminant.
 * const sqlAttrs = z.discriminatedUnion("kind", [
 *   z.object({ kind: z.literal("head") }).strict(),        // forbid extras
 *   z.object({ kind: z.literal("tail") }).passthrough(),   // allow extras (e.g. section-defaults)
 *   z.object({
 *     kind: z.literal("page"),
 *     name: z.string().min(1).optional(),
 *     filename: z.string().min(1).optional(),
 *   }),                                                    // non-strict is fine; unknown keys are stripped
 * ]);
 * type M = { sql: z.infer<typeof sqlAttrs> };
 *
 * // 3) Provide sources as an async generator
 * async function* sources() {
 *   const md = [
 *     '---',
 *     'siteName: Demo',
 *     '---',
 *     '## Intro',
 *     '',
 *     '```sql { kind: "head" }',
 *     'PRAGMA foreign_keys = ON;',
 *     '```',
 *     '',
 *     '```sql { role: "section-defaults" }',
 *     '{ name: "Home" }',
 *     '```',
 *     '',
 *     '```sql { kind: "page" }',
 *     'select 1;',
 *     '```',
 *     '',
 *     '```sql { kind: "tail" }',
 *     '-- tail',
 *     '```',
 *   ].join('\n');
 *   yield { identifier: "inline.md", markdown: md };
 *
 *   // ReadableStream<Uint8Array> is supported as well:
 *   const stream = new Response("```sql\nselect 2;\n```").body!;
 *   yield { identifier: "stream.md", markdown: stream };
 * }
 *
 * // 4) Build the content stream
 * const content = sqlPageContent<FM, M>(sources(), {
 *   fmSchema,
 *   attrSchemas: { sql: sqlAttrs },  // validate "sql" fences
 *   // delimiter: { kind: "heading", level: 2 }, // optional
 *   // strictAttrValidation: false,              // default: warn & still emit fence
 *   // enableAttrResolution: true,               // $preset/$merge/$spread/$fm on (default)
 *   // mirrorFrontmatter: false,                 // don't mirror FM into attrs (default)
 * });
 *
 * // 5) Consume fences
 * for await (const fence of content.SQL()) {
 *   // fence is a FencedBlockTyped<M> plus provenance fields
 *   // fence.lang === "sql"
 *   // fence.attrsSafe is present & typed when schema validates for the lang
 *   console.log(fence.sourceId, fence.blockIndex, fence.lang, fence.code);
 *
 *   if (fence.attrsSafe?.kind === "page") {
 *     // fully typed access to page attrs
 *     console.log("page name:", fence.attrsSafe.name);
 *   }
 * }
 *
 * // 6) Inspect issues (core + attribute validation)
 * for (const issue of content.issues()) {
 *   // Core kinds include: "frontmatter-parse", "fence-attrs-json5-parse",
 *   // "fence-attrs-validate", "instruction-defaults-parse", "unknown-language"
 *   // This module also adds "attrs-validate" when a provided schema fails.
 *   console.warn(issue);
 * }
 * ```
 *
 * @remarks
 * ### Design goals
 * - **Minimal API**: a single `sqlPageContent()` function with a small init object.
 * - **Strong typing** without ceremonies: your FM and per-language attr schemas flow
 *   through generics and appear as `attrsSafe` on matching fences.
 * - **Zero downstream assumptions**: no file paths, no suffixes, no write planning.
 * - **Full fidelity**: fences are yielded as your core `FencedBlockTyped<M>` object
 *   with two extra provenance fields (`sourceId`, `blockIndex`) and a trimmed `code`.
 *
 * ### Attribute resolution
 * By default, the underlying notebook enables attribute resolution via:
 * - `$preset`, `$merge`, `$spread`, `$fm`, and section-level defaults (`role: "section-defaults"`).
 * Validation is run against `resolvedAttrs ?? attrs`. If resolution injects extra keys:
 * - Use **`.passthrough()`** on schemas that must tolerate unknown keys
 *   (e.g., `tail`, sometimes `page`).
 * - Keep **`.strict()`** where you intentionally forbid extras (e.g., `head`).
 *
 * ### Error handling
 * - Frontmatter Zod errors thrown by the builder are caught and recorded as a synthetic
 *   `frontmatter-parse` issue; that source is skipped.
 * - Attribute schema failures are recorded as `"attrs-validate"` issues.
 *   - `strictAttrValidation: true` → the failing fence is not yielded.
 *   - `false` (default) → the fence is yielded **without** `attrsSafe`.
 *
 * ### Streaming inputs
 * Source content can be either a string or a `ReadableStream<Uint8Array>`.
 * Strings are ideal for in-memory tests; streams are ideal for HTTP/file pipelines.
 *
 * @template FM Frontmatter type validated by your Zod schema.
 * @template M  Attribute map keyed by language. For each key `K` in `M`, fences with
 *              `lang === K` will, on successful validation, carry `attrsSafe: M[K]`.
 *
 * @see FencedBlockBase
 * @see FencedBlockTyped
 * @see sqlPageContent
 */
import { dirname, isAbsolute, resolve } from "jsr:@std/path@1";
import { z } from "jsr:@zod/zod@4";
import type { Root } from "npm:@types/mdast@^4";
import {
  type EmittedIssue,
  type FencedBlockBase,
  type FencedBlockTyped,
  type InstructionsDelimiter,
  type IssueDisposition,
  NotebookBuilder,
} from "../universal/md-notebook.ts";

/* =============================== Types ================================ */

export type BinaryStream = ReadableStream<Uint8Array>;
export type AttrMap = Record<string, unknown>;

/** Our fence = your FencedBlockBase plus provenance/alias. */
export type SqlFenceBase = FencedBlockBase & {
  readonly sourceId: string;
  /** Convenience alias to core `index` (kept for DX). */
  readonly blockIndex: number;
};

/** Typed fence = your FencedBlockTyped<M> plus provenance/alias. */
export type SqlFenceTyped<M extends AttrMap> = FencedBlockTyped<M> & {
  readonly sourceId: string;
  readonly blockIndex: number;
};

export interface SqlPageContentInit<FM, M extends AttrMap> {
  fmSchema: z.ZodType<FM>;
  attrSchemas?: Partial<
    {
      [K in keyof M & string]:
        | z.ZodType<M[K]>
        | ((ctx: { fm: FM; lang: K }) => z.ZodType<M[K]>);
    }
  >;
  delimiter?: InstructionsDelimiter;
  strictAttrValidation?: boolean;
  enableAttrResolution?: boolean;
  mirrorFrontmatter?: boolean;
}

export type SqlPageContentIssue =
  | EmittedIssue
  | {
    kind: "attrs-validate";
    disposition: IssueDisposition;
    message: string;
    lang: string;
    sourceId: string;
    blockIndex: number;
    startLine?: number;
    endLine?: number;
    candidate: unknown;
    zodError: unknown;
  };

/* ============================ Internals =============================== */

/** Core builder registrar surface we need. */
type BuilderSafeAttrRegistrar = {
  withSafeAttributes: (
    lang: string,
    schemaOrFactory:
      | z.ZodTypeAny
      | ((ctx: { fm: unknown; lang: string }) => z.ZodTypeAny),
  ) => unknown;
};

/** Wrap caller schema/factory to the core builder's ctx type. */
function toCoreSchemaFactory<FM>(
  sch:
    | z.ZodTypeAny
    | ((ctx: { fm: FM; lang: string }) => z.ZodTypeAny),
):
  | z.ZodTypeAny
  | ((ctx: { fm: unknown; lang: string }) => z.ZodTypeAny) {
  if (typeof sch === "function") {
    return (ctx: { fm: unknown; lang: string }) =>
      (sch as (c: { fm: FM; lang: string }) => z.ZodTypeAny)({
        fm: ctx.fm as FM,
        lang: ctx.lang,
      });
  }
  return sch as z.ZodTypeAny;
}

/** Strongly-typed entries for attrSchemas to avoid `{}` inference. */
type SchemaOrFactory<FM> =
  | z.ZodTypeAny
  | ((ctx: { fm: FM; lang: string }) => z.ZodTypeAny);

function schemaEntries<FM, M extends AttrMap>(
  m: SqlPageContentInit<FM, M>["attrSchemas"] | undefined,
): Array<[string, SchemaOrFactory<FM>]> {
  const out: Array<[string, SchemaOrFactory<FM>]> = [];
  if (!m) return out;
  const keys = Object.keys(m) as Array<keyof typeof m & string>;
  for (const k of keys) {
    const v = m[k];
    if (v) out.push([k, v as SchemaOrFactory<FM>]);
  }
  return out;
}

/** Convert a string or stream to text. */
async function toText(input: string | BinaryStream): Promise<string> {
  if (typeof input === "string") return input;
  const chunks: Uint8Array[] = [];
  for await (const c of input) chunks.push(c);
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(out);
}

/* =========================== Core function ============================ */

export function sqlPageContent<
  FM,
  M extends AttrMap = Record<PropertyKey, never>,
>(
  provenance: AsyncGenerator<
    { identifier: string; markdown: string | BinaryStream }
  >,
  init: SqlPageContentInit<FM, M>,
) {
  const allIssues: SqlPageContentIssue[] = [];

  const delimiter = init.delimiter ?? ({ kind: "heading", level: 2 } as const);
  const enableAttrResolution = init.enableAttrResolution ?? true;
  const mirrorFrontmatter = init.mirrorFrontmatter ?? false;
  const strictAttrValidation = init.strictAttrValidation ?? false;

  async function* stream(): AsyncGenerator<SqlFenceTyped<M>, void, unknown> {
    for await (const src of provenance) {
      const sourceId = src.identifier;
      const md = await toText(src.markdown);

      // Build notebook
      const builder0 = new NotebookBuilder<Root>()
        .withInstructionsDelimiter(delimiter)
        .withAttrResolution(enableAttrResolution)
        .withFrontmatterMirror(mirrorFrontmatter);

      // Register provided per-language schemas with the core (e.g., "sql")
      let builder = builder0;
      const entries = schemaEntries(init.attrSchemas);
      for (const [lang, sch] of entries) {
        const registrar = builder as unknown as BuilderSafeAttrRegistrar;
        const schemaForCore = toCoreSchemaFactory<FM>(sch);
        const next = registrar.withSafeAttributes(lang, schemaForCore);
        builder = (next as unknown) as NotebookBuilder<Root>;
      }

      let nb;
      try {
        nb = await builder.fromString(md, sourceId).build(init.fmSchema);
      } catch (err) {
        allIssues.push({
          kind: "frontmatter-parse",
          message: "Frontmatter validation failed.",
          raw: {},
          error: err instanceof Error ? err.message : String(err),
          filename: sourceId,
          disposition: "error",
        } as EmittedIssue);
        continue;
      }

      // Pass through core issues
      for (const core of nb.issues) allIssues.push(core);

      // Emit SQL fences; validation rules depend on strictAttrValidation
      for (const b of nb.blocks) {
        if (b.lang !== "sql") continue;

        // Prefer resolved attrs
        const attrsMerged = (b.resolvedAttrs ?? b.attrs) as Record<
          string,
          unknown
        >;

        // Base fence with provenance & trimmed code (we may yield it in several branches)
        const base: SqlFenceBase = Object.freeze({
          ...b,
          code: String(b.code ?? "").trim(),
          sourceId,
          blockIndex: b.index,
        });

        // Identify control fence
        const roleVal = typeof attrsMerged.role === "string"
          ? String(attrsMerged.role)
          : undefined;
        const isControl = roleVal === "section-defaults";

        // Identify typed fence (kind present)
        const kindVal = attrsMerged.kind;
        const isTypedFence = typeof kindVal === "string";

        // CONTROL FENCE: never validate; yield in non-strict, drop in strict
        if (isControl) {
          if (!strictAttrValidation) {
            yield base as unknown as SqlFenceTyped<M>;
          }
          continue;
        }

        // UNTYPED SQL (no kind): never validate; yield in non-strict, drop in strict
        if (!isTypedFence) {
          if (!strictAttrValidation) {
            yield base as unknown as SqlFenceTyped<M>;
          }
          continue;
        }

        // TYPED SQL: validate if we have a schema for this language
        const attrSchemas = init.attrSchemas as SqlPageContentInit<
          FM,
          M
        >["attrSchemas"];
        const sch = attrSchemas?.[b.lang as keyof M & string];

        if (!sch) {
          // No schema registered → just yield
          if (!strictAttrValidation) {
            yield base as unknown as SqlFenceTyped<M>;
          } else {
            // strict mode: only valid typed fences should remain → drop
          }
          continue;
        }

        // Resolve schema (factory or zod type) and validate merged attrs
        const schema: z.ZodType<unknown> = typeof sch === "function"
          ? (sch as (ctx: { fm: FM; lang: string }) => z.ZodType<unknown>)({
            fm: nb.fm as FM,
            lang: b.lang,
          })
          : (sch as z.ZodType<unknown>);

        const candidate: unknown = attrsMerged;
        const result = (schema as z.ZodTypeAny).safeParse(candidate);

        if (!result.success) {
          allIssues.push({
            kind: "attrs-validate",
            disposition: strictAttrValidation ? "error" : "warning",
            message:
              `Attributes failed schema validation for language "${b.lang}".`,
            lang: b.lang,
            sourceId,
            blockIndex: b.index,
            startLine: b.startLine,
            endLine: b.endLine,
            candidate,
            zodError: result.error,
          });
          if (!strictAttrValidation) {
            // Non-strict: still yield fence (untyped)
            yield base as unknown as SqlFenceTyped<M>;
          }
          // Strict: drop
          continue;
        }

        // Success: attach attrsSafe and yield
        const withSafe = Object.freeze({
          ...base,
          attrsSafe: result.data,
        }) as unknown as SqlFenceTyped<M>;

        yield withSafe;
      }
    }
  }

  return {
    /** Async stream of SQL fences (typed when validated; control/untyped also yielded in non-strict). */
    SQL: () => stream(),
    /** All issues captured so far (core + attrs validation). */
    issues: () => allIssues as readonly SqlPageContentIssue[],
  };
}

/* ============================== CLI shim ================================ */

export interface CliRunResult<M extends AttrMap> {
  fences: readonly SqlFenceTyped<M>[];
  issues: readonly SqlPageContentIssue[];
  error: boolean;
  identifier: string;
  baseDir: string;
  callerDir?: string;
  cwdBefore: string;
  chdirApplied: boolean;
}

export interface CliHandlerInit<FM, M extends AttrMap>
  extends SqlPageContentInit<FM, M> {
  /** If true, change process CWD to the computed base directory before parsing. Default: false. */
  chdirToBase?: boolean;
  /** Label for stdin in results. Default: "<stdin>". */
  stdinIdentifier?: string;
  /** Optional file reader override (tests/virtual FS). */
  readFile?: (absPath: string) => Promise<string>;
}

/** Canonical directory of the caller's markdown file (symlinks resolved). */
export async function canonicalCallerDir(mdPathArg: string): Promise<string> {
  const abs = isAbsolute(mdPathArg)
    ? mdPathArg
    : resolve(Deno.cwd(), mdPathArg);
  let real = abs;
  try {
    real = await Deno.realPath(abs);
  } catch { /* ignore */ }
  return dirname(real);
}

/**
 * Strip the shebang line if present.
 * After removing the shebang, also:
 * - remove all immediately following blank lines if they precede frontmatter `---`
 * - otherwise remove a single leading blank line.
 */
export function stripShebang(s: string): string {
  if (!s.startsWith("#!")) return s;

  // Remove the shebang line (+ trailing newline if present)
  let rest = s.replace(/^#![^\r\n]*(?:\r?\n)?/, "");

  // If leading blank lines are followed by '---', remove all of them
  rest = rest.replace(/^(?:[ \t]*\r?\n)+(?=---)/, "");

  // Otherwise, remove a single leading blank line if present
  if (/^[ \t]*\r?\n/.test(rest)) {
    rest = rest.replace(/^[ \t]*\r?\n/, "");
  }
  return rest;
}

/** Minimal shebang/stdin shim around sqlPageContent(). */
export function cliHandler<
  FM,
  M extends AttrMap = Record<PropertyKey, never>,
>(init: CliHandlerInit<FM, M>) {
  const readFile = init.readFile ?? ((p: string) => Deno.readTextFile(p));

  function hasErrorIssues(issues: readonly unknown[]): boolean {
    return issues.some((i) =>
      (i as { disposition?: string }).disposition === "error"
    );
  }

  function parseFlags(args: readonly string[]) {
    const flags = new Map<string, string | true>();
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (!a.startsWith("--")) {
        rest.push(a);
        continue;
      }
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags.set(a.slice(0, eq), a.slice(eq + 1));
      } else if (a === "--base") {
        const v = args[i + 1];
        if (v && !v.startsWith("--")) {
          flags.set("--base", v);
          i++;
        } else flags.set("--base", true);
      } else {
        flags.set(a, true);
      }
    }
    return { flags, rest };
  }

  async function runWithSource(
    identifier: string,
    markdown: string,
    baseDir: string,
    callerDir?: string,
  ): Promise<CliRunResult<M>> {
    const cwdBefore = Deno.cwd();
    let chdirApplied = false;
    if (init.chdirToBase && baseDir && baseDir !== cwdBefore) {
      Deno.chdir(baseDir);
      chdirApplied = true;
    }

    async function* single() {
      yield { identifier, markdown };
    }
    const content = sqlPageContent<FM, M>(single(), init);

    const fences: SqlFenceTyped<M>[] = [];
    for await (const f of content.SQL()) fences.push(f);

    const issues = content.issues();
    const error = hasErrorIssues(issues);

    return {
      fences,
      issues,
      error,
      identifier,
      baseDir,
      callerDir,
      cwdBefore,
      chdirApplied,
    };
  }

  /** Shebang mode: first non-flag arg is the markdown path; baseDir = canonical caller dir. */
  async function shebang(args?: readonly string[]): Promise<CliRunResult<M>> {
    const argv = args ?? Deno.args;
    const { rest } = parseFlags(argv);
    const path = rest.find((a) => !a.startsWith("--")) ?? rest[0];
    if (!path) {
      throw new Error(
        "Usage: notebook.ts <file.md> [--flags…] (or use stdin())",
      );
    }
    const raw = await readFile(path);
    const callerDir = await canonicalCallerDir(path);
    const baseDir = callerDir;
    return await runWithSource(path, stripShebang(raw), baseDir, callerDir);
  }

  /**
   * Stdin mode: read piped content; baseDir comes from:
   *   1) --base <dir> (if provided), canonicalized & resolved
   *   2) otherwise, Deno.cwd()
   */
  async function stdin(
    identifier = init.stdinIdentifier ?? "<stdin>",
    args?: readonly string[],
  ): Promise<CliRunResult<M>> {
    const argv = args ?? Deno.args;
    const { flags } = parseFlags(argv);
    let baseDir = Deno.cwd();

    const userBase = flags.get("--base");
    if (typeof userBase === "string" && userBase.length > 0) {
      const abs = isAbsolute(userBase)
        ? userBase
        : resolve(Deno.cwd(), userBase);
      try {
        baseDir = await Deno.realPath(abs);
      } catch {
        baseDir = abs;
      }
    }

    const chunks: Uint8Array[] = [];
    for await (const c of Deno.stdin.readable) chunks.push(c);
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      buf.set(c, off);
      off += c.byteLength;
    }
    const text = new TextDecoder().decode(buf);

    return await runWithSource(
      identifier,
      stripShebang(text),
      baseDir,
      undefined,
    );
  }

  /** Convenience: run from an explicit path (non-shebang). */
  async function fromPath(path: string): Promise<CliRunResult<M>> {
    const raw = await readFile(path);
    const callerDir = await canonicalCallerDir(path);
    const baseDir = callerDir;
    return await runWithSource(path, stripShebang(raw), baseDir, callerDir);
  }

  /** Convenience: run from an in-memory string with an explicit baseDir. */
  async function fromString(
    identifier: string,
    markdown: string,
    baseDir = Deno.cwd(),
  ): Promise<CliRunResult<M>> {
    const abs = isAbsolute(baseDir) ? baseDir : resolve(Deno.cwd(), baseDir);
    let real = abs;
    try {
      real = await Deno.realPath(abs);
    } catch { /* ignore */ }
    return await runWithSource(
      identifier,
      stripShebang(markdown),
      real,
      undefined,
    );
  }

  return { shebang, stdin, fromPath, fromString };
}

if (import.meta.main) {
  const fmSchema = z.object({ siteName: z.string().optional() }).strict()
    .catchall(z.unknown());
  const sqlAttrs = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("head") }),
    z.object({ kind: z.literal("tail") }),
    z.object({
      kind: z.literal("page").default("page"),
      path: z.string(),
    }),
  ]);
  type FM = z.infer<typeof fmSchema>;
  type M = { sql: z.infer<typeof sqlAttrs> };

  const runner = cliHandler<FM, M>({
    fmSchema,
    attrSchemas: { sql: sqlAttrs },
    // strictAttrValidation: false,
    // delimiter: { kind: "heading", level: 2 },
    // enableAttrResolution: true,
    // mirrorFrontmatter: false,
  });

  const isPiped = !Deno.stdin.isTerminal();
  runner[isPiped ? "stdin" : "shebang"]()
    .then((res) => {
      // render your own output here; for demo just log counts and exit code
      const typed = res.fences.filter((f) =>
        (f as { attrsSafe?: unknown }).attrsSafe !== undefined
      );
      console.log(JSON.stringify(
        {
          identifier: res.identifier,
          fences: res.fences.length,
          typed: typed.length,
          issues: res.issues.length,
          error: res.error,
        },
        null,
        2,
      ));
      Deno.exit(res.error ? 1 : 0);
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.stack ?? e.message : String(e));
      Deno.exit(1);
    });
}
