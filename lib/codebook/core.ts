/**
 * Minimal Markdown-based Code Notebook ("codebook") core.
 *
 * - Accepts input as a string, a ReadableStream of Uint8Array, or an async
 *   iterable/iterator of those.
 * - Parses a single Markdown document into a sequence of cells while preserving
 *   order and line ranges.
 * - Treats all fenced code blocks as code cells and partitions non-fenced
 *   content into markdown cells using fixed delimiters.
 * - Recognizes YAML frontmatter only at the head of the document and parses it
 *   into a plain object.
 * - Extracts fence metadata: language, code body, and JSON5 attributes when a
 *   trailing {...} object is present in the fence meta; any leading meta text
 *   is captured as info.
 * - Defines cell boundaries using top-level heading level 2 and thematic breaks;
 *   delimiters start a new markdown cell and belong to the following slice.
 * - Emits only what is derivable from the Markdown source: frontmatter object,
 *   cells with kinds and locations, and a small set of parse issues when
 *   applicable.
 * - Stays side-effect free; does not evaluate or transform code, does not assign
 *   identifiers, and does not validate schemas.
 *
 * Non-goals:
 * - No execution, no kernel or runtime metadata, no schema validation, and no
 *   attribute resolution beyond JSON5 parsing of fence meta.
 * - No plugin system; higher layers can wrap this core to add validation,
 *   execution, or export.
 */
import { parse as YAMLparse } from "jsr:@std/yaml@^1";
import type { Root, RootContent } from "npm:@types/mdast@^4";
import JSON5 from "npm:json5@^2";
import { toString as mdToString } from "npm:mdast-util-to-string@^4";
import remarkFrontmatter from "npm:remark-frontmatter@^5";
import remarkGfm from "npm:remark-gfm@^4";
import remarkStringify from "npm:remark-stringify@^11";
import { remark } from "npm:remark@^15";

/* =========================== Public Types =========================== */

export type Source<Provenance> = {
  provenance: Provenance;
  content: string | ReadableStream<Uint8Array>;
};

export type SourceStream<Provenance> =
  | Source<Provenance>
  | AsyncIterable<Source<Provenance>>
  | AsyncIterator<Source<Provenance>>;

/** Includes "lint" for enrichment/lint-stage findings. */
export type IssueDisposition = "error" | "warning" | "lint";

/** Built-in issue variants (non-generic) */
export type FrontmatterIssue<Provenance> = {
  kind: "frontmatter-parse";
  provenance: Provenance;
  message: string;
  raw: unknown;
  error: unknown;
  startLine?: number;
  endLine?: number;
  disposition: IssueDisposition;
};

export type FenceIssue<Provenance> = {
  kind: "fence-issue";
  provenance: Provenance;
  message: string;
  metaText?: string;
  error: unknown;
  startLine?: number;
  endLine?: number;
  disposition: IssueDisposition;
};

export type FenceAttrsIssue<Provenance> = {
  kind: "fence-attrs-json5-parse";
  provenance: Provenance;
  message: string;
  metaText?: string;
  error: unknown;
  startLine?: number;
  endLine?: number;
  disposition: IssueDisposition;
};

/** Base Issue union (non-generic) */
export type Issue<Provenance> =
  | FrontmatterIssue<Provenance>
  | FenceIssue<Provenance>
  | FenceAttrsIssue<Provenance>;

/**
 * DX note:
 * - Juniors can just use Notebook without generics.
 * - Seniors can supply a richer issue type that extends `Issue`:
 *     type MyIssue = Issue & { origin?: string; plugin?: string };
 *     type MyNotebook = Notebook<FM, Attrs, MyIssue>;
 */
export type CodeCell<
  Provenance,
  Attrs extends Record<string, unknown> = Record<string, unknown>,
> = {
  kind: "code";
  provenance: Provenance;
  language: string; // fence lang or "text"
  source: string; // fence body
  attrs: Attrs; // JSON5 from fence meta {...}
  info?: string; // meta prefix before {...}
  startLine?: number;
  endLine?: number;
};

export type MarkdownCell<Provenance> = {
  kind: "markdown";
  provenance: Provenance;
  markdown: string; // normalized markdown slice
  text: string; // plain text best-effort
  startLine?: number;
  endLine?: number;
};

export type Cell<
  Provenance,
  Attrs extends Record<string, unknown> = Record<string, unknown>,
> =
  | CodeCell<Provenance, Attrs>
  | MarkdownCell<Provenance>;

/** Per-notebook, cache of top-level mdast computed during parse (no need to re-parse later). */
export type NotebookAstCache = {
  /** For each notebook cell index: markdown cells -> mdast nodes; code cells -> null */
  readonly mdastByCell: ReadonlyArray<ReadonlyArray<RootContent> | null>;
  /** All mdast nodes after frontmatter up to (not including) the first code cell */
  readonly nodesBeforeFirstCode: ReadonlyArray<RootContent>;
  /** All mdast nodes after the last code cell (appendix) */
  readonly nodesAfterLastCode: ReadonlyArray<RootContent>;
  /** Indices of code cells in `cells` */
  readonly codeCellIndices: ReadonlyArray<number>;
};

export type Notebook<
  Provenance,
  FM extends Record<string, unknown> = Record<string, unknown>,
  Attrs extends Record<string, unknown> = Record<string, unknown>,
  I extends Issue<Provenance> = Issue<Provenance>,
> = {
  fm: FM; // {} if none/empty
  cells: Cell<Provenance, Attrs>[];
  issues: I[]; // allows extended issue types that include the base Issue shape
  /** mdast cache produced by the core parser (no need to re-parse later) */
  ast: NotebookAstCache;
  provenance: Provenance;
};

/* =========================== Public API ============================== */

function isSourceObject<Provenance>(x: unknown): x is Source<Provenance> {
  return typeof x === "object" && x !== null &&
    "content" in (x as Record<string, unknown>);
}

/**
 * Normalize heterogeneous inputs of { content: string|ReadableStream } to full-document strings.
 * Note: We intentionally *do not* propagate `identity` here to keep the downstream API stable.
 * If you later want identity-aware parsing, we can thread it through a separate helper.
 */
export async function* normalizeSources<Provenance>(
  input: SourceStream<Provenance>,
): AsyncIterable<[Provenance, string]> {
  // Single Source object
  if (isSourceObject(input)) {
    const { provenance, content } = input;
    if (typeof content === "string") {
      yield [provenance, content];
      return;
    }
    throw new TypeError("Unsupported Source.content type");
  }

  // Async iterator / async iterable of Source
  const it = isAsyncIterator(input)
    ? (input as AsyncIterator<Source<Provenance>>)
    : (input as AsyncIterable<Source<Provenance>>)[Symbol.asyncIterator]();

  while (true) {
    const { value, done } = await it.next();
    if (done) break;
    if (!isSourceObject(value)) {
      throw new TypeError("Stream yielded a non-Source value");
    }
    const { provenance, content } = value;
    if (typeof content === "string") {
      yield [provenance, content];
    } else if (isReadableStream(content)) {
      yield [provenance, await readStreamToText(content)];
    } else {
      throw new TypeError("Unsupported Source.content type");
    }
  }
}

/**
 * Parse one or many Markdown documents into notebooks.
 * `FM` and `Attrs` are inferred; `I` allows extended issue shapes (defaults to base `Issue`).
 */
export async function* notebooks<
  Provenance,
  FM extends Record<string, unknown> = Record<string, unknown>,
  Attrs extends Record<string, unknown> = Record<string, unknown>,
  I extends Issue<Provenance> = Issue<Provenance>,
>(
  input: SourceStream<Provenance>,
): AsyncGenerator<Notebook<Provenance, FM, Attrs, I>> {
  for await (const [provenance, src] of normalizeSources(input)) {
    const nb = parseDocument<Provenance, FM, Attrs, I>(provenance, src);
    yield nb;
  }
}

/* =========================== Internal Parser ========================= */

const processor = remark().use(remarkFrontmatter).use(remarkGfm).use(
  remarkStringify,
);

/** Parse a single Markdown document into a Notebook<FM, Attrs, I>. */
function parseDocument<
  Provenance,
  FM extends Record<string, unknown>,
  Attrs extends Record<string, unknown>,
  I extends Issue<Provenance>,
>(provenance: Provenance, source: string) {
  type Dict = Record<string, unknown>;

  const issues: I[] = [];

  const tree = processor.parse(source) as Root;

  const { fm, fmEndIdx } = (() => {
    type FMParseResult = { fm: FM; fmEndIdx: number };
    const children = Array.isArray(tree.children)
      ? (tree.children as ReadonlyArray<unknown>)
      : [];
    let fmRaw: Dict = {};
    let fmEndIdx = 0;

    for (let i = 0; i < children.length; i++) {
      const n = children[i];

      if (isYamlNode(n)) {
        const raw = typeof n.value === "string" ? n.value : "";
        try {
          fmRaw = (YAMLparse(raw) as Dict) ?? {};
        } catch (error) {
          const base: FrontmatterIssue<Provenance> = {
            kind: "frontmatter-parse",
            provenance,
            message: "Frontmatter YAML failed to parse.",
            raw,
            error,
            startLine: posStartLine(n),
            endLine: posEndLine(n),
            disposition: "error",
          };
          issues.push(base as unknown as I);
          fmRaw = {};
        }
        fmEndIdx = i + 1;
        continue;
      }

      // Header-only constructs we skip over when scanning FM header region
      if (
        isYamlNode(n) || isHrNode(n) || isHtmlNode(n) || isDefinitionNode(n)
      ) {
        fmEndIdx = i + 1;
        continue;
      }

      fmEndIdx = i;
      break;
    }
    if (fmEndIdx === 0) fmEndIdx = 0;

    return { fm: fmRaw as FM, fmEndIdx } as FMParseResult;
  })();

  // Helpers local to this parse:

  const isTopLevelDelimiter = (n: RootContent) =>
    (n.type === "heading" && n.depth === 2) || n.type === "thematicBreak";

  const isCodeNode = (
    n: RootContent,
  ): n is Extract<RootContent, { type: "code" }> => n.type === "code";

  const stringifyNodes = (nodes: RootContent[]) => {
    const root: Root = { type: "root", children: nodes };
    return String(processor.stringify(root));
  };

  const plainTextOfNodes = (nodes: RootContent[]) =>
    nodes.map((n) => mdToString(n)).join("\n").trim();

  const rangePos = (nodes: RootContent[]) => {
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const start = posStartLine(first);
    const end = posEndLine(last);
    return { start, end };
  };

  const tryParseFenceAttrs = (metaText?: string): Attrs => {
    if (!metaText) return {} as unknown as Attrs;
    const trimmed = metaText.trim();
    const jsonish = trimmed.startsWith("{") && trimmed.endsWith("}")
      ? trimmed
      : `{${trimmed}}`;
    try {
      return JSON5.parse(jsonish) as Attrs;
    } catch (error) {
      const base: FenceAttrsIssue<Provenance> = {
        kind: "fence-attrs-json5-parse",
        provenance,
        message: "Invalid JSON5 in fence attributes.",
        metaText: jsonish,
        error,
        disposition: "warning",
      };
      issues.push(base as unknown as I);
      return {} as unknown as Attrs;
    }
  };

  const cells: Cell<Provenance, Attrs>[] = [];

  // mdast cache we’ll fill during parse
  const mdastByCell: Array<ReadonlyArray<RootContent> | null> = [];
  const codeCellIndices: number[] = [];
  const nodesBeforeFirstCode: RootContent[] = [];
  const nodesAfterLastCode: RootContent[] = [];

  // We keep only location state for markdown slices: start index in tree.children
  let sliceStart: number | null = null;
  let seenFirstCode = false;

  const flushMarkdown = (endExclusive: number) => {
    if (sliceStart === null || endExclusive <= sliceStart) {
      sliceStart = null;
      return;
    }
    const rawSlice = tree.children.slice(
      sliceStart,
      endExclusive,
    ) as ReadonlyArray<unknown>;
    const nodes = rawSlice.filter((n): n is RootContent =>
      !isYamlNode(n)
    ) as RootContent[];
    if (!nodes.length) {
      sliceStart = null;
      return;
    }

    // Record into "before first code" if we haven't seen any code yet
    if (!seenFirstCode) nodesBeforeFirstCode.push(...nodes);

    const markdown = stringifyNodes(nodes);
    const text = plainTextOfNodes(nodes);
    const { start, end } = rangePos(nodes);
    const mdCell: MarkdownCell<Provenance> = {
      kind: "markdown",
      provenance,
      markdown,
      text,
      startLine: start,
      endLine: end,
    };
    cells.push(mdCell);
    mdastByCell.push(nodes); // cache mdast for this markdown cell
    sliceStart = null;
  };

  // Walk top-level children after FM
  for (let i = fmEndIdx; i < tree.children.length; i++) {
    const maybeNode = tree.children[i] as unknown;

    // Skip YAML nodes entirely (they are header artifacts)
    if (isYamlNode(maybeNode)) {
      continue;
    }

    // We can only treat non-yaml as RootContent now.
    const node = maybeNode as RootContent;

    if (isTopLevelDelimiter(node)) {
      // delimiter splits markdown cells; delimiter itself belongs to the following slice
      flushMarkdown(i);
      sliceStart = i; // start new markdown slice at this delimiter
      continue;
    }

    if (isCodeNode(node)) {
      // close any open markdown cell before emitting a code cell
      flushMarkdown(i);

      const lang = node.lang ?? "text";
      const metaRaw = typeof node.meta === "string" ? node.meta : undefined;

      // Extract trailing {...} JSON5 as attrs; prefix (if any) as info
      let attrs = {} as Attrs;
      let info: string | undefined;
      if (metaRaw) {
        const m = metaRaw.match(/\{.*\}$/);
        if (m) {
          attrs = tryParseFenceAttrs(m[0]);
          info = metaRaw.replace(m[0], "").trim() || undefined;
        } else {
          info = metaRaw.trim();
        }
      }

      const codeCell: CodeCell<Provenance, Attrs> = {
        kind: "code",
        provenance,
        language: lang,
        source: String(node.value ?? ""),
        attrs,
        info,
        startLine: posStartLine(node),
        endLine: posEndLine(node),
      };
      cells.push(codeCell);
      mdastByCell.push(null); // code cell: no mdast nodes
      codeCellIndices.push(cells.length - 1);
      seenFirstCode = true;
      continue;
    }

    // Accumulate into current markdown slice
    if (sliceStart === null) sliceStart = i;
  }

  // Flush trailing markdown slice
  flushMarkdown(tree.children.length);

  // Compute appendix after last code cell
  if (codeCellIndices.length > 0) {
    const last = codeCellIndices[codeCellIndices.length - 1];
    for (let idx = last + 1; idx < cells.length; idx++) {
      const nodes = mdastByCell[idx];
      if (nodes) nodesAfterLastCode.push(...nodes);
    }
  }

  return {
    fm,
    cells,
    issues,
    ast: {
      mdastByCell,
      nodesBeforeFirstCode,
      nodesAfterLastCode,
      codeCellIndices,
    },
    provenance,
  } satisfies Notebook<Provenance, FM, Attrs, I>;
}

/* =========================== Instructions API ======================= */

/** Instructions delimiter configuration */
export type InstructionsDelimiter =
  | { kind: "hr" }
  | { kind: "heading"; level?: 1 | 2 | 3 | 4 | 5 | 6 };

/** Strongly-typed instruction payload for a block or module region */
export interface Instructions {
  readonly nodes: ReadonlyArray<RootContent>;
  readonly markdown: string;
  readonly text: string;
}

/** A documented code cell: base CodeCell plus optional instructions */
export type DocumentedCodeCell<
  Provenance,
  Attrs extends Record<string, unknown> = Record<string, unknown>,
> = CodeCell<Provenance, Attrs> & { readonly instructions?: Instructions };

/** Discriminated union: narrowing by `kind` gives you the right shape */
export type DocumentedCell<
  Provenance,
  Attrs extends Record<string, unknown> = Record<string, unknown>,
> = DocumentedCodeCell<Provenance, Attrs> | MarkdownCell<Provenance>;

/** Notebook annotated with header/appendix instructions and documented cells */
export type DocumentedNotebook<
  Provenance,
  FM extends Record<string, unknown>,
  Attrs extends Record<string, unknown>,
  I extends Issue<Provenance> = Issue<Provenance>,
> = {
  readonly notebook: Notebook<Provenance, FM, Attrs, I>;
  readonly cells: ReadonlyArray<DocumentedCell<Provenance, Attrs>>;
  readonly instructions?: Instructions;
  readonly appendix?: Instructions;
};

function stringifyNodesForInstr(nodes: ReadonlyArray<RootContent>): string {
  const root: Root = { type: "root", children: nodes.slice() as RootContent[] };
  return String(processor.stringify(root));
}

function textOfNodesForInstr(nodes: ReadonlyArray<RootContent>): string {
  return nodes.map((n) => mdToString(n)).join("\n").trim();
}

function mkInstructions(
  nodes: ReadonlyArray<RootContent>,
): Instructions | undefined {
  if (!nodes.length) return undefined;
  return {
    nodes,
    markdown: stringifyNodesForInstr(nodes),
    text: textOfNodesForInstr(nodes),
  };
}

function isDelimiterNode(
  n: RootContent,
  delim: InstructionsDelimiter,
): boolean {
  if (delim.kind === "hr") return n.type === "thematicBreak";
  if (n.type !== "heading") return false;
  return typeof delim.level === "number" ? n.depth === delim.level : true;
}

function isAsyncIterable<T>(
  obj: unknown,
): obj is AsyncIterable<T> {
  return (
    typeof obj === "object" &&
    obj !== null &&
    typeof (obj as { [Symbol.asyncIterator]?: () => AsyncIterator<unknown> })[
        Symbol.asyncIterator
      ] === "function"
  );
}

/**
 * documentedNotebooks
 * -------------------
 * Uses the mdast cache inside Notebook.ast to:
 * - Build notebook-level `instructions` (header) from ast.nodesBeforeFirstCode
 * - Build notebook-level `appendix`   from ast.nodesAfterLastCode
 * - Walk markdown cells (via ast.mdastByCell) with a buffer that resets at delimiters.
 *   When a code cell is hit, attach the buffered nodes as `instructions` to that cell.
 *
 * Default delimiter: heading level 2 (##).
 */
export async function* documentedNotebooks<
  Provenance,
  FM extends Record<string, unknown>,
  Attrs extends Record<string, unknown>,
  I extends Issue<Provenance> = Issue<Provenance>,
>(
  input:
    | AsyncIterable<Notebook<Provenance, FM, Attrs, I>>
    | Iterable<Notebook<Provenance, FM, Attrs, I>>,
  delimiter: InstructionsDelimiter = { kind: "heading", level: 2 },
): AsyncIterable<DocumentedNotebook<Provenance, FM, Attrs, I>> {
  const iterable: AsyncIterable<Notebook<Provenance, FM, Attrs, I>> =
    isAsyncIterable<
        Notebook<Provenance, FM, Attrs, I>
      >(input)
      ? (input as AsyncIterable<Notebook<Provenance, FM, Attrs, I>>)
      : (async function* () {
        for (const n of input as Iterable<Notebook<Provenance, FM, Attrs, I>>) {
          yield n;
        }
      })();

  for await (const nb of iterable) {
    const { mdastByCell, nodesBeforeFirstCode, nodesAfterLastCode } = nb.ast;

    // Notebook-level regions (ignore delimiters for these)
    const headerInstr = mkInstructions(nodesBeforeFirstCode);
    const appendixInstr = mkInstructions(nodesAfterLastCode);

    // Per-code-cell buffer logic over markdown cells
    const buffer: RootContent[] = [];
    const outCells: DocumentedCell<Provenance, Attrs>[] = [];

    for (let i = 0; i < nb.cells.length; i++) {
      const c = nb.cells[i] as unknown as Cell<Provenance, Attrs>;
      const nodes = mdastByCell[i]; // null for code, mdast[] for markdown

      if (nodes) {
        // markdown cell -> feed nodes into buffer with delimiter behavior
        for (const n of nodes) {
          if (isDelimiterNode(n, delimiter)) {
            buffer.length = 0; // clear
            if (delimiter.kind === "heading" && n.type === "heading") {
              buffer.push(n); // seed with heading
            }
            continue;
          }
          buffer.push(n);
        }
        outCells.push(c); // unchanged markdown cell
        continue;
      }

      // code cell -> attach current buffer (if any), then clear
      const instr = mkInstructions(buffer);
      const docCell: DocumentedCell<Provenance, Attrs> =
        c.kind === "code" && instr ? { ...c, instructions: instr } : c;
      outCells.push(docCell);
      buffer.length = 0;
    }

    yield {
      notebook: nb,
      cells: outCells,
      instructions: headerInstr,
      appendix: appendixInstr,
    };
  }
}

/* =========================== Tiny Runtime & Type Guards ============== */

/** mdast position helper shapes (kept local, no `any`) */
type Pos = { line?: number };
type Position = { start?: Pos; end?: Pos };
type WithPosition = { position?: Position };

/** Treat unknown node shapes safely */
type YamlNode = { type: "yaml"; value?: string } & WithPosition;
type HrNode = { type: "thematicBreak" } & WithPosition;
type HtmlNode = { type: "html" } & WithPosition;
type DefinitionNode = { type: "definition" } & WithPosition;

function hasType(x: unknown): x is { type?: unknown } {
  return typeof x === "object" && x !== null &&
    "type" in (x as Record<string, unknown>);
}

function isYamlNode(n: unknown): n is YamlNode {
  return hasType(n) && (n as { type?: unknown }).type === "yaml";
}

function isHrNode(n: unknown): n is HrNode {
  return hasType(n) && (n as { type?: unknown }).type === "thematicBreak";
}

function isHtmlNode(n: unknown): n is HtmlNode {
  return hasType(n) && (n as { type?: unknown }).type === "html";
}

function isDefinitionNode(n: unknown): n is DefinitionNode {
  return hasType(n) && (n as { type?: unknown }).type === "definition";
}

function posStartLine(n: unknown): number | undefined {
  const p = (n as WithPosition | undefined)?.position?.start?.line;
  return typeof p === "number" ? p : undefined;
}

function posEndLine(n: unknown): number | undefined {
  const p = (n as WithPosition | undefined)?.position?.end?.line;
  return typeof p === "number" ? p : undefined;
}

function isAsyncIterator(x: unknown): x is AsyncIterator<unknown> {
  return !!x && typeof (x as { next?: unknown }).next === "function";
}

function isReadableStream(x: unknown): x is ReadableStream<Uint8Array> {
  return typeof ReadableStream !== "undefined" && x instanceof ReadableStream;
}

async function readStreamToText(
  rs: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = rs.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}
