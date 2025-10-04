/**
 * Minimal, unopinionated side-effect-free “Markdown Notebook” core.
 *
 * This module turns a Markdown document into a typed, iterable collection of fenced
 * code blocks with:
 *
 * - YAML frontmatter parsed via Deno std YAML and validated with a caller-supplied Zod schema.
 * - Fence attributes parsed from the code fence `meta` string using JSON5.
 * - Optional per-block “instructions” captured from surrounding Markdown, delimited by either a
 *   heading of a specific depth or a horizontal rule.
 *
 * Key pieces
 * - InstructionsDelimiter: Configure how instruction regions are detected. When kind is "heading",
 *   the specified heading depth (default 2) starts a new instruction region and the heading node
 *   itself is included in the region. When kind is "hr", a `thematicBreak` resets the region.
 * - Instructions: Shallow-frozen mdast nodes, a normalized Markdown string produced from those
 *   nodes, and a plain-text extraction for convenience.
 * - FencedBlock: A single fenced code block with language, code, optional info string, parsed
 *   JSON5 attributes, source line spans (when available), and the instruction payload that was
 *   “in effect” immediately before the fence.
 * - Notebook<FM, Ast>: Immutable product containing filename, original source, the mdast tree,
 *   parsed frontmatter (FM), and all collected blocks.
 * - MarkdownPlan<FM, Ast>: An execution-free view to iterate or filter blocks without exposing
 *   internals. ALSO includes module-level instruction regions:
 *     - moduleInstructions?: Instructions (after frontmatter, before first code fence)
 *     - moduleAppendix?: Instructions (after last code fence)
 * - NotebookBuilder: Fluent builder to load from file or string, set instruction delimiter
 *   policy, apply a Zod schema to frontmatter, and produce a NotebookContent that can be turned
 *   into a CoreMarkdownPlan.
 *
 * Frontmatter behavior
 * - Only the first YAML node at the top of the document is considered frontmatter.
 * - Parsing stops as soon as a non-yaml, non-thematicBreak, non-html, non-definition node is seen.
 * - The resulting object is validated with the provided Zod schema; validation failure throws.
 * - A minimal optional base schema, `notebookBaseFmSchema`, is provided for convenience.
 *
 * Fence attributes
 * - Attributes are read from the code fence `meta` string. If the trailing portion looks like
 *   `{ ... }`, it is parsed with JSON5; the remainder (if any) becomes the `info` string.
 * - If the entire `meta` lacks braces, it is treated as `info` only.
 * - `parseFenceAttributes()` accepts raw meta and returns a plain object or throws on parse error.
 *
 * Instruction delimiting
 * - The parser walks the top-level mdast. An “instruction buffer” collects nodes since the last
 *   delimiter. When a fenced `code` node is encountered, the current buffer is converted into an
 *   Instructions and attached to that block. Delimiters clear the buffer; a heading delimiter
 *   also contributes the heading node to the new buffer.
 *
 * Module-level regions
 * - moduleInstructions captures everything after frontmatter up to (but not including) the first
 *   fenced code block (regardless of delimiter behavior).
 * - moduleAppendix captures everything after the last fenced code block to the end of the file.
 *
 * Immutability and safety
 * - Instruction node snapshots are shallow-frozen to discourage mutation.
 * - The NotebookContent is immutable by construction.
 *
 * What this module does not do
 * - No evaluation or execution of code blocks.
 * - No filename-based inference of frontmatter or language.
 * - No plugin registry or side-effect systems; these belong in higher layers.
 *
 * Typical flow
 * 1) Choose or define a Zod schema for the document’s frontmatter.
 * 2) Load Markdown via `NotebookBuilder.fromFile()` or `.fromString()`.
 * 3) Optionally set a delimiter policy with `withInstructionsDelimiter()`.
 * 4) `build(schema)` to get a NotebookContent, then `toPlan()` for a simple iterable plan.
 *
 * @example Basic usage
 * import { z } from "jsr:@zod/zod@4";
 * import { NotebookBuilder } from "./md-notebook.ts";
 *
 * const fmSchema = z.object({
 *   project: z.string().min(1),
 * }).strict();
 *
 * const builder = new NotebookBuilder()
 *   .withInstructionsDelimiter("heading", { level: 3 });
 *
 * const nb = await builder.fromFile("example.md").build(fmSchema);
 * const plan = nb.toPlan();
 *
 * console.log(plan.filename, plan.fm, plan.count, plan.moduleInstructions?.text);
 *
 * for await (const b of plan.blocks()) {
 *   if (b.lang === "sql") {
 *     console.log("SQL block", b.index, b.attrs, b.instructions?.text);
 *   }
 * }
 *
 * const bashBlocks = plan.select(b => b.lang === "bash");
 *
 * @example Fence meta parsing
 * ```md
 * ```sql { id: 1, name: "users", dryRun: true }
 * SELECT * FROM users;
 * ```
 * ```
 * The attributes JSON5 is parsed into:
 * { id: 1, name: "users", dryRun: true }
 * and exposed as `FencedBlock.attrs`. Any leading meta text outside { ... } is exposed as `info`.
 *
 * @remarks
 * - AST is created with remark + remark-frontmatter + remark-gfm + remark-stringify.
 * - `mdast-util-to-string` is used for the instruction payload’s plain-text extraction.
 * - Line numbers for blocks depend on remark’s position data; they may be undefined if positions
 *   are unavailable.
 */

import { z } from "jsr:@zod/zod@4";
import { remark } from "npm:remark@^15";
import remarkFrontmatter from "npm:remark-frontmatter@^5";
import remarkGfm from "npm:remark-gfm@^4";
import remarkStringify from "npm:remark-stringify@^11";
import { parse as YAMLparse } from "jsr:@std/yaml@^1";
import JSON5 from "npm:json5@^2";
import { toString as mdToString } from "npm:mdast-util-to-string@^4";
import type { Root, RootContent } from "npm:@types/mdast@^4";

/* =============================== Issues ================================== */

/** Final disposition recorded on each issue (can be overridden by handler). */
export type IssueDisposition = "error" | "warning" | "lint";

/** Common location context for issues. */
export interface IssueLocation {
  readonly filename: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly blockIndex?: number;
  readonly langHint?: string;
}

/** Discriminated union of all issues we can emit. */
export type Issue =
  | ({
    kind: "frontmatter-parse";
    message: string;
    raw: unknown;
    error: unknown; // typically z.ZodError | Error | string
  } & IssueLocation)
  | ({
    kind: "fence-attrs-json5-parse";
    message: string;
    metaText: string | undefined;
    error: unknown; // Error | string
  } & IssueLocation)
  | ({
    kind: "fence-attrs-validate";
    message: string;
    lang: string;
    candidate: unknown;
    zodError: unknown; // z.ZodError when available
  } & IssueLocation)
  | ({
    kind: "instruction-defaults-parse";
    message: string;
    codeSample: string;
    error: unknown; // Error | string
  } & IssueLocation)
  | ({
    kind: "unknown-language";
    message: string;
    lang: string;
    note?: string;
  } & IssueLocation);

/** Handler can override the disposition per issue. */
export type IssueHandler =
  | ((
    issue: Issue,
  ) => IssueDisposition | void | Promise<IssueDisposition | void>)
  | undefined;

export type EmittedIssue = Issue & {
  /** Final disposition after the handler override (if any). */
  readonly disposition: IssueDisposition;
};

/* ============================ Core Types ================================= */

/** Instructions delimiter configuration */
export type InstructionsDelimiter =
  | { kind: "hr" }
  | { kind: "heading"; level?: 1 | 2 | 3 | 4 | 5 | 6 };

/** Strongly-typed instruction payload for a block or module region */
export interface Instructions {
  readonly nodes: ReadonlyArray<RootContent>; // mdast nodes (shallow frozen)
  readonly markdown: string; // normalized markdown
  readonly text: string; // plain text extraction
}

/** Base fenced code block (language-agnostic) */
export interface FencedBlockBase {
  readonly index: number;
  readonly lang: string; // e.g., "sql", "bash"
  readonly code: string; // content (post-shebang strip if enabled)
  readonly attrs: Record<string, unknown>; // raw JSON5 attrs from meta {...}
  readonly resolvedAttrs?: Record<string, unknown>; // after FM spreads/merges (if enabled)
  readonly info?: string; // meta string without trailing {...}
  readonly startLine?: number;
  readonly endLine?: number;
  readonly shebang?: string; // captured if withShebang(true)
  readonly instructions?: Instructions; // optional, from delimiter logic
}

/** Helper type: language → inferred attrs type */
export type LangAttrMap = Record<string, unknown>;

/** Typed fenced code block: narrows attrsSafe by language map M */
export type FencedBlockTyped<M extends LangAttrMap> =
  | (FencedBlockBase & {
    lang: Exclude<string, keyof M>;
    readonly attrsSafe?: undefined;
  })
  | {
    [K in keyof M & string]: FencedBlockBase & {
      lang: K;
      readonly attrsSafe?: M[K];
    };
  }[keyof M & string];

/** Minimal Notebook resource */
export interface Notebook<FM, Ast, M = LangAttrMap> {
  readonly filename: string;
  readonly source: string;
  readonly ast: Ast;
  readonly fm: FM; // Zod-validated FM (or `{}` if invalid but handler downgraded)
  readonly blocks: readonly FencedBlockTyped<M & LangAttrMap>[];

  /** Module-level regions */
  readonly moduleInstructions?: Instructions;
  readonly moduleAppendix?: Instructions;

  /** All issues captured during parsing/validation, with final dispositions. */
  readonly issues: readonly EmittedIssue[];
}

/** Plan interface (execution-free) */
export interface MarkdownPlan<FM, Ast, M = LangAttrMap> {
  readonly filename: string;
  readonly fm: FM;
  readonly count: number;

  /** Module-level regions */
  readonly moduleInstructions?: Instructions;
  readonly moduleAppendix?: Instructions;

  /** Enumerate all parsed blocks. */
  blocks(): AsyncGenerator<FencedBlockTyped<M & LangAttrMap>, void, unknown>;

  /** Filter convenience. */
  select(
    pred: (b: FencedBlockTyped<M & LangAttrMap>) => boolean,
  ): FencedBlockTyped<M & LangAttrMap>[];

  /** Retrieve issues collected during parse. */
  issues(): readonly EmittedIssue[];
}

/** Parse JSON5 attributes from code fence meta (throws on error). */
export function parseFenceAttributes(
  s: string | undefined,
): Record<string, unknown> {
  if (!s) return {};
  const trimmed = s.trim();
  const inBraces = trimmed.startsWith("{") && trimmed.endsWith("}")
    ? trimmed
    : `{${trimmed}}`;
  try {
    return JSON5.parse(inBraces);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON5 attributes in fence: ${msg}`);
  }
}

/* =========================== NotebookContent ============================= */

export class NotebookContent<Ast, FM, M = LangAttrMap>
  implements Notebook<FM, Ast, M> {
  constructor(
    public readonly filename: string,
    public readonly source: string,
    public readonly ast: Ast,
    public readonly fm: FM,
    public readonly blocks: readonly FencedBlockTyped<M & LangAttrMap>[],
    public readonly moduleInstructions: Instructions | undefined,
    public readonly moduleAppendix: Instructions | undefined,
    public readonly issues: readonly EmittedIssue[],
  ) {}
  toPlan() {
    return new TypicalMarkdownPlan<Ast, FM, M>(this);
  }
}

/* ============================== Builder ================================== */

/** Builder: parse FM, collect blocks, capture per-block instructions + optional resolution + typed attrs + issues */
export class NotebookBuilder<Ast = Root, M = Record<PropertyKey, unknown>> {
  #source?: string;
  #filename?: string;

  #delimiter: InstructionsDelimiter = { kind: "heading", level: 2 };

  // Resolution features
  #enableAttrResolution = true; // compute resolvedAttrs using FM spreads/merges
  #enableFrontmatterMirror = false; // include read-only `frontmatter` inside resolvedAttrs
  #enableShebang = false; // capture & strip first-line shebangs

  // Per-language safe attrs schema or factory
  #attrSchemas = new Map<
    string,
    z.ZodTypeAny | ((ctx: { fm: unknown; lang: string }) => z.ZodTypeAny)
  >();

  // Issues
  #issueHandler: IssueHandler;

  withInstructionsDelimiter(delimiter: InstructionsDelimiter) {
    this.#delimiter = delimiter;
    return this;
  }
  withAttrResolution(enable = true) {
    this.#enableAttrResolution = enable;
    return this;
  }
  withFrontmatterMirror(enable = true) {
    this.#enableFrontmatterMirror = enable;
    return this;
  }
  withShebang(enable = true) {
    this.#enableShebang = enable;
    return this;
  }
  withIssueHandler(handler: IssueHandler) {
    this.#issueHandler = handler;
    return this;
  }

  /**
   * Register a Zod schema (or schema factory) to validate attributes for a given language.
   * Returns a NEW builder instance with an expanded type map so that `attrsSafe` is typed
   * when `lang` matches.
   */
  withSafeAttributes<L extends string, T>(
    lang: L,
    schemaOrFactory:
      | z.ZodType<T>
      | ((ctx: { fm: unknown; lang: string }) => z.ZodType<T>),
  ): NotebookBuilder<Ast, M & { [K in L]: T }> {
    const next = new NotebookBuilder<Ast, M & { [K in L]: T }>();
    // copy state
    next.#source = this.#source;
    next.#filename = this.#filename;
    next.#delimiter = this.#delimiter;
    next.#enableAttrResolution = this.#enableAttrResolution;
    next.#enableFrontmatterMirror = this.#enableFrontmatterMirror;
    next.#enableShebang = this.#enableShebang;
    next.#issueHandler = this.#issueHandler;
    // copy schemas then add
    for (const [k, v] of this.#attrSchemas) next.#attrSchemas.set(k, v);
    next.#attrSchemas.set(lang, schemaOrFactory);
    return next;
  }

  async fromFile(path: string) {
    this.#source = await Deno.readTextFile(path);
    this.#filename = path;
    return this;
  }

  fromString(source: string, filename = "notebook.md") {
    this.#source = source;
    this.#filename = filename;
    return this;
  }

  async build<FM>(schema: z.ZodType<FM>) {
    if (!this.#source || !this.#filename) {
      throw new Error("Call fromFile()/fromString() first.");
    }
    const parsed = await parseMinimal<FM, M & LangAttrMap>(
      this.#source,
      schema,
      {
        delimiter: this.#delimiter,
        enableAttrResolution: this.#enableAttrResolution,
        enableFrontmatterMirror: this.#enableFrontmatterMirror,
        enableShebang: this.#enableShebang,
      },
      this.#attrSchemas as Map<
        string,
        z.ZodTypeAny | ((ctx: { fm: unknown; lang: string }) => z.ZodTypeAny)
      >,
      this.#filename,
      this.#issueHandler,
    );
    return new NotebookContent<Ast, FM, M>(
      this.#filename,
      this.#source,
      parsed.ast as unknown as Ast,
      parsed.fm,
      parsed.blocks,
      parsed.moduleInstructions,
      parsed.moduleAppendix,
      parsed.issues,
    );
  }
}

/* ============================ Type guards ================================ */

type WithType = { type?: unknown };
type WithValue = { value?: unknown };

function isYamlNode(n: unknown): n is { type: "yaml"; value?: string } {
  return typeof n === "object" && n !== null &&
    (n as WithType).type === "yaml";
}
function isHeadingNode(
  n: RootContent,
): n is Extract<RootContent, { type: "heading" }> {
  return n.type === "heading";
}
function isCodeNode(
  n: RootContent,
): n is Extract<RootContent, { type: "code" }> {
  return n.type === "code";
}
function isHrNode(
  n: RootContent,
): n is Extract<RootContent, { type: "thematicBreak" }> {
  return n.type === "thematicBreak";
}

/* ===================== Attr resolution helpers =========================== */

type Dict = Record<string, unknown>;

function isRecord(v: unknown): v is Dict {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function getAtPath(obj: unknown, path: string): unknown {
  if (!isRecord(obj)) return undefined;
  return path.split(".").reduce<unknown>((acc, key) => {
    if (!isRecord(acc)) return undefined;
    return (acc as Dict)[key];
  }, obj);
}
function deepMerge<A extends Dict, B extends Dict>(a: A, b: B): A & B {
  const out: Dict = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    if (isRecord(cur) && isRecord(v)) {
      out[k] = deepMerge(cur, v);
    } else {
      out[k] = v;
    }
  }
  return out as A & B;
}

function collectInstructionDefaults(
  nodes: ReadonlyArray<RootContent>,
  ctx: {
    filename: string;
    issues: EmittedIssue[];
    handler: IssueHandler | undefined;
  },
): Dict {
  let acc: Dict = {};
  for (const n of nodes) {
    if (isCodeNode(n)) {
      const meta = typeof n.meta === "string" ? n.meta : undefined;
      if (!meta) continue;

      const m = meta.match(/\{.*\}$/);
      const attrs = m
        ? safeParseFenceAttributes(
          m[0],
          {
            filename: ctx.filename,
            startLine: n.position?.start?.line,
            endLine: n.position?.end?.line,
            langHint: n.lang ?? undefined,
          },
          ctx,
        )
        : {};
      const role = isRecord(attrs) && typeof (attrs as Dict).role === "string"
        ? String((attrs as Dict).role)
        : undefined;
      if (role !== "section-defaults") continue;

      const codeText = String(n.value ?? "{}");
      try {
        const body = JSON5.parse(codeText);
        if (isRecord(body)) acc = deepMerge(acc, body);
      } catch (error) {
        emitIssue(
          {
            kind: "instruction-defaults-parse",
            message: "Failed to parse section-defaults JSON5 body.",
            codeSample: codeText.slice(0, 2000),
            error,
            filename: ctx.filename,
            startLine: n.position?.start?.line,
            endLine: n.position?.end?.line,
          },
          "warning",
          ctx,
        );
      }
    }
  }
  return acc;
}

function resolveBlockAttrs(
  rawAttrs: Dict,
  fm: Dict,
  presets: Dict | undefined,
  opts: { mirrorFM: boolean; instructionDefaults?: Dict },
): Dict {
  let acc: Dict = {};

  const presetKey = rawAttrs["$preset"];
  if (typeof presetKey === "string" && isRecord(presets)) {
    const p = presets[presetKey];
    if (isRecord(p)) acc = deepMerge(acc, p);
  }

  const spreadList = rawAttrs["$spread"];
  if (Array.isArray(spreadList)) {
    for (const p of spreadList) {
      if (typeof p !== "string") continue;
      const v = getAtPath(fm, p);
      if (isRecord(v)) acc = deepMerge(acc, v);
    }
  }

  const mergeList = rawAttrs["$merge"];
  if (Array.isArray(mergeList)) {
    for (const m of mergeList) {
      const mAsDict = isRecord(m) ? (m as Dict) : undefined;
      const fmPath = mAsDict?.["$fm"];
      if (typeof fmPath === "string") {
        const v = getAtPath(fm, fmPath);
        if (isRecord(v)) acc = deepMerge(acc, v);
      } else if (isRecord(m)) {
        acc = deepMerge(acc, m);
      }
    }
  }

  const fmPathSingle = rawAttrs["$fm"];
  if (typeof fmPathSingle === "string") {
    const v = getAtPath(fm, fmPathSingle);
    if (isRecord(v)) acc = deepMerge(acc, v);
  }

  if (opts.instructionDefaults) {
    acc = deepMerge(acc, opts.instructionDefaults);
  }

  const reserved = new Set(["$preset", "$spread", "$merge", "$fm"]);
  const rawFinal: Dict = {};
  for (const [k, v] of Object.entries(rawAttrs)) {
    if (!reserved.has(k)) rawFinal[k] = v;
  }
  acc = deepMerge(acc, rawFinal);

  if (opts.mirrorFM) {
    Object.defineProperty(acc, "frontmatter", {
      value: fm,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }

  return acc;
}

/* =========================== Issue emission ============================== */

function defaultDispositionFor(issue: Issue): IssueDisposition {
  switch (issue.kind) {
    case "frontmatter-parse":
    case "fence-attrs-validate":
      return "error";
    case "fence-attrs-json5-parse":
    case "instruction-defaults-parse":
      return "warning";
    case "unknown-language":
      return "lint";
  }
}

async function finalizeIssue(
  issue: Issue,
  handler: IssueHandler | undefined,
): Promise<EmittedIssue> {
  const base = defaultDispositionFor(issue);
  let disp = base;
  if (handler) {
    const override = await handler(issue);
    if (override === "error" || override === "warning" || override === "lint") {
      disp = override;
    }
  }
  return Object.freeze({ ...issue, disposition: disp });
}

function pushIssueSync(
  issue: Issue,
  disp: IssueDisposition,
  store: EmittedIssue[],
) {
  store.push(Object.freeze({ ...issue, disposition: disp }));
}

function emitIssue(
  issue: Issue,
  baseDisposition: IssueDisposition,
  ctx: {
    filename: string;
    issues: EmittedIssue[];
    handler: IssueHandler | undefined;
  },
) {
  // Synchronous emission; handler overrides are applied where we can await (e.g., frontmatter, zod validation)
  pushIssueSync(issue, baseDisposition, ctx.issues);
}

function safeParseFenceAttributes(
  metaText: string | undefined,
  loc: IssueLocation,
  ctx: {
    filename: string;
    issues: EmittedIssue[];
    handler: IssueHandler | undefined;
  },
): Record<string, unknown> {
  if (!metaText) return {};
  const trimmed = metaText.trim();
  const inBraces = trimmed.startsWith("{") && trimmed.endsWith("}")
    ? trimmed
    : `{${trimmed}}`;
  try {
    return JSON5.parse(inBraces);
  } catch (error) {
    emitIssue(
      {
        kind: "fence-attrs-json5-parse",
        message: "Invalid JSON5 in fence attributes.",
        metaText,
        error,
        filename: loc.filename,
        startLine: loc.startLine,
        endLine: loc.endLine,
        blockIndex: loc.blockIndex,
        langHint: loc.langHint,
      },
      "warning",
      ctx,
    );
    return {};
  }
}

/* ============================= Parse core ================================ */

interface ParseOptions {
  delimiter: InstructionsDelimiter;
  enableAttrResolution: boolean;
  enableFrontmatterMirror: boolean;
  enableShebang: boolean;
}

async function parseMinimal<FM, M extends LangAttrMap>(
  source: string,
  fmSchema: z.ZodType<FM>,
  opts: ParseOptions,
  attrSchemas: Map<
    string,
    z.ZodTypeAny | ((ctx: { fm: unknown; lang: string }) => z.ZodTypeAny)
  >,
  filename: string,
  issueHandler: IssueHandler | undefined,
) {
  const issues: EmittedIssue[] = [];
  const ctx = { filename, issues, handler: issueHandler };

  const processor = remark().use(remarkFrontmatter).use(remarkGfm).use(
    remarkStringify,
  );
  const tree = processor.parse(source) as Root;

  // Helper to build Instructions from nodes
  const mkInstructions = (nodes: RootContent[]): Instructions | undefined => {
    if (!nodes.length) return undefined;
    const root: Root = { type: "root", children: nodes };
    const markdown = String(processor.stringify(root));
    const text = nodes.map((n) => mdToString(n)).join("\n").trim();
    const frozen = nodes.map((n) => Object.freeze({ ...n })) as ReadonlyArray<
      RootContent
    >;
    return { nodes: frozen, markdown, text };
  };

  // --- Frontmatter: first yaml node only & compute FM end index
  let fmRaw: Record<string, unknown> = {};
  let fmEndIdx = 0; // index where the "header" section ends
  if (Array.isArray(tree.children)) {
    for (let i = 0; i < tree.children.length; i++) {
      const n = tree.children[i];
      if (isYamlNode(n)) {
        const raw = typeof (n as WithValue).value === "string"
          ? (n as { value: string }).value
          : "";
        fmRaw = (YAMLparse(raw) as Record<string, unknown>) ?? {};
        fmEndIdx = i + 1;
        continue;
      }
      if (
        isYamlNode(n) || isHrNode(n) || n.type === "html" ||
        n.type === "definition"
      ) {
        fmEndIdx = i + 1;
        continue;
      }
      fmEndIdx = i;
      break;
    }
    if (fmEndIdx === 0) fmEndIdx = 0;
  }

  // Validate frontmatter with issues
  let fm: FM;
  {
    const res = (fmSchema as z.ZodTypeAny).safeParse(fmRaw);
    if (res.success) {
      fm = res.data as FM;
    } else {
      const issue: Issue = {
        kind: "frontmatter-parse",
        message: "Frontmatter failed schema validation.",
        raw: fmRaw,
        error: res.error,
        filename,
      };
      const final = await finalizeIssue(issue, issueHandler);
      issues.push(final);
      if (final.disposition === "error") {
        // Preserve strong typing of fm by throwing in the error case
        throw new Error("Frontmatter validation failed.");
      } else {
        // Continue with empty fm; consumers must consult issues().
        fm = {} as FM;
      }
    }
  }

  const fmAsDict: Dict = isRecord(fm) ? (fm as Dict) : {};

  // --- Delimiter helper
  const isDelimiterNode = (node: RootContent): boolean => {
    if (opts.delimiter.kind === "heading") {
      return isHeadingNode(node) &&
        node.depth === (opts.delimiter.level ?? 2);
    }
    return isHrNode(node); // hr
  };

  // --- Collect fenced blocks and per-block instructions
  const instrBuf: RootContent[] = [];
  const blocks: FencedBlockTyped<M & LangAttrMap>[] = [];
  let idx = 0;

  // Track first and last code indices to compute module-level regions
  let firstCodeIdx: number | undefined = undefined;
  let lastCodeIdx: number | undefined = undefined;

  for (let i = 0; i < tree.children.length; i++) {
    const n = tree.children[i];

    if (isDelimiterNode(n)) {
      instrBuf.length = 0;
      if (isHeadingNode(n)) instrBuf.push(n);
      continue;
    }

    if (isCodeNode(n)) {
      if (firstCodeIdx === undefined) firstCodeIdx = i;
      lastCodeIdx = i;

      const lang: string = n.lang ?? "text";
      const metaRaw: string | undefined = typeof n.meta === "string"
        ? n.meta
        : undefined;

      let attrs: Record<string, unknown> = {};
      let info: string | undefined;
      if (metaRaw) {
        const m = metaRaw.match(/\{.*\}$/);
        if (m) {
          attrs = safeParseFenceAttributes(
            m[0],
            {
              filename,
              startLine: n.position?.start?.line,
              endLine: n.position?.end?.line,
              blockIndex: idx,
              langHint: lang,
            },
            ctx,
          );
          info = metaRaw.replace(m[0], "").trim() || undefined;
        } else {
          info = metaRaw.trim();
        }
      }

      const rawCode = String(n.value ?? "");
      let shebang: string | undefined;
      let code = rawCode;
      if (opts.enableShebang) {
        const firstLineEnd = rawCode.indexOf("\n");
        const firstLine = firstLineEnd === -1
          ? rawCode
          : rawCode.slice(0, firstLineEnd);
        if (firstLine.startsWith("#!")) {
          shebang = firstLine;
          code = firstLineEnd === -1 ? "" : rawCode.slice(firstLineEnd + 1);
        }
      }

      const instructions = mkInstructions(instrBuf);
      const instrDefaults = opts.enableAttrResolution
        ? collectInstructionDefaults(instrBuf, ctx)
        : undefined;

      let resolvedAttrs: Record<string, unknown> | undefined;
      if (opts.enableAttrResolution) {
        const presetsRaw = (fmAsDict as Dict)["presets"];
        const presets = isRecord(presetsRaw) ? (presetsRaw as Dict) : undefined;
        resolvedAttrs = resolveBlockAttrs(attrs, fmAsDict, presets, {
          mirrorFM: opts.enableFrontmatterMirror,
          instructionDefaults: instrDefaults,
        });
      }

      // per-language safe attrs (validate resolved if present, else raw)
      let attrsSafe: unknown | undefined;
      const schemaOrFactory = attrSchemas.get(lang);
      if (schemaOrFactory) {
        const schema = typeof schemaOrFactory === "function"
          ? schemaOrFactory({ fm, lang })
          : schemaOrFactory;
        const candidate: unknown = resolvedAttrs ?? attrs;
        const res = (schema as z.ZodTypeAny).safeParse(candidate);
        if (res.success) {
          attrsSafe = res.data;
        } else {
          const issue: Issue = {
            kind: "fence-attrs-validate",
            message:
              `Attributes failed schema validation for language "${lang}".`,
            lang,
            candidate,
            zodError: res.error,
            filename,
            startLine: n.position?.start?.line,
            endLine: n.position?.end?.line,
            blockIndex: idx,
            langHint: lang,
          };
          const final = await finalizeIssue(issue, issueHandler);
          issues.push(final);
          // continue without attrsSafe
        }
      } else if (lang && lang !== "text") {
        emitIssue(
          {
            kind: "unknown-language",
            message:
              `No safe-attributes schema registered for language "${lang}".`,
            lang,
            filename,
            startLine: n.position?.start?.line,
            endLine: n.position?.end?.line,
            blockIndex: idx,
            langHint: lang,
            note: "attrsSafe will be undefined; raw attrs are available.",
          },
          "lint",
          ctx,
        );
      }

      const block: FencedBlockBase = {
        index: idx++,
        lang,
        code,
        attrs,
        resolvedAttrs,
        info,
        startLine: n.position?.start?.line,
        endLine: n.position?.end?.line,
        shebang,
        instructions,
      };

      if (attrSchemas.has(lang)) {
        blocks.push(
          {
            ...(block as unknown as FencedBlockTyped<M & LangAttrMap>),
            attrsSafe,
          } as FencedBlockTyped<M & LangAttrMap>,
        );
      } else {
        blocks.push(
          {
            ...(block as unknown as FencedBlockTyped<M & LangAttrMap>),
            attrsSafe: undefined,
          } as FencedBlockTyped<M & LangAttrMap>,
        );
      }

      // Allow "section-defaults" fenced blocks to influence the *next* code fence.
      if (
        isRecord(attrs) && typeof (attrs as Dict).role === "string" &&
        String((attrs as Dict).role) === "section-defaults"
      ) {
        // Carry this fence forward in the instruction buffer so collectInstructionDefaults()
        // can parse its body (and emit issues) when the next fence is processed.
        instrBuf.push(n);
      }

      continue;
    }

    if (!isYamlNode(n)) {
      instrBuf.push(n);
    }
  }

  // --- Module-level regions
  let moduleInstructions: Instructions | undefined;
  if (firstCodeIdx !== undefined) {
    const preNodes = tree.children.slice(fmEndIdx, firstCodeIdx);
    const filtered = preNodes.filter((n): n is RootContent => !isYamlNode(n));
    moduleInstructions = mkInstructions(filtered as RootContent[]);
  }

  let moduleAppendix: Instructions | undefined;
  if (lastCodeIdx !== undefined) {
    const postNodes = tree.children.slice(lastCodeIdx + 1);
    const filtered = postNodes.filter((n): n is RootContent => !isYamlNode(n));
    moduleAppendix = mkInstructions(filtered as RootContent[]);
  } else {
    const postNodes = tree.children.slice(fmEndIdx);
    const filtered = postNodes.filter((n): n is RootContent => !isYamlNode(n));
    moduleAppendix = mkInstructions(filtered as RootContent[]);
  }

  return { ast: tree, fm, blocks, moduleInstructions, moduleAppendix, issues };
}

/* ============================= Plan class ================================ */

export class TypicalMarkdownPlan<Ast, FM, M = LangAttrMap>
  implements MarkdownPlan<FM, Ast, M> {
  constructor(private readonly nb: Notebook<FM, Ast, M>) {}

  get filename() {
    return this.nb.filename;
  }
  get fm() {
    return this.nb.fm;
  }
  get count() {
    return this.nb.blocks.length;
  }
  get moduleInstructions() {
    return this.nb.moduleInstructions;
  }
  get moduleAppendix() {
    return this.nb.moduleAppendix;
  }

  async *blocks(): AsyncGenerator<
    FencedBlockTyped<M & LangAttrMap>,
    void,
    unknown
  > {
    for (const b of this.nb.blocks) {
      yield b as FencedBlockTyped<M & LangAttrMap>;
    }
  }

  select(
    pred: (b: FencedBlockTyped<M & LangAttrMap>) => boolean,
  ): FencedBlockTyped<M & LangAttrMap>[] {
    return this.nb.blocks.filter(pred);
  }

  issues(): readonly EmittedIssue[] {
    return this.nb.issues;
  }
}
