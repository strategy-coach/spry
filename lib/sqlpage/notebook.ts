#!/usr/bin/env -S deno run -A
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
 * - AttrSetupFn / AttrSetupConfig: Per-language/global callbacks to mutate attrs before validation.
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
 * // Build content with defaults and a pre-validation setup for sql blocks
 * const content = new SqlPageContentBuilder()
 *   .withAttrSetup({
 *     sql: ({ raw }) => {
 *       // Example: default 'kind' to 'page' when a path is provided
 *       if (raw && typeof raw === "object" && "path" in raw && !("kind" in raw)) {
 *         return { ...raw, kind: "page" };
 *       }
 *       return raw;
 *     },
 *   })
 *   // Optional global setup that runs before the per-language setup
 *   .withGlobalAttrSetup(({ raw }) => raw)
 *   .build(sources());
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
import { Command } from "jsr:@cliffy/command@1.0.0-rc.8";
import { HelpCommand } from "jsr:@cliffy/command@1.0.0-rc.8/help";
import { dirname, join as pathJoin } from "jsr:@std/path@1";
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
import { routeAnnSchema } from "../assembler/mod.ts";

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

/** Pre-validation setup callback that can mutate attrs before Zod validation. */
export type AttrSetupFn<FM> = (ctx: {
  /** Frontmatter (already validated at the doc level) */
  fm: FM;
  /** Fenced language (e.g., "sql") */
  lang: string;
  /** Source identifier of the markdown being parsed */
  sourceId: string;
  /** 0-based index of the block within source */
  blockIndex: number;
  /** The fence being validated (without attrsSafe applied) */
  fence: SqlFenceBase;
  /**
   * The merged attributes that would be validated:
   * resolvedAttrs ?? attrs (i.e., after section-defaults resolution, if enabled)
   */
  raw: Record<string, unknown>;
}) => Record<string, unknown>;

export type AttrSetupConfig<FM> = Partial<Record<string, AttrSetupFn<FM>>>;

/* -------------------------- Default schemas (safe) ------------------------ */

// ----- SQLPage configuration schema (frontmatter-friendly) -----
export const sqlPageConfSchema = z
  .object({
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
    oidc: z
      .object({
        issuer_url: z.string().min(1),
        client_id: z.string().min(1),
        client_secret: z.string().min(1),
        scopes: z.array(z.string()).optional(),
        redirect_path: z.string().min(1).optional(),
      })
      .optional(),

    // Also accept already-flat OIDC keys (as SQLPage expects in json)
    oidc_issuer_url: z.string().min(1).optional(),
    oidc_client_id: z.string().min(1).optional(),
    oidc_client_secret: z.string().min(1).optional(),
  })
  .catchall(z.unknown());

export type SqlPageConf = z.infer<typeof sqlPageConfSchema>;

// --- default frontmatter schema (unchanged except kept .catchall) ---
const defaultFmSchema = z
  .object({
    siteName: z.string().optional(),
    "sqlpage-conf": sqlPageConfSchema.optional(),
  })
  .catchall(z.unknown());

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

  // control fence: never typed
  z.object({
    role: z.literal("section-defaults"),
  }).catchall(z.unknown()),

  // NEW: shell (regular SQLPage file), track by identifier and path
  z.object({
    kind: z.literal("shell"),
    identifier: z.string().min(1),
    path: z.string().min(1),
  }).catchall(z.unknown()),

  // NEW: partial (regular SQLPage file), track by identifier and path
  z.object({
    kind: z.literal("partial"),
    identifier: z.string().min(1),
    path: z.string().min(1),
  }).catchall(z.unknown()),

  // page: kind optional; REQUIRED path; may reference a shell by identifier
  z.object({
    kind: z.literal("page").optional().default("page"),
    path: z.string().min(1),
    shell: z.string().min(1).optional(),
    route: routeAnnSchema.optional(),
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

  // NEW: per-language pre-validation setup callbacks
  #attrSetupMap: Map<string, AttrSetupFn<FM>> = new Map();

  // NEW: optional global setup that runs before per-language setup
  #globalAttrSetup?: AttrSetupFn<FM>;

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

  /** Register per-language attribute setup callbacks (run before validation). */
  withAttrSetup(config: AttrSetupConfig<FM>) {
    this.#attrSetupMap.clear();
    for (const [lang, fn] of Object.entries(config)) {
      if (typeof fn === "function") this.#attrSetupMap.set(lang, fn);
    }
    return this;
  }

  /** Register a global attribute setup callback (runs before per-language setup). */
  withGlobalAttrSetup(fn?: AttrSetupFn<FM>) {
    this.#globalAttrSetup = fn;
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
      attrSetupMap: new Map(this.#attrSetupMap), // NEW
      globalAttrSetup: this.#globalAttrSetup, // NEW
      delimiter: this.#delimiter,
      strictAttrValidation: this.#strictAttrValidation,
      enableAttrResolution: this.#enableAttrResolution,
      mirrorFrontmatter: this.#mirrorFrontmatter,
      confKey: this.#confKey,
      provenance,
    });
  }

  static typical<
    FM = z.infer<typeof defaultFmSchema>,
    M extends AttrMap = { sql: z.infer<typeof defaultSqlAttrs> },
  >() {
    return new SqlPageContentBuilder<FM, M>()
      .withAttrSetup({
        sql: ({ raw }) => {
          // the default route.path should be the same as sql path
          if (
            raw && typeof raw === "object" && "path" in raw &&
            ("route" in raw &&
              (raw.route && typeof raw.route === "object" &&
                !("path" in raw.route)))
          ) {
            const path = (raw as Record<string, unknown>)["path"];
            return { ...raw, route: { ...raw.route, path } };
          }
          return raw;
        },
      });
  }
}

/* --------------------------------- Content -------------------------------- */

export class SqlPageContent<
  FM = z.infer<typeof defaultFmSchema>,
  M extends AttrMap = { sql: z.infer<typeof defaultSqlAttrs> },
> {
  readonly fmSchema: z.ZodType<FM>;
  readonly attrSchemaMap: Map<string, AttrSchemaEntry<FM>>;
  /** NEW: per-language pre-validation setup callbacks */
  readonly attrSetupMap: Map<string, AttrSetupFn<FM>>;
  /** NEW: global pre-validation setup callback */
  readonly globalAttrSetup?: AttrSetupFn<FM>;

  readonly delimiter: InstructionsDelimiter;
  readonly strictAttrValidation: boolean;
  readonly enableAttrResolution: boolean;
  readonly mirrorFrontmatter: boolean;
  readonly confKey: string;
  readonly provenance: AsyncGenerator<
    { identifier: string; markdown: string | BinaryStream }
  >;

  readonly allIssues: SqlPageContentIssue[] = [];
  readonly frontmatters: Array<{ sourceId: string; fm: FM }> = [];

  constructor(init: {
    fmSchema: z.ZodType<FM>;
    attrSchemaMap: Map<string, AttrSchemaEntry<FM>>;
    /** NEW: per-language setup */
    attrSetupMap: Map<string, AttrSetupFn<FM>>;
    /** NEW: global setup */
    globalAttrSetup?: AttrSetupFn<FM>;
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
    this.attrSetupMap = init.attrSetupMap;
    this.globalAttrSetup = init.globalAttrSetup;
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

  /** Apply global + per-language setup (in that order). */
  protected applyAttrSetup(
    fm: FM,
    base: SqlFenceBase,
    merged: Record<string, unknown>,
  ): Record<string, unknown> {
    let next = merged;
    // Global first
    if (this.globalAttrSetup) {
      next = this.safeSetupInvoke(this.globalAttrSetup, fm, base, next);
    }
    // Per-language next
    const lang = (base as unknown as { lang: string }).lang;
    const langSetup = this.attrSetupMap.get(lang);
    if (langSetup) {
      next = this.safeSetupInvoke(langSetup, fm, base, next);
    }
    return next;
  }

  private safeSetupInvoke(
    fn: AttrSetupFn<FM>,
    fm: FM,
    base: SqlFenceBase,
    raw: Record<string, unknown>,
  ): Record<string, unknown> {
    try {
      const out = fn({
        fm,
        lang: (base as unknown as { lang: string }).lang,
        sourceId: base.sourceId,
        blockIndex: base.blockIndex,
        fence: base,
        raw,
      });
      return isRec(out) ? out : raw;
    } catch (e) {
      this.allIssues.push({
        kind: "attrs-validate",
        disposition: "warning",
        message: `Attribute setup callback threw; using original attrs. ${
          (e as Error)?.message ?? String(e)
        }`,
        lang: (base as unknown as { lang: string }).lang,
        sourceId: base.sourceId,
        blockIndex: base.blockIndex,
        startLine: base.startLine,
        endLine: base.endLine,
        candidate: raw,
        zodError: undefined,
      });
      return raw;
    }
  }

  protected validateTypedFence(fm: FM, base: SqlFenceBase) {
    // Control fences should never be typed
    if (this.isControlFence(base)) {
      return { ok: false as const };
    }

    const lang = (base as unknown as { lang: string }).lang;
    const sch = this.attrSchemaMap.get(lang);
    if (!sch) return { ok: true as const, attrsSafe: undefined as unknown };

    const originalMerged =
      ((base as unknown as { resolvedAttrs?: unknown; attrs?: unknown })
        .resolvedAttrs ??
        (base as unknown as { resolvedAttrs?: unknown; attrs?: unknown })
          .attrs) as unknown;

    const merged: Record<string, unknown> = isRec(originalMerged)
      ? (originalMerged as Record<string, unknown>)
      : {};

    // NEW: run setup pipeline BEFORE validation
    const prepared = this.applyAttrSetup(fm, base, merged);

    const schema: z.ZodType<unknown> = typeof sch === "function"
      ? (sch as (ctx: { fm: FM; lang: string }) => z.ZodType<unknown>)({
        fm,
        lang,
      })
      : (sch as z.ZodType<unknown>);

    const res = (schema as z.ZodTypeAny).safeParse(prepared);
    if (res.success) return { ok: true as const, attrsSafe: res.data };

    this.allIssues.push({
      kind: "attrs-validate",
      disposition: this.strictAttrValidation ? "error" : "warning",
      message: `Attributes failed schema validation for language "${lang}". ` +
        z.prettifyError(res.error),
      lang,
      sourceId: (base as unknown as { sourceId: string }).sourceId,
      blockIndex: (base as unknown as { blockIndex: number }).blockIndex,
      startLine: base.startLine,
      endLine: base.endLine,
      candidate: prepared, // report the post-setup candidate
      zodError: res.error,
    });
    return { ok: false as const };
  }
}

// ---------------------- CLI wrapper ----------------------

export class SqlPageNotebookCLI<
  FM,
  M extends AttrMap = Record<PropertyKey, never>,
> {
  constructor(private readonly builder?: SqlPageContentBuilder<FM, M>) {}

  async run(argv: string[] = Deno.args) {
    const enc = new TextEncoder();

    await new Command()
      .name("notebook.ts")
      .version("0.1.0")
      .description(
        "SQLPage Markdown Notebook: emit SQL package, write sqlpage.json, or materialize filesystem.",
      )
      // Emit SQL package (sqlite) to stdout; accepts md path
      .option("-m, --md <mdPath:string>", "Use the given Markdown source", {
        required: true,
      })
      // Emit SQL package (sqlite) to stdout; accepts md path
      .option(
        "-p, --package",
        "Emit SQL package (sqlite) to stdout from the given markdown path.",
      )
      // Materialize files to a target directory
      .option(
        "--fs <srcHome:string>",
        "Materialize SQL files under this directory.",
      )
      // Write sqlpage.json to the given path
      .option(
        "-c, --conf <confPath:string>",
        "Write sqlpage.json to this path (generated from frontmatter sqlpage-conf).",
      )
      // Allow positional mdPath (useful with --fs/--conf)
      .action(async (opts) => {
        async function* sources() {
          yield {
            identifier: "prime",
            markdown: await Deno.readTextFile(opts.md),
          };
        }
        const b = this.builder ?? SqlPageContentBuilder.typical<FM, M>();
        const content = b.build(sources());

        // If --fs is present, materialize files under that root
        if (typeof opts.fs === "string" && opts.fs.length > 0) {
          const mat = new SqlPageMaterializer<FM, M>(content, {});
          const { emitted } = await mat.materializeFs(opts.fs);
          await Deno.stderr.write(
            enc.encode(`Wrote ${emitted.length} files under ${opts.fs}\n`),
          );
        }

        // If -p/--package is present (i.e., user requested SQL package), emit to stdout
        if (opts.package) {
          const mat = new SqlPageMaterializer<FM, M>(content, {});
          for await (const chunk of mat.emitSqlPackage("sqlite", true)) {
            console.log(chunk);
          }
        }

        // If --conf is present, write sqlpage.json
        const fm = content.frontmatters.at(0)?.fm;
        if (typeof opts.conf === "string" && opts.conf.length > 0 && fm) {
          const json = content.sqlPageConf(fm);
          const dest = opts.conf;
          await ensureDir(dirname(dest));
          await Deno.writeTextFile(dest, JSON.stringify(json, null, 2));
        }
      })
      .command("help", new HelpCommand().global())
      .parse(argv);
  }
}

/* ------------------------------- Materializer ----------------------------- */

export interface SqlPageFileEntry {
  path: string; // relative path (e.g., "sql.d/head/001.sql", "admin/index.sql")
  contents: string; // file contents
  lastModified?: Date; // optional timestamp (not used in DML; engine time is used)
  kind?: "head_sql" | "tail_sql" | "sqlpage_file_insert";
}

// Internal convenience for attribute access inside the materializer
type AnyFence<M extends AttrMap> = SqlFenceTyped<M> & {
  attrs?: Record<string, unknown>;
  resolvedAttrs?: Record<string, unknown>;
};

// ---------- Materializer ----------
export class SqlPageMaterializer<
  FM,
  M extends AttrMap = Record<PropertyKey, never>,
> {
  // cache so we only drain SqlPageContent.SQL() once per instance
  #entriesCache?: SqlPageFileEntry[];

  constructor(
    protected readonly content: SqlPageContent<FM, M>,
    protected readonly opts: {
      padWidth?: number;
      overwrite?: boolean;
      srcHome?: string;
    } = {},
  ) {}

  /**
   * Async generator that yields the SQLPage files this content would materialize,
   * without touching the filesystem. Entries have relative paths; callers can
   * join them to a root with their own logic.
   *
   * Order is stable:
   *  - pass 1: shells/partials (their own files if path provided), then head, then tail
   *  - pass 2: pages (prepend referenced shell when present)
   *  - pass 3: unknown kinds (hook only, nothing yielded)
   */
  async *collectSqlPageFile(): AsyncGenerator<SqlPageFileEntry, void, unknown> {
    const list = await this.#getEntries();
    for (const e of list) yield e;
  }

  /**
   * Write collected files to the filesystem under the given root directory.
   * Returns absolute paths for all written files.
   */
  async materializeFs(srcHome: string) {
    const overwrite = this.opts.overwrite ?? true;
    const emitted: string[] = [];
    for await (const f of this.collectSqlPageFile()) {
      const absPath = pathJoin(srcHome, f.path);
      await ensureDir(dirname(absPath));
      const exists = await this.exists(absPath);
      if (exists && !overwrite) continue;
      await Deno.writeTextFile(
        absPath,
        f.contents.endsWith("\n") ? f.contents : f.contents + "\n",
      );
      emitted.push(absPath);
    }
    return { emitted };
  }

  /**
   * Build DML statements to upsert files into a SQLPage virtual-files table.
   * dialect "sqlite":
   *   INSERT INTO sqlpage_files (path, contents, last_modified) VALUES ('…','…', CURRENT_TIMESTAMP)
   *   ON CONFLICT(path) DO UPDATE
   *     SET contents = excluded.contents,
   *         last_modified = CURRENT_TIMESTAMP
   *     WHERE sqlpage_files.contents <> excluded.contents;
   *
   * Returns one object per file, tagged with kind: "sqlpage_file_insert".
   * On conflict when contents differ, last_modified is set by the SQL engine (CURRENT_TIMESTAMP).
   * If contents are identical, the row is left unchanged.
   */
  // 1) Ensure upserts include tails by ordering the batch
  async emitSqlPageFilesUpsertDML(dialect: "sqlite") {
    if (dialect !== "sqlite") {
      throw new Error(`Unsupported dialect: ${dialect}`);
    }

    const esc = (s: string) => s.replace(/'/g, "''");
    const outs: Array<
      { kind: "sqlpage_file_insert"; path: string; statement: string }
    > = [];

    const list = await this.#getEntries();

    // Classifiers tolerate missing 'kind' by falling back to path prefix.
    const isHead = (e: SqlPageFileEntry) =>
      e.kind === "head_sql" || e.path.startsWith("sql.d/head/");
    const isTail = (e: SqlPageFileEntry) =>
      e.kind === "tail_sql" || e.path.startsWith("sql.d/tail/");

    // Deterministic order: heads → non-head/tail → tails
    const ordered = [
      ...list.filter(isHead),
      ...list.filter((e) => !isHead(e) && !isTail(e)), // pages, shells, partials, etc.
      ...list.filter(isTail),
    ];

    for (const f of ordered) {
      const pathLit = `'${esc(f.path)}'`;
      const bodyLit = `'${esc(f.contents)}'`;
      const statement =
        `INSERT INTO sqlpage_files (path, contents, last_modified) VALUES (${pathLit}, ${bodyLit}, CURRENT_TIMESTAMP) ` +
        `ON CONFLICT(path) DO UPDATE SET contents = excluded.contents, last_modified = CURRENT_TIMESTAMP ` +
        `WHERE sqlpage_files.contents <> excluded.contents`;
      outs.push({ kind: "sqlpage_file_insert", path: f.path, statement });
    }

    return outs;
  }

  /**
   * Emit a self-contained SQL package:
   *   1) all HEAD SQL blocks (raw SQL strings),
   *   2) all sqlpage_files upsert DML statements,
   *   3) all TAIL SQL blocks (raw SQL strings).
   *
   * Intended for single-shot deployment flows: run heads, upsert virtual files,
   * then run tails.
   */
  // 2) Build the package from the ordered upserts so tails are present
  async *emitSqlPackage(dialect: "sqlite", includeSqlPageFilesTable = false) {
    const list = await this.#getEntries();

    if (includeSqlPageFilesTable) {
      yield `CREATE TABLE IF NOT EXISTS "sqlpage_files" ("path" VARCHAR PRIMARY KEY NOT NULL, "contents" TEXT NOT NULL, "last_modified" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP);\n`;
    }

    // (a) HEADS first
    for (const e of list) {
      if (e.kind === "head_sql") {
        yield e.contents.endsWith("\n") ? e.contents : e.contents + "\n";
      }
    }

    // (b) All upserts in deterministic order (includes tails)
    const dml = await this.emitSqlPageFilesUpsertDML(dialect);
    for (const row of dml) {
      yield row.statement.endsWith(";\n") || row.statement.endsWith(";\r\n")
        ? row.statement
        : row.statement + ";\n";
    }

    // (c) TAILS last
    for (const e of list) {
      if (e.kind === "tail_sql") {
        yield e.contents.endsWith("\n") ? e.contents : e.contents + "\n";
      }
    }
  }

  // ---------- helpers & hooks ----------

  protected asString(v: unknown) {
    return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
  }

  protected async handleUnknownKind(_f: SqlFenceTyped<M>) {
    // override to log/collect diagnostics for custom kinds
  }

  protected async exists(absFile: string) {
    try {
      const st = await Deno.stat(absFile);
      return st.isFile;
    } catch {
      return false;
    }
  }

  // Build and cache the complete list of file entries once per instance.
  async #getEntries(): Promise<SqlPageFileEntry[]> {
    if (this.#entriesCache) return this.#entriesCache;

    const pad = this.opts.padWidth ?? 3;

    // Drain once (preserve order)
    const all: AnyFence<M>[] = [];
    for await (const fence of this.content.SQL()) {
      all.push(fence as AnyFence<M>);
    }

    // Registries
    const shells = new Map<string, { code: string; path?: string }>();
    const partials = new Map<string, { code: string; path?: string }>();

    // Counters for numeric filenames
    let headIx = 0;
    let tailIx = 0;
    let pageIx = 0;

    const withNl = (s: string) => (s.endsWith("\n") ? s : s + "\n");
    const now = () => new Date();

    const out: SqlPageFileEntry[] = [];

    // ---------- PASS 1: shells/partials + head/tail ----------
    for (const f of all) {
      const attrsSafe =
        (f as { attrsSafe?: Record<string, unknown> }).attrsSafe;
      const merged = (f.resolvedAttrs ?? f.attrs ?? {}) as Record<
        string,
        unknown
      >;
      const kindVal = (attrsSafe?.kind ?? merged.kind) as unknown;
      const kind = typeof kindVal === "string" ? kindVal : undefined;

      if (kind === "shell" || kind === "partial") {
        const id = this.asString(
          (attrsSafe?.identifier ?? merged.identifier) as unknown,
        );
        const pth = this.asString((attrsSafe?.path ?? merged.path) as unknown);

        if (id) {
          const reg = { code: f.code, path: pth };
          if (kind === "shell") shells.set(id, reg);
          else partials.set(id, reg);
        }
        if (pth) {
          const outRel = pth.endsWith(".sql") ? pth : `${pth}.sql`;
          out.push({
            path: sanitizeName(outRel),
            contents: withNl(f.code),
            lastModified: now(),
          });
        }
        continue;
      }

      if (kind === "head") {
        // IMPORTANT: name from RAW attrs only (ignore section defaults)
        const rawName = this.asString(
          ((f as AnyFence<M>).attrs ?? ({} as Record<string, unknown>))
            .name as unknown,
        );
        const base = rawName ? sanitizeName(rawName) : zero(headIx++, pad);
        out.push({
          path: `sql.d/head/${base}.sql`,
          contents: withNl(f.code),
          lastModified: now(),
          kind: "head_sql",
        });
        continue;
      }

      if (kind === "tail") {
        // IMPORTANT: name from RAW attrs only (ignore section defaults)
        const rawName = this.asString(
          ((f as AnyFence<M>).attrs ?? ({} as Record<string, unknown>))
            .name as unknown,
        );
        const base = rawName ? sanitizeName(rawName) : zero(tailIx++, pad);
        out.push({
          path: `sql.d/tail/${base}.sql`,
          contents: withNl(f.code),
          lastModified: now(),
          kind: "tail_sql",
        });
        continue;
      }
    }

    // ---------- PASS 2: pages (prepend shell if referenced) ----------
    for (const f of all) {
      const attrsSafe =
        (f as { attrsSafe?: Record<string, unknown> }).attrsSafe;
      const merged = (f.resolvedAttrs ?? f.attrs ?? {}) as Record<
        string,
        unknown
      >;
      const kindVal = (attrsSafe?.kind ?? merged.kind) as unknown;
      const kind = typeof kindVal === "string" ? kindVal : undefined;

      if (kind !== "page") continue;

      const pathAttr = this.asString(
        (attrsSafe?.path ?? merged.path) as unknown,
      );
      const shellId = this.asString(
        ((attrsSafe as { shell?: unknown })?.shell ??
          (merged as { shell?: unknown })?.shell) as unknown,
      );

      const fileStem = pathAttr ? sanitizeName(pathAttr) : zero(pageIx++, pad);
      const outRel = fileStem.endsWith(".sql") ? fileStem : `${fileStem}.sql`;

      const shell = shellId ? shells.get(shellId) : undefined;
      const contents = shell ? `${shell.code}\n${f.code}` : f.code;

      out.push({
        path: outRel,
        contents: withNl(contents),
        lastModified: now(),
      });
    }

    // ---------- PASS 3: unknown kinds (hook) ----------
    for (const f of all) {
      const attrsSafe =
        (f as { attrsSafe?: Record<string, unknown> }).attrsSafe;
      const merged = (f.resolvedAttrs ?? f.attrs ?? {}) as Record<
        string,
        unknown
      >;
      const kindVal = (attrsSafe?.kind ?? merged.kind) as unknown;
      const kind = typeof kindVal === "string" ? kindVal : undefined;

      if (
        !kind ||
        (kind !== "head" &&
          kind !== "tail" &&
          kind !== "page" &&
          kind !== "shell" &&
          kind !== "partial")
      ) {
        await this.handleUnknownKind(f as SqlFenceTyped<M>);
      }
    }

    this.#entriesCache = out;
    return out;
  }
}

if (import.meta.main) {
  const cli = new SqlPageNotebookCLI();
  await cli.run();
}
