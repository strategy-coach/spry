/**
 * @module macro.ts
 *
 * Stream-first, comment-driven text macro engine with great DX.
 *
 * - Works on strings **or** streams; outputs a `ReadableStream<string>` as it processes.
 * - Delegates parsing & rendering to two tiny callbacks:
 *   - {@link IsCandidate} → detect macro candidates (inline or block begin)
 *   - {@link IsMacro} → provide a `render()` that returns replacement **lines** (no EOLs)
 * - Preserves block begin/end markers; replaces **only** inner lines.
 * - Optional **typed events** via {@link Emitter} to observe parsing and output.
 * - **Structured error handling**: `onError(err, ctx) => "abandon" | "continue"`.
 * - **Line numbers** for events/errors—set `startLine` (default: 1).
 *
 * Convenience helper {@link includeStream} composes a ready-to-use:
 * ```
 * -- #include <name> [raw-args...]
 *   ...replaced...
 * -- #includeEnd <name>
 * ```
 * You provide only `render(identity, raw)`.
 */

/* ────────────────────────────────────────────────────────────────────────── *
 * Typed event emitter (optional, minimal)
 * ────────────────────────────────────────────────────────────────────────── */

/** Minimal, strongly-typed event emitter. Tree-shakable, zero-dep. */
// deno-lint-ignore no-explicit-any
export type EventMap = Record<string, (...args: any[]) => void>;

export class Emitter<Events extends EventMap> {
    private readonly listeners: { [K in keyof Events]?: Set<Events[K]> } = {};

    /** Subscribe; returns an unsubscribe function. */
    on<K extends keyof Events>(event: K, handler: Events[K]) {
        (this.listeners[event] ??= new Set()).add(handler);
        return () => this.off(event, handler);
    }

    /** Subscribe once; auto-unsubscribes on first call. */
    once<K extends keyof Events>(event: K, handler: Events[K]) {
        const off = this.on(
            event,
            ((...a: Parameters<Events[K]>) => {
                off();
                handler(...a);
            }) as Events[K],
        );
        return off;
    }

    /** Unsubscribe. */
    off<K extends keyof Events>(event: K, handler: Events[K]) {
        this.listeners[event]?.delete(handler);
    }

    /** Emit to current subscribers (copy for safe iteration). */
    emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>) {
        const ls = this.listeners[event];
        if (!ls?.size) return;
        for (const h of Array.from(ls)) h(...args);
    }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Public macro types
 * ────────────────────────────────────────────────────────────────────────── */

export type CandidateDefn = {
    readonly directive: string;
    readonly argsText: string;
    readonly blockEnd?: (line: string) => boolean;
};

/**
 * Return shape from {@link IsCandidate}. `false` means "not a macro line".
 * - `identity`: name/handle for this macro occurrence (e.g., region label)
 * - `raw`: trailing unparsed text after your macro prefix (free-form)
 * - `blockEnd?`: presence marks a **block** macro; predicate returns true at the end line
 */
export type Candidate<C extends CandidateDefn> = false | C;

/** Return shape from {@link IsMacro}. `false` => unknown macro → original text preserved. */
export type Macro =
    | false
    | { render: () => Promise<string | string[]> | string | string[] };

/** Decide if a line starts a macro (inline or block). */
export type IsCandidate<C extends CandidateDefn, Payload> = (
    line: string,
    lineNum: number,
    payload: Payload,
) => Candidate<C> | Promise<Candidate<C>>;

/** For a detected macro (`identity`, `raw`), provide a renderer or `false` to pass-through. */
export type IsMacro<C extends CandidateDefn> = (
    identity: string,
    ctx: C,
) => Macro | Promise<Macro>;

/* ────────────────────────────────────────────────────────────────────────── *
 * Events & errors (with line numbers)
 * ────────────────────────────────────────────────────────────────────────── */

/** Events fired by {@link ReplaceStream}. Line numbers are 1-based. */
export type ReplaceStreamEvents<C extends CandidateDefn> = {
    /** Every input line as read (can be chatty). */
    line: (info: { lineWithDelim: string; lineNo: number }) => void;

    /** A candidate macro was detected on this line. */
    candidate: (
        info: {
            line: string;
            lineNo: number;
            identity: string;
            ctx: C;
            isBlock: boolean;
        },
    ) => void;

    /** Candidate found but `isMacro` returned false → passthrough. */
    unknownMacro: (
        info: { line: string; lineNo: number; identity: string; ctx: C },
    ) => void;

    /** Block began at `beginLineNo`. */
    blockStart: (
        info: {
            identity: string;
            ctx: C;
            beginLine: string;
            beginLineNo: number;
        },
    ) => void;

    /** Block replacement lines computed (anchored to begin line). */
    blockRender: (
        info: {
            identity: string;
            ctx: C;
            lines: string | string[];
            beginLineNo: number;
        },
    ) => void;

    /** Block ended at `endLineNo`. */
    blockEnd: (
        info: { identity: string; endLine: string; endLineNo: number },
    ) => void;

    /** Inline replacement computed at `lineNo`. */
    inlineRender: (
        info: {
            identity: string;
            ctx: C;
            replacedLine: string;
            lineNo: number;
            lines: string | string[];
        },
    ) => void;

    /**
     * A chunk was enqueued to the output stream.
     * - Inline anchor: original lineNo
     * - Block anchor:  beginLineNo (for begin/replacement/end)
     */
    emitChunk: (info: { chunk: string; anchorLineNo: number }) => void;

    /** An error was caught. See {@link ReplaceErrorContext}. */
    error: (err: unknown, context: ReplaceErrorContext<C>) => void;
};

/** Structured error context with precise location data. */
export type ReplaceErrorContext<C extends CandidateDefn> =
    | { phase: "candidate"; line: string; lineNo: number }
    | {
        phase: "macro";
        line: string;
        lineNo: number;
        identity: string;
        cand: C;
    }
    | {
        phase: "blockEnd";
        probeLine: string;
        probeLineNo: number;
        identity: string;
        cand: C;
    }
    | { phase: "render"; identity: string; cand: C; anchorLineNo: number }
    | {
        phase: "unterminatedBlock";
        beginLine: string;
        beginLineNo: number;
        innerCount: number;
        identity: string;
        cand: C;
    };

/**
 * Error policy hook.
 * - `"abandon"`: fail fast (default) → stream closes immediately
 * - `"continue"`: preserve original text for that occurrence and proceed
 */
export type OnError = <C extends CandidateDefn>(
    err: unknown,
    ctx: ReplaceErrorContext<C>,
) => "abandon" | "continue";

export type ProcessOverrides<C extends CandidateDefn, Payload> = Partial<{
    /** Override the candidate detector. */
    isCandidate: IsCandidate<C, Payload>;
    /** Override the macro resolver/renderer. */
    isMacro: IsMacro<C>;
    /** Force EOL for **inserted** lines; inferred from first delimiter if omitted. */
    eol: "\n" | "\r\n";
    /** Error policy hook (overrides constructor). */
    onError: OnError;
    /** Typed event emitter for observability. */
    events: Emitter<ReplaceStreamEvents<C>>;
    /** Starting 1-based line number for the first input line (default: 1). */
    startLine: number;
}>;

/* ────────────────────────────────────────────────────────────────────────── *
 * Core engine: ReplaceStream
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Stream-first macro replacer. Tiny API, predictable behavior.
 *
 * - **Inline**: the line is replaced by `render()` result.
 * - **Block**: begin/end markers are preserved; only inner lines are replaced.
 * - **Idempotent** by design if your `render()` is deterministic.
 *
 * @example
 * ```ts
 * const isCandidate: IsCandidate = (line) => {
 *   if (!line.startsWith("-- #include ")) return false;
 *   const name = line.slice("-- #include ".length).split(/\s+/,1)[0] ?? "";
 *   if (!name) return false;
 *   const raw = line.slice("-- #include ".length + name.length).trimStart();
 *   return { identity: name, raw, blockEnd: (probe) => probe.trim() === `-- #includeEnd ${name}` };
 * };
 *
 * const isMacro: IsMacro = (id, raw) => ({ render: () => [`[${id}]`, raw] });
 *
 * const engine = new ReplaceStream(isCandidate, isMacro, {
 *   onError: (err, ctx) => "continue",
 *   events: new Emitter(),
 *   startLine: 1,
 * });
 *
 * const result = await engine.processToString("-- #include libs X\nOLD\n-- #includeEnd libs\n");
 * console.log(result.after);
 * ```
 */
export class ReplaceStream<C extends CandidateDefn, Payload> {
    /**
     * @param isCandidate Decide if a line starts a macro (inline or block).
     * @param isMacro     For a detected macro, return a renderer or `false` to pass through.
     * @param opts        Optional defaults: `onError`, `events`, `startLine`.
     */
    constructor(
        private readonly isCandidate: IsCandidate<C, Payload>,
        private readonly isMacro: IsMacro<C>,
        private readonly opts?: {
            onError?: OnError;
            events?: Emitter<ReplaceStreamEvents<C>>;
            startLine?: number;
        },
    ) {}

    /**
     * Process an input (string or stream) and return a **ReadableStream<string>**
     * that emits the edited text as it’s produced.
     *
     * @example
     * ```ts
     * const rs = engine.processToStream(myString, { startLine: 10 });
     * const text = await new Response(rs).text();
     * ```
     */
    processToStream(
        input: string | ReadableStream<Uint8Array | string>,
        payload?: Payload,
        overrides?: ProcessOverrides<C, Payload>,
    ) {
        const isCandidate = overrides?.isCandidate ?? this.isCandidate;
        const isMacro = overrides?.isMacro ?? this.isMacro;
        const onError = overrides?.onError ?? this.opts?.onError ??
            ReplaceStream.defaultOnError;
        const events = overrides?.events ?? this.opts?.events;
        const startLine = overrides?.startLine ?? this.opts?.startLine ?? 1;

        const lineIter = typeof input === "string"
            ? ReplaceStream.iterateStringLines(input)
            : ReplaceStream.iterateStreamLines(input);

        const createState = () => ({
            eol: overrides?.eol as "\n" | "\r\n" | undefined,
            firstDelim: undefined as "\n" | "\r\n" | undefined,
            inBlock: false,
            identity: undefined as string | undefined,
            cand: undefined as CandidateDefn | undefined,
            beginLine: undefined as string | undefined,
            beginLineNo: 0,
            inner: [] as string[],
            blockEnd: undefined as ((l: string) => boolean) | undefined,
            curLineNo: startLine,
            nextLine: async () => await lineIter.next(),
            reset() {
                this.inBlock = false;
                this.identity = undefined;
                this.cand = undefined;
                this.beginLine = undefined;
                this.beginLineNo = 0;
                this.inner = [];
                this.blockEnd = undefined;
            },
        });
        let state: ReturnType<typeof createState> | null = null;

        return new ReadableStream<string>({
            async pull(controller) {
                if (!state) state = createState();

                while (true) {
                    // ── Block mode: consume until end marker or EOF
                    if (state.inBlock) {
                        const { value, done } = await state.nextLine();
                        if (done) {
                            const ctx: ReplaceErrorContext<C> = {
                                phase: "unterminatedBlock",
                                beginLine: state.beginLine!,
                                beginLineNo: state.beginLineNo,
                                innerCount: state.inner.length,
                                identity: state.identity!,
                                cand: state.cand! as C,
                            };
                            events?.emit(
                                "error",
                                new Error("Unterminated block"),
                                ctx,
                            );
                            const decision = onError?.(
                                new Error("Unterminated block"),
                                ctx,
                            ) ?? "abandon";
                            if (decision === "abandon") {
                                controller.close();
                                return;
                            }
                            // continue → best-effort pass-through
                            controller.enqueue(state.beginLine!);
                            events?.emit("emitChunk", {
                                chunk: state.beginLine!,
                                anchorLineNo: state.beginLineNo,
                            });
                            for (const l of state.inner) {
                                controller.enqueue(l);
                                events?.emit("emitChunk", {
                                    chunk: l,
                                    anchorLineNo: state.beginLineNo,
                                });
                            }
                            controller.close();
                            return;
                        }

                        const ln = value!;
                        events?.emit("line", {
                            lineWithDelim: ln.whole,
                            lineNo: state.curLineNo,
                        });

                        let ends = false;
                        try {
                            ends = state.blockEnd!(
                                ReplaceStream.stripDelim(ln.whole),
                            );
                        } catch (err) {
                            const ctx: ReplaceErrorContext<C> = {
                                phase: "blockEnd",
                                probeLine: ReplaceStream.stripDelim(ln.whole),
                                probeLineNo: state.curLineNo,
                                identity: state.identity!,
                                cand: state.cand! as C,
                            };
                            events?.emit("error", err, ctx);
                            const decision = onError?.(err, ctx) ?? "abandon";
                            if (decision === "abandon") {
                                controller.close();
                                return;
                            }
                            state.inner.push(ln.whole);
                            state.curLineNo++;
                            continue;
                        }

                        if (!ends) {
                            state.inner.push(ln.whole);
                            state.curLineNo++;
                            continue;
                        }

                        // Found end marker at current line
                        controller.enqueue(state.beginLine!);
                        events?.emit("emitChunk", {
                            chunk: state.beginLine!,
                            anchorLineNo: state.beginLineNo,
                        });

                        // Render and insert
                        try {
                            const m = await ReplaceStream.resolveMacro<C>(
                                isMacro,
                                state.identity!,
                                state.cand! as C,
                            );
                            if (!m) {
                                events?.emit("unknownMacro", {
                                    line: ReplaceStream.stripDelim(
                                        state.beginLine!,
                                    ),
                                    lineNo: state.beginLineNo,
                                    identity: state.identity!,
                                    ctx: state.cand! as C,
                                });
                                for (const l of state.inner) {
                                    controller.enqueue(l);
                                    events?.emit("emitChunk", {
                                        chunk: l,
                                        anchorLineNo: state.beginLineNo,
                                    });
                                }
                            } else {
                                const ins = await m.render();
                                events?.emit("blockRender", {
                                    identity: state.identity!,
                                    ctx: state.cand! as C,
                                    lines: ins,
                                    beginLineNo: state.beginLineNo,
                                });
                                const eol = state.eol ??
                                    (state.firstDelim || "\n");
                                if (ins.length) {
                                    const chunk = (typeof ins === "string"
                                        ? ins
                                        : ins.join(eol)) +
                                        ReplaceStream.ensureTrailingEol(
                                            ins[ins.length - 1],
                                            eol,
                                        );
                                    controller.enqueue(chunk);
                                    events?.emit("emitChunk", {
                                        chunk,
                                        anchorLineNo: state.beginLineNo,
                                    });
                                }
                            }
                        } catch (err) {
                            const ctx: ReplaceErrorContext<C> = {
                                phase: "render",
                                identity: state.identity!,
                                cand: state.cand! as C,
                                anchorLineNo: state.beginLineNo,
                            };
                            events?.emit("error", err, ctx);
                            const decision = onError?.(err, ctx) ?? "abandon";
                            if (decision === "abandon") {
                                controller.close();
                                return;
                            }
                            for (const l of state.inner) {
                                controller.enqueue(l);
                                events?.emit("emitChunk", {
                                    chunk: l,
                                    anchorLineNo: state.beginLineNo,
                                });
                            }
                        }

                        // Emit end marker and reset
                        controller.enqueue(ln.whole);
                        events?.emit("emitChunk", {
                            chunk: ln.whole,
                            anchorLineNo: state.beginLineNo,
                        });
                        events?.emit("blockEnd", {
                            identity: state.identity!,
                            endLine: ln.whole,
                            endLineNo: state.curLineNo,
                        });

                        state.curLineNo++; // consumed end line
                        state.reset();
                        continue;
                    }

                    // ── Normal mode: read next line
                    const { value, done } = await state.nextLine();
                    if (done) {
                        controller.close();
                        return;
                    }
                    const ln = value!;
                    events?.emit("line", {
                        lineWithDelim: ln.whole,
                        lineNo: state.curLineNo,
                    });
                    if (!state.firstDelim && ln.delim) {
                        state.firstDelim = ln.delim as "\n" | "\r\n";
                    }

                    // Candidate?
                    let cand: Candidate<C> = false;
                    try {
                        cand = await isCandidate(
                            ReplaceStream.stripDelim(ln.whole),
                            state.curLineNo,
                            payload as Payload,
                        );
                    } catch (err) {
                        const ctx: ReplaceErrorContext<C> = {
                            phase: "candidate",
                            line: ReplaceStream.stripDelim(ln.whole),
                            lineNo: state.curLineNo,
                        };
                        events?.emit("error", err, ctx);
                        const decision = onError?.(err, ctx) ?? "abandon";
                        if (decision === "abandon") {
                            controller.close();
                            return;
                        }
                        controller.enqueue(ln.whole);
                        events?.emit("emitChunk", {
                            chunk: ln.whole,
                            anchorLineNo: state.curLineNo,
                        });
                        state.curLineNo++;
                        continue;
                    }

                    if (!cand) {
                        controller.enqueue(ln.whole);
                        events?.emit("emitChunk", {
                            chunk: ln.whole,
                            anchorLineNo: state.curLineNo,
                        });
                        state.curLineNo++;
                        continue;
                    }

                    events?.emit("candidate", {
                        line: ReplaceStream.stripDelim(ln.whole),
                        lineNo: state.curLineNo,
                        identity: cand.directive,
                        ctx: cand,
                        isBlock: !!cand.blockEnd,
                    });

                    // Resolve macro
                    let m: Macro;
                    try {
                        m = await ReplaceStream.resolveMacro(
                            isMacro,
                            cand.directive,
                            cand,
                        );
                    } catch (err) {
                        const ctx: ReplaceErrorContext<C> = {
                            phase: "macro",
                            line: ReplaceStream.stripDelim(ln.whole),
                            lineNo: state.curLineNo,
                            identity: cand.directive,
                            cand,
                        };
                        events?.emit("error", err, ctx);
                        const decision = onError?.(err, ctx) ?? "abandon";
                        if (decision === "abandon") {
                            controller.close();
                            return;
                        }
                        controller.enqueue(ln.whole);
                        events?.emit("emitChunk", {
                            chunk: ln.whole,
                            anchorLineNo: state.curLineNo,
                        });
                        state.curLineNo++;
                        continue;
                    }

                    if (!m) {
                        events?.emit("unknownMacro", {
                            line: ReplaceStream.stripDelim(ln.whole),
                            lineNo: state.curLineNo,
                            identity: cand.directive,
                            ctx: cand,
                        });
                        controller.enqueue(ln.whole);
                        events?.emit("emitChunk", {
                            chunk: ln.whole,
                            anchorLineNo: state.curLineNo,
                        });
                        state.curLineNo++;
                        continue;
                    }

                    // Block begin
                    if (cand.blockEnd) {
                        state.inBlock = true;
                        state.blockEnd = cand.blockEnd;
                        state.beginLine = ln.whole;
                        state.beginLineNo = state.curLineNo;
                        state.inner = [];
                        state.identity = cand.directive;
                        state.cand = cand;
                        events?.emit("blockStart", {
                            identity: cand.directive,
                            ctx: cand,
                            beginLine: ln.whole,
                            beginLineNo: state.beginLineNo,
                        });
                        state.curLineNo++; // consumed begin line
                        continue;
                    }

                    // Inline replacement
                    try {
                        const ins = await m.render();
                        events?.emit("inlineRender", {
                            identity: cand.directive,
                            ctx: cand,
                            replacedLine: ln.whole,
                            lineNo: state.curLineNo,
                            lines: ins,
                        });
                        const eol = state.eol ?? (state.firstDelim || "\n");
                        const chunk = ins.length
                            ? (typeof ins === "string" ? ins : ins.join(eol)) +
                                (ln.delim || eol)
                            : (ln.delim || eol);
                        controller.enqueue(chunk);
                        events?.emit("emitChunk", {
                            chunk,
                            anchorLineNo: state.curLineNo,
                        });
                    } catch (err) {
                        const ctx: ReplaceErrorContext<C> = {
                            phase: "render",
                            identity: cand.directive,
                            cand,
                            anchorLineNo: state.curLineNo,
                        };
                        events?.emit("error", err, ctx);
                        const decision = onError?.(err, ctx) ?? "abandon";
                        if (decision === "abandon") {
                            controller.close();
                            return;
                        }
                        controller.enqueue(ln.whole);
                        events?.emit("emitChunk", {
                            chunk: ln.whole,
                            anchorLineNo: state.curLineNo,
                        });
                    }
                    state.curLineNo++;
                }
            },
        });
    }

    /**
     * Convenience wrapper that consumes the output stream and returns a single string.
     * If the input was a string, `before/changed` are included.
     */
    async processToString(
        input: string | ReadableStream<Uint8Array | string>,
        payload?: Payload,
        overrides?: ProcessOverrides<C, Payload>,
    ) {
        const out = this.processToStream(input, payload, overrides).getReader();
        const chunks: string[] = [];
        while (true) {
            const { value, done } = await out.read();
            if (done) break;
            chunks.push(value);
        }
        if (typeof input === "string") {
            const after = chunks.join("");
            return { before: input, after, changed: after !== input };
        }
        return { after: chunks.join("") };
    }

    /* ──────────────────────────────────────────────────────────────────────── *
   * Small static helpers (kept private for DX simplicity)
   * ──────────────────────────────────────────────────────────────────────── */

    /** Default error policy: fail fast → encourages explicit decisions. */
    static defaultOnError: OnError = () => "abandon";

    /** Strip trailing EOL delimiter from a line, if present. */
    static stripDelim(s: string) {
        if (s.endsWith("\r\n")) return s.slice(0, -2);
        if (s.endsWith("\n")) return s.slice(0, -1);
        return s;
    }

    /** Ensure a final EOL if the last inserted line lacks one. */
    static ensureTrailingEol(line: string, eol: "\n" | "\r\n") {
        return (line.endsWith("\n") || line.endsWith("\r\n")) ? "" : eol;
    }

    /** Iterate a **string** into lines, preserving delimiters (`\n`/`\r\n`). */
    static async *iterateStringLines(text: string) {
        let i = 0, start = 0;
        while (i < text.length) {
            const ch = text.charCodeAt(i);
            if (ch === 10 /* \n */) {
                const isCRLF = i > 0 && text.charCodeAt(i - 1) === 13;
                const delim = isCRLF ? "\r\n" : "\n";
                const head = isCRLF
                    ? text.slice(start, i - 1)
                    : text.slice(start, i);
                yield { whole: head + delim, delim };
                i += 1;
                start = i;
                continue;
            }
            i += 1;
        }
        if (start < text.length) {
            yield { whole: text.slice(start), delim: "" as const };
        }
    }

    /** Convert a byte/string stream into a string stream using UTF-8 for bytes. */
    static toStringStream(src: ReadableStream<Uint8Array | string>) {
        return new ReadableStream<string>({
            start(controller) {
                const reader = src.getReader();
                const dec = new TextDecoder();
                (async () => {
                    while (true) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        controller.enqueue(
                            typeof value === "string"
                                ? value
                                : dec.decode(value, { stream: true }),
                        );
                    }
                    controller.close();
                })().catch((e) => controller.error(e));
            },
        });
    }

    /** Iterate a stream into lines, preserving delimiters. */
    static async *iterateStreamLines(
        stream: ReadableStream<Uint8Array | string>,
    ) {
        const rs = ReplaceStream.toStringStream(stream);
        const reader = rs.getReader();
        let buf = "";
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += value!;
            let idx = 0;
            while (idx < buf.length) {
                const nl = buf.indexOf("\n", idx);
                if (nl === -1) break;
                const isCRLF = nl > 0 && buf.charCodeAt(nl - 1) === 13;
                const delim = isCRLF ? "\r\n" : "\n";
                const head = isCRLF
                    ? buf.slice(idx, nl - 1)
                    : buf.slice(idx, nl);
                yield { whole: head + delim, delim };
                idx = nl + 1;
            }
            buf = buf.slice(idx);
        }
        if (buf.length) yield { whole: buf, delim: "" as const };
    }

    /** Await the user-supplied macro resolver/renderer. */
    static async resolveMacro<C extends CandidateDefn>(
        fn: IsMacro<C>,
        id: string,
        ctx: C,
    ) {
        return await fn(id, ctx);
    }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Convenience: includeStream
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Compose {@link ReplaceStream} with a ready-to-use “#include” style macro.
 *
 * Defaults:
 * - Start: `"-- #include"`
 * - End:   `"-- #includeEnd <name>"`
 *
 * You provide `render(identity, raw)` → replacement lines (no EOLs).
 */
export function includeStream<C extends CandidateDefn, Payload>(
    input: string | ReadableStream<Uint8Array | string>,
    opts: {
        /** Produce replacement lines for the given region identity and raw arg tail. */
        render: (identity: string, ctx: C) => Promise<string[]> | string[];
        /** Macro start marker (default: `"-- #include"`). */
        start?: string;
        /** Macro end base (default: `"-- #includeEnd"`). Full end is `<endPrefix> <name>`. */
        endPrefix?: string;
        /** Force EOL for inserted lines (default inferred). */
        eol?: "\n" | "\r\n";
        /** Error policy (default fail-fast). */
        onError?: OnError;
        /** Typed emitter for observability. */
        events?: Emitter<ReplaceStreamEvents<C>>;
        /** Additional per-run overrides (except isCandidate/isMacro/eol/onError/events). */
        overrides?: Omit<
            ProcessOverrides<C, Payload>,
            "isCandidate" | "isMacro" | "eol" | "onError" | "events"
        >;
        /** Starting line number for input (1-based, default: 1). */
        startLine?: number;
    },
) {
    const start = opts.start ?? "-- #include";
    const endPrefix = opts.endPrefix ?? "-- #includeEnd";

    /** Detect `-- #include <name> ...` and pair with `-- #includeEnd <name>`. */
    const isCandidate: IsCandidate<C, Payload> = (line) => {
        const trimmed = line.trimStart();
        if (!trimmed.startsWith(start + " ")) return false;

        const afterStart = trimmed.slice((start + " ").length);
        const name = afterStart.split(/\s+/, 1)[0] ?? "";
        if (!name) return false;

        const raw = afterStart.slice(name.length).trimStart();
        const blockEnd = (probe: string) =>
            probe.trimStart() === `${endPrefix} ${name}`;
        return { directive: name, argsText: raw, blockEnd } as C;
    };

    /** Provide a renderer that delegates to user-supplied `render`. */
    const isMacro: IsMacro<C> = (identity, raw) => ({
        render: () => opts.render(identity, raw),
    });

    const engine = new ReplaceStream(isCandidate, isMacro, {
        onError: opts.onError,
        events: opts.events,
        startLine: opts.startLine,
    });

    return engine.processToStream(input, undefined, {
        ...(opts.overrides ?? {}),
        eol: opts.eol,
        startLine: opts.startLine,
    });
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Convenience functions
 * ────────────────────────────────────────────────────────────────────────── */

export async function streamToString(rs: ReadableStream<string>) {
    const r = rs.getReader();
    const chunks: string[] = [];
    while (true) {
        const { value, done } = await r.read();
        if (done) break;
        chunks.push(value);
    }
    return chunks.join("");
}

// macro.ts

/**
 * Parse lines shaped like:
 *   <comment><whitespace?><token><whitespace><remainder>
 *
 * Returns either:
 *   - [token, remainder, directivePrefix] if a valid token is found
 *   - false if there is no match (e.g. empty line, marker only, prefix with no token)
 *
 * Rules:
 * - If the line starts with `comment`:
 *   - Allow optional whitespace after the marker.
 *   - If the next part starts with `directivePrefix`, allow optional whitespace
 *     after the prefix as well. If no token after the prefix → return false.
 *     Otherwise: token = directive name (without prefix), remainder = rest,
 *     directivePrefix = prefix.
 *   - Otherwise, token = first word after the marker, remainder = rest, prefix = "".
 *   - If no token → return false.
 * - If the line doesn’t start with `comment`:
 *   - token = first word, remainder = rest, prefix = "".
 *   - If no token → return false.
 */
export function lineCommentDirectiveParser(
    init: { comment: string; directivePrefix: string },
) {
    const { comment, directivePrefix } = init;

    const splitFirst = (s: string): [string, string] | null => {
        if (!s) return null;
        const m = s.match(/^(\S+)(?:\s+([\s\S]+))?$/);
        if (!m) return null;
        return [m[1] ?? "", m[2] ?? ""];
    };

    return (s: string): [string, string, string] | false => {
        const trimmed = s.trim();
        if (!trimmed) return false;

        if (trimmed.startsWith(comment)) {
            // <comment><whitespace?>
            const after = trimmed.slice(comment.length).replace(/^\s+/, "");
            if (!after) return false; // marker only (or marker + spaces)

            // Optional directive prefix
            if (directivePrefix && after.startsWith(directivePrefix)) {
                const rest = after.slice(directivePrefix.length).replace(
                    /^\s+/,
                    "",
                );
                if (!rest) return false; // prefix present but no directive name
                const pair = splitFirst(rest);
                if (!pair) return false;
                const [token, remainder] = pair;
                return [token, remainder, directivePrefix];
            }

            // No directive prefix → token is the first word after the marker
            const pair = splitFirst(after);
            if (!pair) return false;
            const [token, remainder] = pair;
            return [token, remainder, ""];
        }

        // Not a comment-starting line → normal first-word split
        const pair = splitFirst(trimmed);
        if (!pair) return false;
        const [token, remainder] = pair;
        return [token, remainder, ""];
    };
}

/**
 * Split a command line string into argv using shell-like rules (POSIX-ish).
 * Useful when parsing things like `-- #include x y "z" --a -b`
 *
 * Supported behavior:
 * - Whitespace tokenization (spaces, tabs, newlines)
 * - Single quotes: take characters literally until the next single quote
 * - Double quotes: allow backslash escapes for `"`, `\`, `$`, and `` ` ``
 * - Backslash escapes outside quotes: `\x` becomes literal `x`
 * - Trailing backslash handling (treated as a literal backslash)
 * - Throws on unclosed quotes
 *
 * Not included:
 * - Variable/tilde/glob expansion
 * - Command substitution
 * - Locale or IFS-specific behavior
 * - Comments (e.g., `#`) are **not** treated specially
 *
 * Examples:
 * ```ts
 * textToShellArgv(`cmd 'a b' "c \\"d\\"" \\$HOME`)
 * // → ["cmd", "a b", 'c "d"', "$HOME"]
 *
 * textToShellArgv(`a\\ b "\\$HOME" end`)
 * // → ["a b", "$HOME", "end"]
 * ```
 */
export function textToShellArgv(input: string): string[] {
    const out: string[] = [];
    let buf: string[] = [];
    let i = 0;

    enum State {
        Normal,
        InSingle,
        InDouble,
    }
    let state: State = State.Normal;

    const pushBuf = () => {
        if (buf.length) {
            out.push(buf.join(""));
            buf = [];
        }
    };

    const esc = (ch: string) => {
        // Simple escape: \x => x (keep x literally).
        // Intentionally *not* translating \n, \t, etc. into control chars.
        return ch;
    };

    while (i < input.length) {
        const ch = input[i];

        if (state === State.Normal) {
            if (/\s/.test(ch)) {
                // Token boundary on any whitespace
                pushBuf();
                i++;
                continue;
            }
            if (ch === "'") {
                state = State.InSingle;
                i++;
                continue;
            }
            if (ch === '"') {
                state = State.InDouble;
                i++;
                continue;
            }
            if (ch === "\\") {
                i++;
                if (i >= input.length) {
                    // Trailing backslash outside quotes → literal backslash
                    buf.push("\\");
                } else {
                    buf.push(esc(input[i]));
                    i++;
                }
                continue;
            }
            buf.push(ch);
            i++;
            continue;
        }

        if (state === State.InSingle) {
            if (ch === "'") {
                state = State.Normal;
                i++;
            } else {
                buf.push(ch);
                i++;
            }
            continue;
        }

        // ...snip...
        // state === State.InDouble
        if (ch === '"') {
            state = State.Normal;
            i++;
            continue;
        }
        if (ch === "\\") {
            i++;
            if (i >= input.length) {
                // Backslash at end inside double quotes → literal backslash
                buf.push("\\");
            } else {
                const nxt = input[i];
                if (nxt === '"' || nxt === "\\" || nxt === "$" || nxt === "`") {
                    // SPECIAL CASE: If nxt is a double quote *and* it's the final char,
                    // treat the backslash as literal and let this " close the quotes.
                    if (nxt === '"' && i === input.length - 1) {
                        buf.push("\\"); // keep the backslash
                        state = State.Normal; // close the quote
                        i++; // consume the closing "
                    } else {
                        buf.push(nxt); // regular escape inside double quotes
                        i++;
                    }
                } else {
                    // Other sequences keep the backslash literally, then the char
                    buf.push("\\", nxt);
                    i++;
                }
            }
            continue;
        }
        // ...snip...
        buf.push(ch);
        i++;
    }

    if (state !== State.Normal) {
        throw new Error("Unclosed quote in input.");
    }
    pushBuf();
    return out;
}
