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

  async function toText(input: string | BinaryStream): Promise<string> {
    if (typeof input === "string") return input;
    const reader = input.getReader();
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return new TextDecoder().decode(out);
  }

  async function* stream(): AsyncGenerator<SqlFenceTyped<M>, void, unknown> {
    for await (const src of provenance) {
      const sourceId = src.identifier;
      const md = await toText(src.markdown);

      const builder = new NotebookBuilder<Root>()
        .withInstructionsDelimiter(delimiter)
        .withAttrResolution(enableAttrResolution)
        .withFrontmatterMirror(mirrorFrontmatter);

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

      for (const core of nb.issues) allIssues.push(core);

      for (const b of nb.blocks) {
        if (b.lang !== "sql") continue;

        // Start from the original fenced block and add provenance + alias.
        // Also normalize code (trim) for nicer DX.
        const base: SqlFenceBase = Object.freeze({
          ...b,
          code: String(b.code ?? "").trim(),
          sourceId,
          blockIndex: b.index,
        });

        // If caller didn't supply a schema for this lang, emit as-is.
        const attrSchemas = init.attrSchemas as SqlPageContentInit<
          FM,
          M
        >["attrSchemas"];
        const sch = attrSchemas?.[b.lang as keyof M & string];
        if (!sch) {
          // Emit as FencedBlockTyped<M> + provenance.
          yield base as unknown as SqlFenceTyped<M>;
          continue;
        }

        // Resolve schema (factory or zod type).
        const schema: z.ZodType<unknown> = typeof sch === "function"
          ? (sch as (ctx: { fm: FM; lang: string }) => z.ZodType<unknown>)({
            fm: nb.fm as FM,
            lang: b.lang,
          })
          : (sch as z.ZodType<unknown>);

        const candidate: unknown = b.resolvedAttrs ?? b.attrs;
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
          if (strictAttrValidation) continue;
          yield base as unknown as SqlFenceTyped<M>;
          continue;
        }

        // Success: attach attrsSafe (typed via M at the callsite).
        const withSafe = Object.freeze({
          ...base,
          attrsSafe: result.data,
        }) as unknown as SqlFenceTyped<M>;

        yield withSafe;
      }
    }
  }

  return {
    SQL: () => stream(),
    issues: () => allIssues as readonly SqlPageContentIssue[],
  };
}
