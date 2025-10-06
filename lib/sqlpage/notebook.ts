/**
 * @module sqlpage/notebook
 *
 * Purpose:
 * A class-based toolkit for turning Markdown Notebook sources into a structured
 * stream of typed SQL fences and a SQLPage project layout. It validates
 * frontmatter and fence attributes with Zod, aggregates configuration into
 * sqlpage.json, and provides helpers to materialize files and run a simple CLI
 * workflow.
 *
 * Main capabilities:
 * - Parse one or more Markdown sources (string or ReadableStream) into SQL fences.
 * - Validate per-language fence attributes with Zod for strong typing.
 * - Capture frontmatter and generate a sqlpage.json configuration from a
 *   "sqlpage-conf" section, including flattening of nested OIDC fields to the flat
 *   keys used by SQLPage.
 * - Provide a CLI wrapper to drain fences and optionally emit sqlpage.json.
 * - Provide a materializer that writes head/tail/page fences into a SQLPage-compatible
 *   directory tree.
 *
 * Major classes:
 * - SqlPageContentBuilder<FM, M>:
 *   Builder that configures frontmatter schema, attribute schemas, delimiter policy,
 *   and returns a SqlPageContent instance with safe defaults.
 *
 * - SqlPageContent<FM, M>:
 *   Core reader and validator. Consumes sources and yields SQL fences via SQL().
 *   Exposes issues() for collected errors/warnings and sqlPageConf() to produce a
 *   validated sqlpage.json configuration object and JSON string. A fence is considered
 *   "typed" (has attrsSafe) whenever a schema exists for its language; control
 *   fences (role: "section-defaults") are always untyped.
 *
 * - SqlPageCLI<FM, M>:
 *   Wrapper around SqlPageContent that drains fences and optionally writes sqlpage.json
 *   to disk. Returns a summary with total fences, typed fences, and whether any error
 *   issues were seen.
 *
 * - SqlPageMaterializer<FM, M>:
 *   Filesystem emitter that writes a SQLPage project tree from a SqlPageContent instance:
 *   head  -> <srcHome>/sql.d/head/{name|###}.sql
 *   tail  -> <srcHome>/sql.d/tail/{name|###}.sql
 *   page  -> <srcHome>/<path>.sql (subdirectories honored)
 *
 * Important types:
 * - SqlFenceBase: Core fence plus provenance fields sourceId and blockIndex.
 * - SqlFenceTyped<M>: SqlFenceBase plus attrsSafe when validation succeeds.
 * - SqlPageContentIssue: Union of core parsing issues and attribute-validation issues.
 * - AttrSchemasConfig<FM, M>: Language to Zod schema (or factory) mapping.
 * - BinaryStream: ReadableStream<Uint8Array> alias for streaming inputs.
 * - SqlPageConf: Type for the validated sqlpage.json configuration object.
 *
 * Default SQL fence attributes:
 * - head: strict; optional name
 * - tail: allows extra keys; optional name
 * - page: path is required; kind defaults to "page" if omitted
 * - control fences identified by role: "section-defaults" are untyped
 *
 * Example usage:
 * @example
 * import { SqlPageContentBuilder, SqlPageMaterializer, SqlPageCLI } from "./notebook.ts";
 *
 * // Provide Markdown sources (string or stream); multiple sources are supported
 * async function* sources() {
 *   const md = `
 * ---
 * siteName: Demo
 * sqlpage-conf:
 *   database_url: "sqlite://app.db"
 *   listen_on: "0.0.0.0:8080"
 *   oidc:
 *     issuer_url: "https://issuer.example/"
 *     client_id: "abc"
 *     client_secret: "shh"
 * ---
 *
 * ```sql { kind: "head", name: "pragma" }
 * PRAGMA foreign_keys = ON;
 * ```
 *
 * ```sql { kind: "page", path: "admin/index" }
 * select 1;
 * ```
 *
 * ```sql { path: "users/list" }
 * select 2;
 * ```
 *
 * ```sql { kind: "tail" }
 * -- done
 * ```
 * `.trim();
 *   yield { identifier: "inline.md", markdown: md };
 * }
 *
 * // Build content with defaults
 * const content = new SqlPageContentBuilder().build(sources());
 *
 * // Option A: Emit files to a SQLPage-compatible tree
 * const mat = new SqlPageMaterializer(content, { srcHome: "./app" });
 * const { emitted } = await mat.emit();
 * console.log(emitted);
 *
 * // Option B: Produce sqlpage.json (and optionally write it)
 * const { json } = content.sqlPageConf();
 * await Deno.mkdir("./sqlpage", { recursive: true });
 * await Deno.writeTextFile("./sqlpage/sqlpage.json", json);
 *
 * // Option C: Use the CLI wrapper to also write sqlpage.json
 * const cli = new SqlPageCLI(content, { emitConfPath: "./sqlpage/sqlpage.json" });
 * const summary = await cli.run();
 * console.log(summary);
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
import { dirname, join as pathJoin } from "jsr:@std/path@1";

/* ---------------------------------- Types -------------------------------- */

export type BinaryStream = ReadableStream<Uint8Array>;
type AttrMap = Record<string, unknown>;

export type SqlFenceBase = FencedBlockBase & {
  readonly sourceId: string;
  readonly blockIndex: number; // alias to core index
};

export type SqlFenceTyped<M extends AttrMap> = FencedBlockTyped<M> & {
  readonly sourceId: string;
  readonly blockIndex: number;
};

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

/* -------------------------- Default schemas (safe) ------------------------ */

// ----- SQLPage configuration schema (frontmatter-friendly) -----
// Covers keys documented across SQLPage docs & guides.
// Notes:
// - Accepts a nested `oidc` object in frontmatter for ergonomics.
// - Also accepts flat OIDC keys (`oidc_*`) since SQLPage uses flat keys in json.
// - `sqlPageConf()` below will flatten `oidc` to the flat keys for the final JSON.
//
// Sources (docs):
// - database_url, listen_on, web_root: quickstart guide. :contentReference[oaicite:0]{index=0}
// - https_domain: blog post about HTTPS. :contentReference[oaicite:1]{index=1}
// - site_prefix: reverse proxy/nginx example & routing post. :contentReference[oaicite:2]{index=2}
// - allow_exec: exec() function docs. :contentReference[oaicite:3]{index=3}
// - max_uploaded_file_size: doc/blog. :contentReference[oaicite:4]{index=4}
// - environment (production/development): docker hub env var. :contentReference[oaicite:5]{index=5}
// - OIDC (issuer/client/secret) & host: SSO page. :contentReference[oaicite:6]{index=6}
// - database_password: maintainer discussion (newer addition). Treat as optional. :contentReference[oaicite:7]{index=7}
export const sqlPageConfSchema = z.object({
  // Core server & DB
  database_url: z.string().min(1).optional(),
  database_password: z.string().min(1).optional(), // optional, supported in newer versions
  listen_on: z.string().min(1).optional(), // e.g. "0.0.0.0:8080"
  web_root: z.string().min(1).optional(),

  // Routing / base path
  site_prefix: z.string().min(1).optional(), // e.g. "/sqlpage"

  // HTTPS / host
  https_domain: z.string().min(1).optional(), // e.g. "example.com"
  host: z.string().min(1).optional(), // required by SSO; must match domain exactly

  // Security / limits
  allow_exec: z.boolean().optional(),
  max_uploaded_file_size: z.number().int().positive().optional(),

  // Environment
  environment: z.enum(["production", "development"]).optional(),

  // Frontmatter-friendly nested OIDC
  oidc: z.object({
    issuer_url: z.string().min(1),
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
    scopes: z.array(z.string()).optional(),
    redirect_path: z.string().min(1).optional(),
  }).optional(),

  // Also accept already-flat OIDC keys (as SQLPage expects in json)
  oidc_issuer_url: z.string().min(1).optional(),
  oidc_client_id: z.string().min(1).optional(),
  oidc_client_secret: z.string().min(1).optional(),
}).catchall(z.unknown());

export type SqlPageConf = z.infer<typeof sqlPageConfSchema>;

// --- default frontmatter schema (unchanged except kept .catchall) ---
const defaultFmSchema = z.object({
  siteName: z.string().optional(),
  "sqlpage-conf": sqlPageConfSchema.optional(),
}).catchall(z.unknown());

export const defaultSqlAttrs = z.union([
  // head: strict; optional name
  z.object({
    kind: z.literal("head"),
    name: z.string().min(1).optional(),
  }).strict(),

  // tail: allow extras; optional name
  z.object({
    kind: z.literal("tail"),
    name: z.string().min(1).optional(),
  }).catchall(z.unknown()),

  // control fence: never error during core validation
  z.object({
    role: z.literal("section-defaults"),
  }).catchall(z.unknown()),

  // page: kind optional with default 'page'; REQUIRED path; allow extras
  z.object({
    kind: z.literal("page").optional().default("page"),
    path: z.string().min(1),
  }).catchall(z.unknown()),
]);

/* -------------------------------- Utilities ------------------------------- */

const isRec = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

async function toText(input: string | BinaryStream) {
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

const ensureDir = async (absDir: string) => {
  await Deno.mkdir(absDir, { recursive: true });
};

const sanitizeName = (s: string) =>
  s.trim()
    .replace(/[^\p{L}\p{N}\-_./]/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^\./, "_");

const zero = (n: number, width = 3) => String(n).padStart(width, "0");

/* ---------------------- Attr schema config (public input) ----------------- */

export type AttrSchemasConfig<FM, M extends AttrMap> = Partial<
  {
    [K in keyof M & string]:
      | z.ZodType<M[K]>
      | ((ctx: { fm: FM; lang: K }) => z.ZodType<M[K]>);
  }
>;

// Internal normalization target:
type AttrSchemaEntry<FM> =
  | z.ZodTypeAny
  | ((ctx: { fm: FM; lang: string }) => z.ZodTypeAny);

/* --------------------------------- Builder -------------------------------- */

export class SqlPageContentBuilder<
  FM = z.infer<typeof defaultFmSchema>,
  M extends AttrMap = { sql: z.infer<typeof defaultSqlAttrs> },
> {
  #fmSchema: z.ZodType<FM> = defaultFmSchema as unknown as z.ZodType<FM>;

  // Internal map of language -> zod type or factory
  #attrSchemaMap: Map<string, AttrSchemaEntry<FM>> = new Map([
    ["sql", defaultSqlAttrs as unknown as z.ZodTypeAny],
  ]);

  #delimiter: InstructionsDelimiter = { kind: "heading", level: 2 };
  #strictAttrValidation = false;
  #enableAttrResolution = true;
  #mirrorFrontmatter = false;
  #confKey = "sqlpage-conf";

  withFrontmatterSchema(schema: z.ZodType<FM>) {
    this.#fmSchema = schema;
    return this;
  }

  withAttrSchemas(schemas: AttrSchemasConfig<FM, M>) {
    // Normalize to internal map. If empty, keep default sql schema.
    this.#attrSchemaMap.clear();
    const entries = Object.entries(schemas) as Array<
      [keyof M & string, AttrSchemasConfig<FM, M>[keyof M & string]]
    >;
    if (entries.length === 0) {
      this.#attrSchemaMap.set(
        "sql",
        defaultSqlAttrs as unknown as z.ZodTypeAny,
      );
      return this;
    }
    for (const [lang, sch] of entries) {
      if (!sch) continue;
      const normalized: AttrSchemaEntry<FM> = typeof sch === "function"
        ? (ctx: { fm: FM; lang: string }) =>
          (sch as (c: { fm: FM; lang: string }) => z.ZodTypeAny)({
            fm: ctx.fm,
            lang: ctx.lang,
          })
        : (sch as unknown as z.ZodTypeAny);
      this.#attrSchemaMap.set(lang, normalized);
    }
    return this;
  }

  withInstructionsDelimiter(d: InstructionsDelimiter) {
    this.#delimiter = d;
    return this;
  }
  withStrictAttrValidation(on = true) {
    this.#strictAttrValidation = on;
    return this;
  }
  withAttrResolution(on = true) {
    this.#enableAttrResolution = on;
    return this;
  }
  withFrontmatterMirror(on = true) {
    this.#mirrorFrontmatter = on;
    return this;
  }
  withSqlPageConfKey(key = "sqlpage-conf") {
    this.#confKey = key;
    return this;
  }

  build(
    provenance: AsyncGenerator<
      { identifier: string; markdown: string | BinaryStream }
    >,
  ) {
    return new SqlPageContent<FM, M>({
      fmSchema: this.#fmSchema,
      attrSchemaMap: new Map(this.#attrSchemaMap),
      delimiter: this.#delimiter,
      strictAttrValidation: this.#strictAttrValidation,
      enableAttrResolution: this.#enableAttrResolution,
      mirrorFrontmatter: this.#mirrorFrontmatter,
      confKey: this.#confKey,
      provenance,
    });
  }
}

/* --------------------------------- Content -------------------------------- */

export class SqlPageContent<
  FM = z.infer<typeof defaultFmSchema>,
  M extends AttrMap = { sql: z.infer<typeof defaultSqlAttrs> },
> {
  protected fmSchema: z.ZodType<FM>;
  protected attrSchemaMap: Map<string, AttrSchemaEntry<FM>>;
  protected readonly delimiter: InstructionsDelimiter;
  protected readonly strictAttrValidation: boolean;
  protected readonly enableAttrResolution: boolean;
  protected readonly mirrorFrontmatter: boolean;
  protected readonly confKey: string;
  protected readonly provenance: AsyncGenerator<
    { identifier: string; markdown: string | BinaryStream }
  >;

  protected readonly allIssues: SqlPageContentIssue[] = [];
  protected readonly frontmatters: Array<{ sourceId: string; fm: FM }> = [];

  constructor(init: {
    fmSchema: z.ZodType<FM>;
    attrSchemaMap: Map<string, AttrSchemaEntry<FM>>;
    delimiter: InstructionsDelimiter;
    strictAttrValidation: boolean;
    enableAttrResolution: boolean;
    mirrorFrontmatter: boolean;
    confKey: string;
    provenance: AsyncGenerator<
      { identifier: string; markdown: string | BinaryStream }
    >;
  }) {
    this.fmSchema = init.fmSchema;
    this.attrSchemaMap = init.attrSchemaMap;
    this.delimiter = init.delimiter;
    this.strictAttrValidation = init.strictAttrValidation;
    this.enableAttrResolution = init.enableAttrResolution;
    this.mirrorFrontmatter = init.mirrorFrontmatter;
    this.confKey = init.confKey;
    this.provenance = init.provenance;
  }

  /** Async stream of SQL fences (typed if schema passes). */
  async *SQL() {
    for await (const src of this.provenance) {
      const sourceId = src.identifier;
      const md = await toText(src.markdown);
      const nb = await this.parseOneSource(sourceId, md);
      if (!nb) continue;

      this.frontmatters.push({ sourceId, fm: nb.fm as FM });
      for (const i of nb.issues) this.allIssues.push(i);

      for (const b of nb.blocks) {
        if (!this.isTargetLanguage(b.lang)) continue;
        const base = this.mapFenceBase(sourceId, b);

        if (this.isControlFence(base)) {
          if (!this.strictAttrValidation) {
            yield base as unknown as SqlFenceTyped<M>;
          }
          continue;
        }
        if (!this.isTypedFence(base)) {
          if (!this.strictAttrValidation) {
            yield base as unknown as SqlFenceTyped<M>;
          }
          continue;
        }

        const validated = this.validateTypedFence(nb.fm as FM, base);
        if (validated.ok && validated.attrsSafe !== undefined) {
          yield Object.freeze({
            ...base,
            attrsSafe: validated.attrsSafe,
          }) as unknown as SqlFenceTyped<M>;
        } else if (!this.strictAttrValidation) {
          yield base as unknown as SqlFenceTyped<M>;
        }
      }
    }
  }

  issues() {
    return this.allIssues as readonly SqlPageContentIssue[];
  }

  // Utility: drop undefined recursively
  protected dropUndef<T extends Record<string, unknown>>(obj: T): T {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const nested = this.dropUndef(v as Record<string, unknown>);
        if (Object.keys(nested).length > 0) out[k] = nested;
      } else {
        out[k] = v;
      }
    }
    return out as T;
  }

  // Produces the exact JSON object you can write to sqlpage/sqlpage.json
  sqlPageConf(conf: z.infer<typeof sqlPageConfSchema>) {
    // Start from a shallow clone
    const out: Record<string, unknown> = { ...conf };

    // Flatten nested OIDC if provided
    if (conf.oidc) {
      const { issuer_url, client_id, client_secret, scopes, redirect_path } =
        conf.oidc;
      // Only set flat keys if not already set at top level
      if (issuer_url && out.oidc_issuer_url === undefined) {
        out.oidc_issuer_url = issuer_url;
      }
      if (client_id && out.oidc_client_id === undefined) {
        out.oidc_client_id = client_id;
      }
      if (client_secret && out.oidc_client_secret === undefined) {
        out.oidc_client_secret = client_secret;
      }
      if (scopes !== undefined) out.oidc_scopes = scopes; // SQLPage ignores unknowns; keeping for future
      if (redirect_path !== undefined) out.oidc_redirect_path = redirect_path;
      delete out.oidc;
    }

    // Clean undefineds
    return this.dropUndef(out);
  }

  /* ------------------------------ Hooks ---------------------------------- */

  // Boolean, not a type predicate (easier to extend safely)
  protected isTargetLanguage(lang: string): boolean {
    return lang === "sql";
  }

  protected isControlFence(b: SqlFenceBase) {
    const merged =
      ((b as unknown as { resolvedAttrs?: unknown; attrs?: unknown })
        .resolvedAttrs ??
        (b as unknown as { resolvedAttrs?: unknown; attrs?: unknown })
          .attrs) as unknown;
    const role = isRec(merged) &&
        typeof (merged as Record<string, unknown>)["role"] === "string"
      ? String((merged as Record<string, unknown>)["role"])
      : undefined;
    return role === "section-defaults";
  }

  protected isTypedFence(b: SqlFenceBase): boolean {
    const lang = (b as unknown as { lang: string }).lang;
    // If the language has a registered schema, we consider the fence typed,
    // except control fences which we intentionally keep untyped.
    if (!this.attrSchemaMap.has(lang)) return false;
    if (this.isControlFence(b)) return false;
    return true;
  }

  protected async parseOneSource(sourceId: string, md: string) {
    let builder: NotebookBuilder<Root> = new NotebookBuilder<Root>()
      .withInstructionsDelimiter(this.delimiter)
      .withAttrResolution(this.enableAttrResolution)
      .withFrontmatterMirror(this.mirrorFrontmatter);

    for (const [lang, sch] of this.attrSchemaMap.entries()) {
      const adapt = typeof sch === "function"
        ? (ctx: { fm: unknown; lang: string }) =>
          (sch as (c: { fm: FM; lang: string }) => z.ZodTypeAny)({
            fm: ctx.fm as FM,
            lang: ctx.lang,
          })
        : (sch as z.ZodTypeAny);
      // @ts-ignore: generic widening from NotebookBuilder.withSafeAttributes()
      builder = builder.withSafeAttributes(lang, adapt) as NotebookBuilder<
        Root
      >;
    }

    try {
      return await builder.fromString(md, sourceId).build(this.fmSchema);
    } catch (err) {
      this.allIssues.push({
        kind: "frontmatter-parse",
        message: "Frontmatter validation failed.",
        raw: {},
        error: err instanceof Error ? err.message : String(err),
        filename: sourceId,
        disposition: "error",
      } as EmittedIssue);
      return undefined;
    }
  }

  protected mapFenceBase(sourceId: string, b: FencedBlockBase) {
    // Drop any attrsSafe the core may have attached; we’ll add it explicitly
    // only for fences we consider typed.
    const raw = b as unknown as Record<string, unknown>;
    const { attrsSafe: _ignore, ...withoutSafe } = raw;

    return Object.freeze({
      ...(withoutSafe as unknown as FencedBlockBase),
      code: String(b.code ?? "").trim(),
      sourceId,
      blockIndex: b.index,
    }) as SqlFenceBase;
  }

  protected validateTypedFence(fm: FM, base: SqlFenceBase) {
    // Control fences should never be typed
    if (this.isControlFence(base)) {
      return { ok: false as const };
    }

    const lang = (base as unknown as { lang: string }).lang;
    const sch = this.attrSchemaMap.get(lang);
    if (!sch) return { ok: true as const, attrsSafe: undefined as unknown };

    const merged =
      ((base as unknown as { resolvedAttrs?: unknown; attrs?: unknown })
        .resolvedAttrs ??
        (base as unknown as { resolvedAttrs?: unknown; attrs?: unknown })
          .attrs) as unknown;

    const schema: z.ZodType<unknown> = typeof sch === "function"
      ? (sch as (ctx: { fm: FM; lang: string }) => z.ZodType<unknown>)({
        fm,
        lang,
      })
      : (sch as z.ZodType<unknown>);

    const res = (schema as z.ZodTypeAny).safeParse(merged);
    if (res.success) return { ok: true as const, attrsSafe: res.data };

    this.allIssues.push({
      kind: "attrs-validate",
      disposition: this.strictAttrValidation ? "error" : "warning",
      message: `Attributes failed schema validation for language "${lang}".`,
      lang,
      sourceId: (base as unknown as { sourceId: string }).sourceId,
      blockIndex: (base as unknown as { blockIndex: number }).blockIndex,
      startLine: base.startLine,
      endLine: base.endLine,
      candidate: merged,
      zodError: res.error,
    });
    return { ok: false as const };
  }
}

/* ----------------------------------- CLI ---------------------------------- */

export interface SqlPageCLIRunResult<M extends AttrMap> {
  fences: readonly SqlFenceTyped<M>[];
  issues: readonly ReturnType<SqlPageContent["issues"]>[number][];
  error: boolean;
  typedCount: number;
  totalCount: number;
}

export interface SqlPageCLIOptions {
  emitConfPath?: string;
  failOnError?: boolean;
}

export class SqlPageCLI<
  FM,
  M extends AttrMap = Record<PropertyKey, never>,
> {
  constructor(
    protected readonly content: SqlPageContent<FM, M>,
    protected readonly opts: SqlPageCLIOptions = {},
  ) {}

  async run() {
    const fences: SqlFenceTyped<M>[] = [];
    for await (const f of this.content.SQL()) fences.push(f);

    const issues = this.content.issues();
    const error = issues.some((i) =>
      (i as { disposition?: string }).disposition === "error"
    );

    if (this.opts.failOnError && error) {
      throw Object.assign(new Error("SqlPageCLI detected error issues."), {
        details: { issues },
      });
    }

    const typedCount =
      fences.filter((f) =>
        (f as { attrsSafe?: unknown }).attrsSafe !== undefined
      ).length;

    const result: SqlPageCLIRunResult<M> = {
      fences,
      issues,
      error,
      typedCount,
      totalCount: fences.length,
    };
    return result;
  }

  protected normalizeIssues() {
    return this.content.issues();
  }
}

/* ------------------------------- Materializer ----------------------------- */

export interface SqlPageMaterializerOptions {
  srcHome: string;
  padWidth?: number;
  overwrite?: boolean;
}

type AnyFence<M extends AttrMap> = SqlFenceTyped<M> & {
  attrs?: Record<string, unknown>;
  resolvedAttrs?: Record<string, unknown>;
};

export class SqlPageMaterializer<
  FM,
  M extends AttrMap = Record<PropertyKey, never>,
> {
  constructor(
    protected readonly content: SqlPageContent<FM, M>,
    protected readonly opts: SqlPageMaterializerOptions,
  ) {}

  async emit() {
    const pad = this.opts.padWidth ?? 3;
    const overwrite = this.opts.overwrite ?? true;

    const headDir = pathJoin(this.opts.srcHome, "sql.d", "head");
    const tailDir = pathJoin(this.opts.srcHome, "sql.d", "tail");

    await ensureDir(headDir);
    await ensureDir(tailDir);

    let headIx = 0;
    let tailIx = 0;
    let pageIx = 0;

    const emitted: string[] = [];

    for await (const fence of this.content.SQL()) {
      const f = fence as AnyFence<M>;
      const attrsSafe =
        (f as { attrsSafe?: Record<string, unknown> }).attrsSafe;
      const merged = (f.resolvedAttrs ?? f.attrs ?? {}) as Record<
        string,
        unknown
      >;

      // Prefer attrsSafe (it contains defaults like kind: "page")
      const kindVal = attrsSafe?.kind ?? merged.kind;
      const kind = typeof kindVal === "string" ? kindVal : undefined;

      // head/tail optional name
      const nameHeadTail = this.asString(
        (attrsSafe?.name ?? merged.name) as unknown,
      );

      // page REQUIRED path (typed fences will always have it)
      const pathPage = this.asString(
        (attrsSafe?.path ?? merged.path) as unknown,
      );

      if (kind === "head") {
        const baseName = nameHeadTail
          ? sanitizeName(nameHeadTail)
          : zero(headIx++, pad);
        const outPath = pathJoin(headDir, `${baseName}.sql`);
        await this.write(outPath, f.code, overwrite);
        emitted.push(outPath);
        continue;
      }

      if (kind === "tail") {
        const baseName = nameHeadTail
          ? sanitizeName(nameHeadTail)
          : zero(tailIx++, pad);
        const outPath = pathJoin(tailDir, `${baseName}.sql`);
        await this.write(outPath, f.code, overwrite);
        emitted.push(outPath);
        continue;
      }

      if (kind === "page") {
        // Typed: path must be present by schema; for any non-typed fence, we still
        // fall back to numeric to be tolerant in non-strict mode.
        const fileStem = pathPage
          ? sanitizeName(pathPage)
          : zero(pageIx++, pad);
        const outRel = fileStem.endsWith(".sql") ? fileStem : `${fileStem}.sql`;
        const outPath = pathJoin(this.opts.srcHome, outRel);
        await ensureDir(dirname(outPath));
        await this.write(outPath, f.code, overwrite);
        emitted.push(outPath);
        continue;
      }

      await this.handleUnknownKind(f as SqlFenceTyped<M>);
    }

    return { emitted };
  }

  protected asString(v: unknown) {
    return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
  }

  protected async handleUnknownKind(_f: SqlFenceTyped<M>) {
    // no-op by default
  }

  protected async write(absFile: string, sql: string, overwrite: boolean) {
    const exists = await this.exists(absFile);
    if (exists && !overwrite) return;
    await Deno.writeTextFile(absFile, sql.endsWith("\n") ? sql : sql + "\n");
  }

  protected async exists(absFile: string) {
    try {
      const st = await Deno.stat(absFile);
      return st.isFile;
    } catch {
      return false;
    }
  }
}
