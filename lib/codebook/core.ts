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
 * - Produces shallow-frozen notebooks, cells, and issues to discourage mutation.
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

export type Source = string | ReadableStream<Uint8Array>;
export type SourceStream =
  | Source
  | AsyncIterable<Source>
  | AsyncIterator<Source>;

/** Now includes "lint" for enrichment/lint-stage findings. */
export type IssueDisposition = "error" | "warning" | "lint";

/** Built-in issue variants (non-generic) */
export type FrontmatterIssue = {
  kind: "frontmatter-parse";
  message: string;
  raw: unknown;
  error: unknown;
  startLine?: number;
  endLine?: number;
  disposition: IssueDisposition;
};

export type FenceAttrsIssue = {
  kind: "fence-attrs-json5-parse";
  message: string;
  metaText?: string;
  error: unknown;
  startLine?: number;
  endLine?: number;
  disposition: IssueDisposition;
};

/** Base Issue union (non-generic) */
export type Issue = FrontmatterIssue | FenceAttrsIssue;

/**
 * DX note:
 * - Juniors can just use Notebook without generics.
 * - Seniors can supply a richer issue type that extends `Issue`:
 *     type MyIssue = Issue & { origin?: string; plugin?: string };
 *     type MyNotebook = Notebook<FM, Attrs, MyIssue>;
 */
export type CodeCell<
  Attrs extends Record<string, unknown> = Record<string, unknown>,
> = {
  kind: "code";
  language: string; // fence lang or "text"
  source: string; // fence body
  attrs: Attrs; // JSON5 from fence meta {...}
  info?: string; // meta prefix before {...}
  startLine?: number;
  endLine?: number;
};

export type MarkdownCell = {
  kind: "markdown";
  markdown: string; // normalized markdown slice
  text: string; // plain text best-effort
  startLine?: number;
  endLine?: number;
};

export type Cell<
  Attrs extends Record<string, unknown> = Record<string, unknown>,
> =
  | CodeCell<Attrs>
  | MarkdownCell;

export type Notebook<
  FM extends Record<string, unknown> = Record<string, unknown>,
  Attrs extends Record<string, unknown> = Record<string, unknown>,
  I extends Issue = Issue,
> = {
  fm: FM; // {} if none/empty
  cells: Cell<Attrs>[];
  issues: I[]; // allows extended issue types that include the base Issue shape
};

/* =========================== Public API ============================== */

/** Normalize heterogeneous inputs to full-document strings. */
export async function* normalizeSources(
  input: SourceStream,
): AsyncIterable<string> {
  if (typeof input === "string") {
    yield input;
    return;
  }
  if (isReadableStream(input)) {
    yield await readStreamToText(input);
    return;
  }

  const it = isAsyncIterator(input)
    ? (input as AsyncIterator<Source>)
    : (input as AsyncIterable<Source>)[Symbol.asyncIterator]();

  while (true) {
    const { value, done } = await it.next();
    if (done) break;
    if (typeof value === "string") {
      yield value;
    } else if (isReadableStream(value)) {
      yield await readStreamToText(value);
    } else {
      throw new TypeError("Unsupported source in stream");
    }
  }
}

/**
 * Parse one or many Markdown documents into notebooks.
 * `FM` and `Attrs` are inferred; `I` allows extended issue shapes (defaults to base `Issue`).
 */
export async function* notebooks<
  FM extends Record<string, unknown> = Record<string, unknown>,
  Attrs extends Record<string, unknown> = Record<string, unknown>,
  I extends Issue = Issue,
>(input: SourceStream): AsyncGenerator<Notebook<FM, Attrs, I>> {
  for await (const text of normalizeSources(input)) {
    const nb = parseDocument<FM, Attrs, I>(text);
    yield nb;
  }
}

/* =========================== Internal Parser ========================= */

const processor = remark().use(remarkFrontmatter).use(remarkGfm).use(
  remarkStringify,
);

/** Parse a single Markdown document into a Notebook<FM, Attrs, I>. */
function parseDocument<
  FM extends Record<string, unknown>,
  Attrs extends Record<string, unknown>,
  I extends Issue,
>(source: string): Notebook<FM, Attrs, I> {
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
          const base: FrontmatterIssue = {
            kind: "frontmatter-parse",
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
      const base: FenceAttrsIssue = {
        kind: "fence-attrs-json5-parse",
        message: "Invalid JSON5 in fence attributes.",
        metaText: jsonish,
        error,
        disposition: "warning",
      };
      issues.push(base as unknown as I);
      return {} as unknown as Attrs;
    }
  };

  const cells: Cell<Attrs>[] = [];
  let sliceStart: number | null = null;

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
    const markdown = stringifyNodes(nodes);
    const text = plainTextOfNodes(nodes);
    const { start, end } = rangePos(nodes);
    const mdCell: MarkdownCell = {
      kind: "markdown",
      markdown,
      text,
      startLine: start,
      endLine: end,
    };
    cells.push(mdCell);
    sliceStart = null;
  };

  // Walk top-level children after FM
  for (let i = fmEndIdx; i < tree.children.length; i++) {
    const maybeNode = tree.children[i] as unknown;

    if (isYamlNode(maybeNode)) continue; // skip header artifacts

    const node = maybeNode as RootContent;

    if (isTopLevelDelimiter(node)) {
      flushMarkdown(i);
      sliceStart = i;
      continue;
    }

    if (isCodeNode(node)) {
      flushMarkdown(i);

      const lang = node.lang ?? "text";
      const metaRaw = typeof node.meta === "string" ? node.meta : undefined;

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

      const codeCell: CodeCell<Attrs> = {
        kind: "code",
        language: lang,
        source: String(node.value ?? ""),
        attrs,
        info,
        startLine: posStartLine(node),
        endLine: posEndLine(node),
      };
      cells.push(codeCell);
      continue;
    }

    if (sliceStart === null) sliceStart = i;
  }

  flushMarkdown(tree.children.length);
  return { fm, cells, issues } as Notebook<FM, Attrs, I>;
}

/* =========================== Tiny Runtime & Type Guards ============== */

type Pos = { line?: number };
type Position = { start?: Pos; end?: Pos };
type WithPosition = { position?: Position };

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

async function readStreamToText(rs: ReadableStream<Uint8Array>) {
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
