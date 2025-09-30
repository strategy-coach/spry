/**
 * @module macro.ts
 *
 * Stream-first, comment-driven text macro engine with great DX.
 *
 * - Works on strings **or** streams; outputs a `ReadableStream<string>` as it processes.
 * - Delegate detection to {@link IsCandidate} which returns a candidate **with render()**.
 * - Preserves block begin/end markers; replaces **only** inner lines.
 * - Optional **typed events** via {@link Emitter} to observe parsing and output.
 * - **Structured error handling**: `onError(err, ctx) => "abandon" | "continue"`.
 * - **Line numbers** for events/errors—set `startLine` (default: 1).
 * - **Payload has contentState**: { contentState: "unmodified" | "modified" } and will be set to "modified" on any successful render.
 *
 * Convenience helper {@link includeStream} composes a ready-to-use:
 * ```
 * -- #include <name> [raw-args...]
 *   ...replaced...
 * -- #includeEnd <name>
 * ```
 * You provide only `render(identity, candidate)`.
 */

// deno-lint-ignore no-explicit-any
type Any = any;

/* ────────────────────────────────────────────────────────────────────────── *
 * Minimal typed event emitter
 * ────────────────────────────────────────────────────────────────────────── */

// deno-lint-ignore no-explicit-any
export type EventMap = Record<string, (...args: any[]) => void>;

export class Emitter<Events extends EventMap> {
  private readonly listeners: { [K in keyof Events]?: Set<Events[K]> } = {};

  on<K extends keyof Events>(event: K, handler: Events[K]) {
    (this.listeners[event] ??= new Set()).add(handler);
    return () => this.off(event, handler);
  }
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
  off<K extends keyof Events>(event: K, handler: Events[K]) {
    this.listeners[event]?.delete(handler);
  }
  emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>) {
    const ls = this.listeners[event];
    if (!ls?.size) return;
    for (const h of Array.from(ls)) h(...args);
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Public macro types
 * ────────────────────────────────────────────────────────────────────────── */

export type CandidateDefn<Payload> = {
  readonly directive: string;
  readonly argsText: string;
  readonly render: (
    payload: Payload,
    curLineNo: number,
  ) =>
    | Promise<string | string[] | ReadableStream<string | Uint8Array>>
    | string
    | string[]
    | ReadableStream<string | Uint8Array>;
  readonly blockEnd?: (line: string) => boolean;
};

export type Candidate<C extends CandidateDefn<Payload>, Payload> = false | C;

export type IsCandidate<C extends CandidateDefn<Payload>, Payload> = (
  line: string,
  lineNum: number,
  payload: Payload,
) => Candidate<C, Payload> | Promise<Candidate<C, Payload>>;

/* ────────────────────────────────────────────────────────────────────────── *
 * Events & errors (line-numbered)
 * ────────────────────────────────────────────────────────────────────────── */

export type ReplaceStreamEvents<C extends CandidateDefn<Any>, Payload> = {
  line: (
    info: { lineWithDelim: string; lineNo: number; sourceLine: string },
  ) => void;

  candidate: (info: {
    line: string;
    lineNo: number;
    identity: string;
    probe: C;
    isBlock: boolean;
    payload: Payload;
  }) => void;

  blockStart: (info: {
    identity: string;
    directive: C;
    beginLine: string;
    beginLineNo: number;
    payload: Payload;
  }) => void;

  blockRender: (info: {
    identity: string;
    directive: C;
    result: string | string[] | ReadableStream<string | Uint8Array>;
    beginLineNo: number;
    endLineNo: number;
    payload: Payload;
  }) => void;

  blockEnd: (info: {
    identity: string;
    endLine: string;
    endLineNo: number;
    payload: Payload;
  }) => void;

  inlineRender: (info: {
    identity: string;
    directive: C;
    replacedLine: string;
    lineNo: number;
    result: string | string[] | ReadableStream<string | Uint8Array>;
    payload: Payload;
  }) => void;

  emitChunk: (info: { chunk: string; anchorLineNo: number }) => void;

  error: (
    err: unknown,
    context: ReplaceErrorContext<C>,
    payload: Payload,
  ) => void;
};

export type ReplaceErrorContext<C extends CandidateDefn<Any>> =
  | { phase: "candidate"; line: string; lineNo: number }
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

export type OnError<C extends CandidateDefn<Any>> = (
  err: unknown,
  ctx: ReplaceErrorContext<C>,
) => "abandon" | "continue";

export type ProcessOverrides<
  C extends CandidateDefn<Payload>,
  Payload extends { contentState: "unmodified" | "modified" },
> = Partial<{
  isCandidate: IsCandidate<C, Payload>;
  eol: "\n" | "\r\n";
  onError: OnError<C>;
  events: Emitter<ReplaceStreamEvents<C, Payload>>;
  startLine: number;
}>;

/* ────────────────────────────────────────────────────────────────────────── *
 * Core engine
 * ────────────────────────────────────────────────────────────────────────── */

export class ReplaceStream<
  C extends CandidateDefn<Payload>,
  Payload extends { contentState: "unmodified" | "modified" },
> {
  constructor(
    private readonly isCandidate: IsCandidate<C, Payload>,
    private readonly opts?: {
      onError?: OnError<C>;
      events?: Emitter<ReplaceStreamEvents<C, Payload>>;
      startLine?: number;
    },
  ) {}

  processToStream(
    input: string | ReadableStream<Uint8Array | string>,
    payload: Payload,
    overrides?: ProcessOverrides<C, Payload>,
  ) {
    const isCandidate = overrides?.isCandidate ?? this.isCandidate;
    const onError = overrides?.onError ?? this.opts?.onError ??
      ReplaceStream.defaultOnError as OnError<C>;
    const events = overrides?.events ?? this.opts?.events;
    const startLine = overrides?.startLine ?? this.opts?.startLine ?? 1;

    const lineIter = typeof input === "string"
      ? ReplaceStream.iterateStringLines(input)
      : ReplaceStream.iterateStreamLines(input);

    const markModified = () => {
      if (payload.contentState !== "modified") {
        payload.contentState = "modified";
      }
    };

    const createState = () => ({
      eol: overrides?.eol as "\n" | "\r\n" | undefined,
      firstDelim: undefined as "\n" | "\r\n" | undefined,
      inBlock: false,
      identity: undefined as string | undefined,
      cand: undefined as C | undefined,
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
          // ── Block mode
          if (state.inBlock) {
            const { value, done } = await state.nextLine();
            if (done) {
              const ctx: ReplaceErrorContext<C> = {
                phase: "unterminatedBlock",
                beginLine: state.beginLine!,
                beginLineNo: state.beginLineNo,
                innerCount: state.inner.length,
                identity: state.identity!,
                cand: state.cand!,
              };
              events?.emit(
                "error",
                new Error("Unterminated block"),
                ctx,
                payload,
              );
              const decision = onError?.(
                new Error("Unterminated block"),
                ctx,
              ) ?? "abandon";
              if (decision === "abandon") {
                controller.close();
                return;
              }
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
            const stripped = ReplaceStream.stripDelim(ln.whole);
            events?.emit("line", {
              lineWithDelim: ln.whole,
              lineNo: state.curLineNo,
              sourceLine: stripped,
            });

            let ends = false;
            try {
              ends = state.blockEnd!(stripped);
            } catch (err) {
              const ctx: ReplaceErrorContext<C> = {
                phase: "blockEnd",
                probeLine: stripped,
                probeLineNo: state.curLineNo,
                identity: state.identity!,
                cand: state.cand!,
              };
              events?.emit("error", err, ctx, payload);
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

            // Found end marker
            controller.enqueue(state.beginLine!);
            events?.emit("emitChunk", {
              chunk: state.beginLine!,
              anchorLineNo: state.beginLineNo,
            });

            try {
              const res = await state.cand!.render(
                payload,
                state.beginLineNo,
              );
              events?.emit("blockRender", {
                identity: state.identity!,
                directive: state.cand!,
                result: res,
                beginLineNo: state.beginLineNo,
                endLineNo: state.curLineNo,
                payload,
              });

              const eol = state.eol ?? (state.firstDelim || "\n");
              await ReplaceStream.pipeResultToController(
                res,
                eol,
                (chunk) => {
                  controller.enqueue(chunk);
                  events?.emit("emitChunk", {
                    chunk,
                    anchorLineNo: state?.beginLineNo ?? -1,
                  });
                },
              );
              // successful render → mark modified
              markModified();
            } catch (err) {
              const ctx: ReplaceErrorContext<C> = {
                phase: "render",
                identity: state.identity!,
                cand: state.cand!,
                anchorLineNo: state.beginLineNo,
              };
              events?.emit("error", err, ctx, payload);
              const decision = onError?.(err, ctx) ?? "abandon";
              if (decision === "abandon") {
                controller.close();
                return;
              }
              // on continue, emit original inner → do NOT mark modified
              for (const l of state.inner) {
                controller.enqueue(l);
                events?.emit("emitChunk", {
                  chunk: l,
                  anchorLineNo: state.beginLineNo,
                });
              }
            }

            controller.enqueue(ln.whole);
            events?.emit("emitChunk", {
              chunk: ln.whole,
              anchorLineNo: state.beginLineNo,
            });
            events?.emit("blockEnd", {
              identity: state.identity!,
              endLine: ln.whole,
              endLineNo: state.curLineNo,
              payload,
            });

            state.curLineNo++;
            state.reset();
            continue;
          }

          // ── Normal mode
          const { value, done } = await state.nextLine();
          if (done) {
            controller.close();
            return;
          }
          const ln = value!;
          const stripped = ReplaceStream.stripDelim(ln.whole);
          events?.emit("line", {
            lineWithDelim: ln.whole,
            lineNo: state.curLineNo,
            sourceLine: stripped,
          });
          if (!state.firstDelim && ln.delim) {
            state.firstDelim = ln.delim as "\n" | "\r\n";
          }

          let cand: Candidate<C, Payload> = false;
          try {
            cand = await isCandidate(
              stripped,
              state.curLineNo,
              payload,
            );
          } catch (err) {
            const ctx: ReplaceErrorContext<C> = {
              phase: "candidate",
              line: stripped,
              lineNo: state.curLineNo,
            };
            events?.emit("error", err, ctx, payload);
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
            line: stripped,
            lineNo: state.curLineNo,
            identity: cand.directive,
            probe: cand,
            isBlock: !!cand.blockEnd,
            payload,
          });

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
              directive: cand,
              beginLine: ln.whole,
              beginLineNo: state.beginLineNo,
              payload,
            });
            state.curLineNo++;
            continue;
          }

          // Inline
          try {
            const res = await cand.render(payload, state.curLineNo);
            events?.emit("inlineRender", {
              identity: cand.directive,
              directive: cand,
              replacedLine: ln.whole,
              lineNo: state.curLineNo,
              result: res,
              payload,
            });
            const eol = ReplaceStream.pickEol(
              ln.delim as "\n" | "\r\n" | "" | undefined,
            ) ?? (state.eol ?? (state.firstDelim || "\n"));

            await ReplaceStream.pipeResultToController(
              res,
              eol,
              (chunk) => {
                controller.enqueue(chunk);
                events?.emit("emitChunk", {
                  chunk,
                  anchorLineNo: state?.curLineNo ?? -1,
                });
              },
            );
            // successful render → mark modified
            markModified();
          } catch (err) {
            const ctx: ReplaceErrorContext<C> = {
              phase: "render",
              identity: cand.directive,
              cand,
              anchorLineNo: state.curLineNo,
            };
            events?.emit("error", err, ctx, payload);
            const decision = onError?.(err, ctx) ?? "abandon";
            if (decision === "abandon") {
              controller.close();
              return;
            }
            // on continue, emit original line → do NOT mark modified
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

  async processToString(
    input: string | ReadableStream<Uint8Array | string>,
    payload: Payload,
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
     * Small helpers
     * ──────────────────────────────────────────────────────────────────────── */

  static defaultOnError: OnError<CandidateDefn<Any>> = () => "abandon";

  static stripDelim(s: string) {
    if (s.endsWith("\r\n")) return s.slice(0, -2);
    if (s.endsWith("\n")) return s.slice(0, -1);
    return s;
  }

  static ensureTextHasTrailingEol(text: string, eol: "\n" | "\r\n") {
    return (text.endsWith("\n") || text.endsWith("\r\n")) ? text : text + eol;
  }

  static pickEol(
    delim: "\n" | "\r\n" | "" | undefined,
  ): "\n" | "\r\n" | undefined {
    if (delim === "\r\n") return "\r\n";
    if (delim === "\n") return "\n";
    return undefined;
  }

  static async *iterateStringLines(text: string) {
    let i = 0, start = 0;
    while (i < text.length) {
      const ch = text.charCodeAt(i);
      if (ch === 10 /* \n */) {
        const isCRLF = i > 0 && text.charCodeAt(i - 1) === 13;
        const delim = isCRLF ? "\r\n" : "\n";
        const head = isCRLF ? text.slice(start, i - 1) : text.slice(start, i);
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
        const head = isCRLF ? buf.slice(idx, nl - 1) : buf.slice(idx, nl);
        yield { whole: head + delim, delim };
        idx = nl + 1;
      }
      buf = buf.slice(idx);
    }
    if (buf.length) yield { whole: buf, delim: "" as const };
  }

  /**
   * Stream result directly to the controller without whole-buffer materialization.
   * Guarantees exactly one trailing EOL if the rendered output didn’t end in one.
   */
  static async pipeResultToController(
    res: string | string[] | ReadableStream<string | Uint8Array>,
    eol: "\n" | "\r\n",
    enqueue: (chunk: string) => void,
  ) {
    // string path
    if (typeof res === "string") {
      enqueue(ReplaceStream.ensureTextHasTrailingEol(res, eol));
      return;
    }
    // string[] path
    if (Array.isArray(res)) {
      const joined = res.join(eol);
      enqueue(ReplaceStream.ensureTextHasTrailingEol(joined, eol));
      return;
    }
    // ReadableStream path — pass chunks through as they come
    const reader = ReplaceStream.toStringStream(res).getReader();

    // Track last up to 2 chars to detect '\n' or '\r\n' at the end
    let tail = "";
    let sawAny = false;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value!;
      enqueue(chunk);
      sawAny = true;

      // update tail (last 2 chars)
      if (chunk.length >= 2) {
        tail = chunk.slice(-2);
      } else if (chunk.length === 1) {
        tail = (tail + chunk).slice(-2);
      }
    }

    const endsWithLF = tail.endsWith("\n");
    if (!sawAny || !endsWithLF) {
      enqueue(eol);
    }
  }

  // Legacy helper: used by processToString; streaming paths should use pipeResultToController.
  static async materializeResult(
    res: string | string[] | ReadableStream<string | Uint8Array>,
    eol: "\n" | "\r\n",
  ): Promise<string> {
    if (typeof res === "string") {
      return ReplaceStream.ensureTextHasTrailingEol(res, eol);
    }
    if (Array.isArray(res)) {
      const joined = res.join(eol);
      return ReplaceStream.ensureTextHasTrailingEol(joined, eol);
    }
    // ReadableStream → string
    const reader = ReplaceStream.toStringStream(res).getReader();
    let out = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      out += value!;
    }
    return ReplaceStream.ensureTextHasTrailingEol(out, eol);
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * includeStream convenience
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Compose {@link ReplaceStream} with a ready-to-use “#include” style macro.
 * Uses `CandidateDefn<Payload>` directly to avoid unsafe casts.
 */
export function includeStream<
  Payload extends { contentState: "unmodified" | "modified" },
>(
  input: string | ReadableStream<Uint8Array | string>,
  opts: {
    render: (
      identity: string,
      cand: CandidateDefn<Payload>,
    ) =>
      | Promise<string[] | string | ReadableStream<string | Uint8Array>>
      | string[]
      | string
      | ReadableStream<string | Uint8Array>;
    start?: string;
    endPrefix?: string;
    eol?: "\n" | "\r\n";
    onError?: OnError<CandidateDefn<Payload>>;
    events?: Emitter<ReplaceStreamEvents<CandidateDefn<Payload>, Payload>>;
    overrides?: Omit<
      ProcessOverrides<CandidateDefn<Payload>, Payload>,
      "isCandidate" | "eol" | "onError" | "events"
    >;
    startLine?: number;
  },
  payload: Payload,
) {
  const start = opts.start ?? "-- #include";
  const endPrefix = opts.endPrefix ?? "-- #includeEnd";

  const isCandidate: IsCandidate<CandidateDefn<Payload>, Payload> = (
    line,
  ) => {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith(start + " ")) return false;

    const afterStart = trimmed.slice((start + " ").length);
    const name = afterStart.split(/\s+/, 1)[0] ?? "";
    if (!name) return false;

    const raw = afterStart.slice(name.length).trimStart();
    const blockEnd = (probe: string) =>
      probe.trimStart() === `${endPrefix} ${name}`;

    const cand: CandidateDefn<Payload> = {
      directive: name,
      argsText: raw,
      blockEnd,
      render: (_payload: Payload, _curLineNo: number) =>
        opts.render(name, cand),
    };
    return cand;
  };

  const engine = new ReplaceStream<CandidateDefn<Payload>, Payload>(
    isCandidate,
    {
      onError: opts.onError,
      events: opts.events,
      startLine: opts.startLine,
    },
  );

  return engine.processToStream(input, payload, {
    ...(opts.overrides ?? {}),
    eol: opts.eol,
    startLine: opts.startLine,
  });
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Utilities
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

/**
 * Parse lines shaped like:
 *   <comment><whitespace?><token><whitespace><remainder>
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
      const after = trimmed.slice(comment.length).replace(/^\s+/, "");
      if (!after) return false;

      if (directivePrefix && after.startsWith(directivePrefix)) {
        const rest = after.slice(directivePrefix.length).replace(
          /^\s+/,
          "",
        );
        if (!rest) return false;
        const pair = splitFirst(rest);
        if (!pair) return false;
        const [token, remainder] = pair;
        return [token, remainder, directivePrefix];
      }

      const pair = splitFirst(after);
      if (!pair) return false;
      const [token, remainder] = pair;
      return [token, remainder, ""];
    }

    const pair = splitFirst(trimmed);
    if (!pair) return false;
    const [token, remainder] = pair;
    return [token, remainder, ""];
  };
}

/**
 * Split a command line string into argv (POSIX-ish).
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

  const esc = (ch: string) => ch;

  while (i < input.length) {
    const ch = input[i];

    if (state === State.Normal) {
      if (/\s/.test(ch)) {
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
        if (i >= input.length) buf.push("\\");
        else {
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

    // InDouble
    if (ch === '"') {
      state = State.Normal;
      i++;
      continue;
    }
    if (ch === "\\") {
      i++;
      if (i >= input.length) buf.push("\\");
      else {
        const nxt = input[i];
        if (nxt === '"' || nxt === "\\" || nxt === "$" || nxt === "`") {
          if (nxt === '"' && i === input.length - 1) {
            buf.push("\\");
            state = State.Normal;
            i++;
          } else {
            buf.push(nxt);
            i++;
          }
        } else {
          buf.push("\\", nxt);
          i++;
        }
      }
      continue;
    }
    buf.push(ch);
    i++;
  }

  if (state !== State.Normal) throw new Error("Unclosed quote in input.");
  pushBuf();
  return out;
}
