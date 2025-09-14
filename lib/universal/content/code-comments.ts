/**
 * code-comments.ts
 * Comment-specific functionality on top of code.ts:
 *  - In-memory scanner (line + block; nested where declared)
 *  - Streaming FSM scanner (handles cross-chunk opens/closes)
 *  - Annotation extractors (tags, kv, yaml, json, spry)
 *  - Catalog helpers + governance/payload attach
 */

import * as YAML from "jsr:@std/yaml@1";
import type { CodeFileContent, CodeGovernance, LanguageSpec } from "./code.ts";
import { openCodeFile } from "./code.ts";
import type { Content, ReadOpts } from "./core.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/* -------------------------------------------------------------------------------------------------
 * Public node & location types
 * -----------------------------------------------------------------------------------------------*/

export type SourceLocation = {
    start: { line: number; column: number };
    end: { line: number; column: number };
};

export type CommentNode = {
    kind: "line" | "block";
    text: string;
    raw: string;
    range: { start: number; end: number };
    loc?: SourceLocation;
    fence?: { open: string; close?: string };
};

/* -------------------------------------------------------------------------------------------------
 * In-memory scanner
 * -----------------------------------------------------------------------------------------------*/

export function scanComments(
    source: string,
    lang: LanguageSpec,
): CommentNode[] {
    const out: CommentNode[] = [];
    if (!source) return out;

    const lineStarts: number[] = [0];
    for (let i = 0; i < source.length; i++) {
        if (source[i] === "\n") lineStarts.push(i + 1);
    }

    const toLoc = (start: number, end: number): SourceLocation => {
        const startLine = binSearch(lineStarts, start);
        const endLine = binSearch(lineStarts, end);
        return {
            start: {
                line: startLine + 1,
                column: start - lineStarts[startLine] + 1,
            },
            end: { line: endLine + 1, column: end - lineStarts[endLine] + 1 },
        };
    };

    // Block comments
    for (const blk of lang.comment.block) {
        const { open, close, nested } = blk;
        let i = 0;
        while (i < source.length) {
            const s = source.indexOf(open, i);
            if (s < 0) break;
            if (!nested) {
                const e = source.indexOf(close, s + open.length);
                if (e < 0) break;
                const raw = source.slice(s, e + close.length);
                out.push({
                    kind: "block",
                    raw,
                    text: raw.slice(open.length, raw.length - close.length),
                    range: { start: s, end: e + close.length },
                    loc: toLoc(s, e + close.length),
                    fence: { open, close },
                });
                i = e + close.length;
            } else {
                let depth = 1;
                let pos = s + open.length;
                while (depth > 0 && pos < source.length) {
                    const nO = source.indexOf(open, pos);
                    const nC = source.indexOf(close, pos);
                    if (nC < 0 && nO < 0) break;
                    if (nO >= 0 && (nC < 0 || nO < nC)) {
                        depth++;
                        pos = nO + open.length;
                    } else {
                        depth--;
                        pos = nC + close.length;
                    }
                }
                const endPos = pos;
                const raw = source.slice(s, endPos);
                out.push({
                    kind: "block",
                    raw,
                    text: raw.slice(open.length, raw.length - close.length),
                    range: { start: s, end: endPos },
                    loc: toLoc(s, endPos),
                    fence: { open, close },
                });
                i = endPos;
            }
        }
    }

    // Line comments
    if (lang.comment.line.length > 0) {
        const prefixes = [...lang.comment.line].sort((a, b) =>
            b.length - a.length
        );
        const lines = source.split(/\r?\n/);
        let offset = 0;
        for (let li = 0; li < lines.length; li++) {
            const L = lines[li];
            const pref = prefixes.find((p) => L.trimStart().startsWith(p));
            if (pref) {
                const startCol = L.indexOf(pref, 0);
                const start = offset + startCol;
                const raw = L.slice(startCol);
                out.push({
                    kind: "line",
                    raw,
                    text: raw.slice(pref.length),
                    range: { start, end: offset + L.length },
                    loc: {
                        start: { line: li + 1, column: startCol + 1 },
                        end: { line: li + 1, column: L.length + 1 },
                    },
                    fence: { open: pref },
                });
            }
            offset += L.length + 1;
        }
    }

    out.sort((a, b) => a.range.start - b.range.start);
    return out;
}

function binSearch(starts: number[], pos: number): number {
    let lo = 0, hi = starts.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] <= pos) {
            if (mid === starts.length - 1 || starts[mid + 1] > pos) return mid;
            lo = mid + 1;
        } else hi = mid - 1;
    }
    return Math.max(0, Math.min(starts.length - 1, lo));
}

/* -------------------------------------------------------------------------------------------------
 * Streaming FSM scanner
 * -----------------------------------------------------------------------------------------------*/

export type ScanStreamOptions = {
    encoding?: string;
    maxCarry?: number;
};

export async function* iterateCommentsStream(
    rs: ReadableStream<Uint8Array>,
    lang: LanguageSpec,
    opts: ScanStreamOptions = {},
): AsyncGenerator<CommentNode> {
    const dec = new TextDecoder(opts.encoding ?? "utf-8");
    const linePrefixes = [...(lang.comment.line ?? [])].sort((a, b) =>
        b.length - a.length
    );
    const blockFences = lang.comment.block ?? [];
    const opens = blockFences.map((b) => b.open);
    const closes = blockFences.map((b) => b.close);
    const byOpen = new Map<string, { close: string; nested: boolean }>();
    for (const b of blockFences) {
        byOpen.set(b.open, { close: b.close, nested: !!b.nested });
    }

    const maxFenceLen = Math.max(
        1,
        ...opens.map((s) => s.length),
        ...closes.map((s) => s.length),
    );
    const maxCarry = opts.maxCarry ?? Math.max(1, maxFenceLen - 1);

    let baseOffset = 0, lineNum = 1, colNum = 1;
    let buf = "";
    let consumed = 0;

    type BlockCtx = {
        open: string;
        close: string;
        nested: boolean;
        depth: number;
        startAbs: number;
        startLine: number;
        startCol: number;
        raw: string[];
        inner: string[];
    };
    let block: BlockCtx | null = null;

    const reader = rs.getReader();
    const flushDec = () => {
        const tail = dec.decode();
        if (tail) buf += tail;
    };
    const commit = (n: number) => {
        const slice = buf.slice(consumed, consumed + n);
        for (let i = 0; i < slice.length; i++) {
            if (slice[i] === "\n") {
                lineNum++;
                colNum = 1;
            } else colNum++;
        }
        consumed += n;
        baseOffset += n;
    };
    const trimLeft = () => {
        const keepFrom = Math.max(consumed - maxCarry, 0);
        if (keepFrom > 0) {
            buf = buf.slice(keepFrom);
            consumed -= keepFrom;
        }
    };

    const emitLine = (
        lineStartAbs: number,
        lineText: string,
        lineStartCol: number,
    ): CommentNode | undefined => {
        if (block || linePrefixes.length === 0) return undefined;
        const trimmed = lineText.trimStart();
        const pref = linePrefixes.find((p) => trimmed.startsWith(p));
        if (!pref) return undefined;
        const leading = lineText.length - trimmed.length;
        const idx = lineText.slice(leading).indexOf(pref);
        const startCol = lineStartCol + leading + idx;
        const startAbs = lineStartAbs + leading + idx;
        const raw = lineText.slice(leading + idx);
        return {
            kind: "line",
            raw,
            text: raw.slice(pref.length),
            range: { start: startAbs, end: lineStartAbs + lineText.length },
            loc: {
                start: { line: lineNum, column: startCol },
                end: { line: lineNum, column: lineStartCol + lineText.length },
            },
            fence: { open: pref },
        };
    };

    while (true) {
        const { value, done } = await reader.read();
        if (value) buf += dec.decode(value, { stream: true });
        if (done) flushDec();

        let progressed = true;
        while (progressed) {
            progressed = false;

            if (block) {
                const tail = buf.slice(consumed);
                const idxOpen = block.nested
                    ? indexOfAny(tail, [block.open])
                    : -1;
                const idxClose = indexOfAny(tail, [block.close]);

                if (idxClose < 0 && idxOpen < 0) break;

                let action: "open" | "close";
                let iRel: number;
                if (
                    idxOpen >= 0 && block.nested &&
                    (idxClose < 0 || idxOpen < idxClose)
                ) {
                    action = "open";
                    iRel = idxOpen;
                } else {
                    action = "close";
                    iRel = idxClose;
                }

                const upto = tail.slice(0, iRel);
                block.raw.push(upto);
                block.inner.push(upto);
                commit(iRel);

                if (action === "open") {
                    block.raw.push(block.open);
                    commit(block.open.length);
                    block.depth += 1;
                } else {
                    block.raw.push(block.close);
                    commit(block.close.length);
                    block.depth -= 1;

                    if (block.depth === 0) {
                        const endAbs = baseOffset;
                        const rawStr = block.raw.join("");
                        const innerStr = rawStr.slice(
                            block.open.length,
                            rawStr.length - block.close.length,
                        );
                        yield {
                            kind: "block",
                            raw: rawStr,
                            text: innerStr,
                            range: { start: block.startAbs, end: endAbs },
                            loc: {
                                start: {
                                    line: block.startLine,
                                    column: block.startCol,
                                },
                                end: { line: lineNum, column: colNum },
                            },
                            fence: { open: block.open, close: block.close },
                        };
                        block = null;
                    }
                }
                progressed = true;
                continue;
            }

            // Complete lines
            {
                const tail = buf.slice(consumed);
                const nl = tail.indexOf("\n");
                if (nl >= 0) {
                    const lineText = tail.slice(0, nl);
                    const node = emitLine(baseOffset, lineText, colNum);
                    if (node) yield node;
                    commit(lineText.length + 1);
                    progressed = true;
                    continue;
                }
            }

            // Block open
            {
                const tail = buf.slice(consumed);
                const minLen = Math.min(
                    ...opens.map((s) => s.length).filter((n) => n > 0),
                ) || 1;
                if (tail.length >= minLen) {
                    const which = firstFence(tail, opens);
                    if (which) {
                        const { fence, index } = which;
                        const pre = tail.slice(0, index);
                        commit(pre.length);
                        const meta = blockFences.find((b) => b.open === fence)!;
                        block = {
                            open: fence,
                            close: meta.close,
                            nested: !!meta.nested,
                            depth: 1,
                            startAbs: baseOffset,
                            startLine: lineNum,
                            startCol: colNum,
                            raw: [fence],
                            inner: [],
                        };
                        commit(fence.length);
                        progressed = true;
                        continue;
                    }
                }
            }
        }

        trimLeft();
        if (done) break;
    }

    // EOF last line (no trailing newline)
    if (!block && consumed < buf.length) {
        const lineText = buf.slice(consumed);
        const node = emitLine(baseOffset, lineText, colNum);
        if (node) yield node;
        commit(lineText.length);
    }
}

export async function scanCommentsStream(
    rs: ReadableStream<Uint8Array>,
    lang: LanguageSpec,
    opts?: ScanStreamOptions,
): Promise<CommentNode[]> {
    const out: CommentNode[] = [];
    for await (const n of iterateCommentsStream(rs, lang, opts)) out.push(n);
    return out;
}

function indexOfAny(hay: string, needles: string[]): number {
    let best = -1;
    for (const n of needles) {
        const i = hay.indexOf(n);
        if (i >= 0 && (best < 0 || i < best)) best = i;
    }
    return best;
}
function firstFence(
    hay: string,
    fences: string[],
): { fence: string; index: number } | null {
    let minI = Infinity;
    let which: string | null = null;
    for (const f of fences) {
        const i = hay.indexOf(f);
        if (i >= 0 && i < minI) {
            minI = i;
            which = f;
        }
    }
    return which ? { fence: which, index: minI } : null;
}

/* -------------------------------------------------------------------------------------------------
 * Annotations (DX)
 * -----------------------------------------------------------------------------------------------*/

export type AnnotationItem<T = unknown> = {
    id: string;
    key?: string;
    kind:
        | "tag"
        | "kv"
        | "yaml"
        | "json"
        | "spry-annotation"
        | "spry-directive"
        | "spry-block";
    value?: T;
    raw: string;
    source: {
        path?: string;
        languageId: string;
        commentKind: "line" | "block";
        loc?: SourceLocation;
    };
};

export type AnnotationCatalog<T = unknown> = {
    languageId: string;
    items: AnnotationItem<T>[];
    summary?: Record<string, number>;
    meta?: Record<string, unknown>;
};

export type ExtractorConfig<T = unknown> = {
    tags?: boolean | { at?: string };
    kv?: boolean;
    yaml?: boolean;
    json?: boolean;
    spry?: {
        enabled: boolean;
        at?: string;
        bang?: string;
        blockFence?: string;
    };
    /** Return your typed value; T will be inferred from your function’s return type */
    validate?: (item: AnnotationItem<Any>) => T;
};

function stripJSDocStars(text: string): string {
    // Remove a leading '*' (and surrounding single space) from each line,
    // e.g. transforms:
    //   " * key: value" -> "key: value"
    //   "  *  - item"   -> "- item"
    // Does not touch non-block comments; we call it only for block comment bodies.
    return text
        .split(/\r?\n/)
        .map((line) => {
            const m = /^(\s*)\*(?:\s?)(.*)$/.exec(line);
            return m ? m[1] + m[2] : line;
        })
        .join("\n")
        .trim();
}

const DEFAULT_SPRY = { enabled: false, at: "@", bang: "!", blockFence: "..." };

// deno-lint-ignore require-await
export async function extractAnnotationsFromText<T = unknown>(
    text: string,
    lang: LanguageSpec,
    cfg?: ExtractorConfig<T>,
    opts?: { path?: string },
): Promise<AnnotationCatalog<T>> {
    const comments = scanComments(text, lang);
    const items: AnnotationItem[] = [];

    // normalize settings with defaults
    const tagsOn = cfg?.tags ?? true;
    const kvOn = cfg?.kv ?? true;
    const yamlOn = cfg?.yaml ?? false;
    const jsonOn = cfg?.json ?? false;
    const spryCfg = { ...DEFAULT_SPRY, ...(cfg?.spry ?? {}) };

    const atSym = typeof tagsOn === "object" ? (tagsOn.at ?? "@") : "@";

    for (const c of comments) {
        // Normalize only block comments to handle JSDoc-style leading '*'
        const bodyRaw = c.text;
        const body = c.kind === "block" ? stripJSDocStars(bodyRaw) : bodyRaw;

        // --- @tags anywhere inside the comment body ---
        if (tagsOn) {
            const tagItems = parseTags(body, atSym).map(({ key, value, raw }) =>
                makeItem("tag", key, value, raw, lang.id, c, opts?.path)
            );
            items.push(...tagItems);
        }

        if (kvOn) {
            const kvItems = parseKV(body).map(({ key, value, raw }) =>
                makeItem("kv", key, value, raw, lang.id, c, opts?.path)
            );
            items.push(...kvItems);
        }

        if (yamlOn) {
            const yamlBlocks = findYamlBlocks(body);
            for (const y of yamlBlocks) {
                try {
                    const parsed = YAML.parse(y.rawBody);
                    items.push(
                        makeItem(
                            "yaml",
                            undefined,
                            parsed,
                            y.raw,
                            lang.id,
                            c,
                            opts?.path,
                        ),
                    );
                } catch { /* ignore malformed YAML */ }
            }
        }

        if (jsonOn) {
            const jsonBlocks = findJsonBlocks(body);
            for (const j of jsonBlocks) {
                try {
                    const parsed = JSON.parse(j.rawBody);
                    items.push(
                        makeItem(
                            "json",
                            undefined,
                            parsed,
                            j.raw,
                            lang.id,
                            c,
                            opts?.path,
                        ),
                    );
                } catch { /* ignore malformed JSON */ }
            }
        }

        if (spryCfg.enabled) {
            const sItems = parseSpry(
                body,
                spryCfg.at!,
                spryCfg.bang!,
                spryCfg.blockFence!,
            ).map((it) =>
                makeItem(
                    it.kind as Any,
                    it.key,
                    it.value,
                    it.raw,
                    lang.id,
                    c,
                    opts?.path,
                )
            );
            items.push(...sItems);
        }
    }

    if (cfg?.validate) {
        const validated: AnnotationItem<T>[] = [];
        for (const it of items) {
            try {
                const val = cfg.validate(it);
                validated.push({ ...it, value: val });
            } catch {
                // drop invalid
            }
        }
        return finalizeCatalog<T>(lang.id, validated);
    }

    return finalizeCatalog<T>(lang.id, items as AnnotationItem<T>[]);
}

export async function extractAnnotations<T = unknown>(
    code: CodeFileContent,
    cfg?: ExtractorConfig<T>,
): Promise<AnnotationCatalog<T>> {
    const text = await code.readText();
    return extractAnnotationsFromText<T>(text, code.language, cfg, {
        path: code.path,
    });
}

export async function generateCodeAnnotationCatalog<T = unknown>(
    input: string | CodeFileContent,
    cfg?: ExtractorConfig<T>,
): Promise<AnnotationCatalog<T>> {
    const code = typeof input === "string" ? await openCodeFile(input) : input;
    try {
        return await extractAnnotations<T>(code, cfg);
    } finally {
        if (typeof input === "string") await code.close();
    }
}

/** Non-widening: stable generics; attaches at runtime. */
export async function annotateCodeContent<
    A,
    Prov,
    Perm,
    Tags extends readonly string[],
    G extends CodeGovernance<A, Prov, Perm, Tags>,
    P,
>(
    code: CodeFileContent<A, Prov, Perm, Tags, G, P>,
    cfg?: ExtractorConfig,
    place: "governance" | "payload" | "both" = "governance",
): Promise<CodeFileContent<A, Prov, Perm, Tags, G, P>> {
    const catalog = await extractAnnotations(code, cfg);
    const nextGov: Any = { ...(code.governance ?? {}) };
    const nextPayload: Any = { ...(code.payload ?? {}) };
    if (place === "governance" || place === "both") {
        nextGov.annotations = {
            ...(nextGov.annotations ?? {}),
            codeAnnotations: catalog,
        };
    }
    if (place === "payload" || place === "both") {
        nextPayload.codeAnnotations = catalog;
    }
    return { ...code, governance: nextGov, payload: nextPayload } as Any;
}

/* -------------------------------------------------------------------------------------------------
 * Parsers
 * -----------------------------------------------------------------------------------------------*/

function parseTags(
    text: string,
    at = "@",
): Array<{ key: string; value?: string; raw: string }> {
    const out: Array<{ key: string; value?: string; raw: string }> = [];
    const re = new RegExp(
        `(^|\\s)\\${at}([a-zA-Z0-9_.-]+)(?:\\s+([^\\s].*))?`,
        "g",
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        out.push({ key: m[2], value: m[3]?.trim(), raw: m[0].trim() });
    }
    return out;
}
function parseKV(
    text: string,
): Array<{ key: string; value: string; raw: string }> {
    const out: Array<{ key: string; value: string; raw: string }> = [];
    for (const s of text.split(/\r?\n/)) {
        const t = s.trim();
        if (!t) continue;
        const iC = t.indexOf(":"), iE = t.indexOf("=");
        const idx = (iC >= 0 && (iE < 0 || iC < iE)) ? iC : (iE >= 0 ? iE : -1);
        if (idx > 0) {
            out.push({
                key: t.slice(0, idx).trim(),
                value: t.slice(idx + 1).trim(),
                raw: t,
            });
        }
    }
    return out;
}
function findYamlBlocks(text: string): Array<{ raw: string; rawBody: string }> {
    const out: Array<{ raw: string; rawBody: string }> = [];
    let i = 0;
    while (i < text.length) {
        const s = text.indexOf("---", i);
        if (s < 0) break;
        const e = text.indexOf("---", s + 3);
        if (e < 0) break;
        const raw = text.slice(s, e + 3);
        const rawBody = text.slice(s + 3, e).replace(/^\s*\n/, "").replace(
            /\n\s*$/,
            "",
        );
        out.push({ raw, rawBody });
        i = e + 3;
    }
    return out;
}
function findJsonBlocks(text: string): Array<{ raw: string; rawBody: string }> {
    const out: Array<{ raw: string; rawBody: string }> = [];
    let i = 0;
    while (i < text.length) {
        const s = text.indexOf("{", i);
        if (s < 0) break;
        let depth = 1, pos = s + 1;
        while (depth > 0 && pos < text.length) {
            const ch = text[pos++];
            if (ch === "{") depth++;
            else if (ch === "}") depth--;
        }
        if (depth === 0) {
            const raw = text.slice(s, pos);
            out.push({ raw, rawBody: raw });
            i = pos;
        } else break;
    }
    return out;
}
function parseSpry(
    text: string,
    at = "@",
    bang = "!",
    blockFence = "...",
) {
    const out: Array<
        {
            kind: "spry-annotation" | "spry-directive" | "spry-block";
            key?: string;
            value?: unknown;
            raw: string;
        }
    > = [];
    const lines = text.split(/\r?\n/);
    const reAt = new RegExp(`^\\s*\\${at}([a-zA-Z0-9_.-]+)(?:\\s+(.*))?$`);
    const reBang = new RegExp(`^\\s*\\${bang}([a-zA-Z0-9_.-]+)(?:\\s+(.*))?$`);
    for (let i = 0; i < lines.length; i++) {
        const L = lines[i];
        const mA = reAt.exec(L);
        if (mA) {
            out.push({
                kind: "spry-annotation",
                key: mA[1],
                value: mA[2]?.trim(),
                raw: L,
            });
            continue;
        }
        const mB = reBang.exec(L);
        if (mB) {
            out.push({
                kind: "spry-directive",
                key: mB[1],
                value: mB[2]?.trim(),
                raw: L,
            });
            continue;
        }
        if (L.trim() === blockFence) {
            const body: string[] = [];
            i++;
            while (i < lines.length && lines[i].trim() !== blockFence) {
                body.push(lines[i++]);
            }
            const raw = [blockFence, ...body, blockFence].join("\n");
            out.push({ kind: "spry-block", raw, value: body.join("\n") });
        }
    }
    return out;
}

/* -------------------------------------------------------------------------------------------------
 * Catalog helpers & small DX bits
 * -----------------------------------------------------------------------------------------------*/

function makeItem(
    kind: AnnotationItem["kind"],
    key: string | undefined,
    value: unknown,
    raw: string,
    languageId: string,
    comment: CommentNode,
    path?: string,
): AnnotationItem {
    return {
        id: hashId(
            `${
                path ?? ""
            }|${languageId}|${comment.loc?.start.line}:${comment.loc?.start.column}|${raw}`,
        ),
        key,
        kind,
        value,
        raw,
        source: {
            path,
            languageId,
            commentKind: comment.kind,
            loc: comment.loc,
        },
    };
}

function finalizeCatalog<T = unknown>(
    languageId: string,
    items: AnnotationItem<T>[],
): AnnotationCatalog<T> {
    const summary: Record<string, number> = {};
    for (const it of items) {
        const k = it.key ? `${it.kind}:${it.key}` : it.kind;
        summary[k] = (summary[k] ?? 0) + 1;
    }
    return { languageId, items, summary };
}

/** Small non-cryptographic id hash (FNV-1a 32-bit). */
function hashId(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h * 0x01000193) >>> 0;
    }
    return ("00000000" + h.toString(16)).slice(-8);
}

/** Read entire code content as text (DX passthrough). */
// deno-lint-ignore require-await
export async function readAllCodeText(
    c: Pick<Content, "readText">,
    encoding?: string,
    opts?: ReadOpts,
): Promise<string> {
    return c.readText(encoding, opts);
}

/** Apply a validator (e.g., Zod.parse) to produce a typed catalog. */
export function typedCatalog<T>(
    cat: AnnotationCatalog<unknown>,
    validate: (val: unknown) => T,
): AnnotationCatalog<T> {
    return {
        ...cat,
        items: cat.items.map((it) => ({ ...it, value: validate(it.value) })),
    };
}
