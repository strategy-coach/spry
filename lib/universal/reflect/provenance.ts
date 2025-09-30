/**
 * @module provenance
 *
 * Lightweight, cross-runtime (Deno/Node/Bun V8) helpers to capture **source code provenance**
 * – who called you and from where – without bringing in heavyweight dependencies.
 *
 * ## Why this exists
 * - Provide a **structured** record (`className`, `methodName`, `functionName`, `file`, `line`, `column`, `url`)
 *   instead of a brittle string.
 * - Prefer **V8 structured frames** (`Error.prepareStackTrace`) when available; fall back to
 *   parsing `Error.stack` as a string.
 * - **Never throw**: when info can’t be determined, a `reason` field is set.
 * - Works well in tests via an injectable **`stackProvider`**.
 *
 * ## Typical usage
 * ```ts
 * import { sourceCodeProvenance, provenanceComment } from "./provenance.ts";
 *
 * class Cache {
 *   get(key: string) {
 *     // Structured data for logs/telemetry:
 *     const p = sourceCodeProvenance({ importMetaURL: import.meta.url });
 *     // Quick one-liner for human-friendly logs:
 *     console.log(provenanceComment({ importMetaURL: import.meta.url }));
 *     // ...
 *   }
 * }
 * ```
 *
 * ## Notes
 * - Paths: file URLs are normalized to filesystem paths (e.g., `file:///x/y.ts` → `/x/y.ts`).
 * - Privacy: file paths reveal local structure; transform/redact `file` or `url` if needed.
 * - Deno 2.4+, strict TypeScript, no `any`, lint-friendly patterns.
 */

/**
 * Capture source code provenance as structured data.
 *
 * Prefers V8 structured frames (Node/Bun/Deno V8) and falls back to parsing `Error.stack`.
 * If you pass a `stackProvider`, it is **preferred** (useful for tests / deterministic behavior).
 *
 * @param opts.importMetaURL Typically `import.meta.url` from the call site.
 * @param opts.framesToSkip  Extra frames to skip after internal helper frames are skipped (default 0).
 * @param opts.maxDepth      Max frames to consider when parsing string stacks (default 10).
 * @param opts.includeSourcePos Include file:line:column when available (default true).
 * @param opts.stackProvider  Inject a fake stack (string or minimal CallSite[]) for tests.
 *
 * @returns An object like:
 * ```ts
 * {
 *   className?: string;
 *   methodName?: string;
 *   functionName?: string;
 *   file?: string;
 *   line?: number;
 *   column?: number;
 *   url: string;       // normalized from importMetaURL
 *   reason?: string;   // present if incomplete
 * }
 * ```
 */
export function sourceCodeProvenance(opts: {
  importMetaURL: string;
  framesToSkip?: number;
  maxDepth?: number;
  includeSourcePos?: boolean;
  stackProvider?: () => string | ReadonlyArray<unknown> | undefined;
}) {
  const {
    importMetaURL,
    framesToSkip = 0,
    maxDepth = 10,
    includeSourcePos = true,
    stackProvider,
  } = opts;

  // Normalize importMetaURL for display/logging
  const url = (() => {
    try {
      const u = new URL(importMetaURL);
      return u.protocol === "file:" ? (u.pathname || importMetaURL) : u.href;
    } catch {
      return importMetaURL;
    }
  })();

  // Minimal “CallSite-like” accessor helpers without using `any`
  const callSiteAccess = (cs: unknown) => {
    const asFn = <R>(name: string): R | undefined => {
      const fn = (cs as Record<string, unknown> | undefined)?.[name];
      return typeof fn === "function"
        ? (fn as () => R | null)() ?? undefined
        : undefined;
    };
    return {
      fn: asFn<string>("getFunctionName"),
      type: asFn<string>("getTypeName"),
      method: asFn<string>("getMethodName"),
      file: asFn<string>("getFileName"),
      line: asFn<number>("getLineNumber"),
      column: asFn<number>("getColumnNumber"),
    };
  };

  const fromCallSite = (cs: unknown) => {
    if (!cs) return { url, reason: "no-frame" } as const;

    const a = callSiteAccess(cs);

    const normalizedFn = a.fn?.replace(/^async\s+|^new\s+|^bound\s+/, "");
    const className = a.type ??
      (normalizedFn && normalizedFn.includes(".")
        ? normalizedFn.split(".")[0]
        : undefined);
    const methodName = a.method ??
      (normalizedFn && normalizedFn.includes(".")
        ? normalizedFn.split(".").pop()
        : normalizedFn);
    const functionName = normalizedFn ??
      (className && methodName ? `${className}.${methodName}` : methodName);

    const file = includeSourcePos ? a.file ?? undefined : undefined;
    const line = includeSourcePos ? a.line ?? undefined : undefined;
    const column = includeSourcePos ? a.column ?? undefined : undefined;

    return { className, methodName, functionName, file, line, column, url };
  };

  const isInternalName = (name: string) =>
    /sourceCodeProvenance|provenanceComment|structured|parsed|fromCallSite/
      .test(name);

  const structured = () => {
    // Use V8 structured frames if available; gracefully no-op if not.
    const original = (Error as unknown as { prepareStackTrace?: unknown })
      .prepareStackTrace;
    try {
      (Error as unknown as { prepareStackTrace?: unknown })
        .prepareStackTrace = (
          _e: unknown,
          structuredFrames: unknown,
        ) => structuredFrames;

      const err = new Error();
      const stack = err.stack as unknown;

      if (!Array.isArray(stack)) return;

      // Skip our own internal helper frames first
      let idx = 0;
      while (idx < stack.length) {
        const name =
          callSiteAccess((stack as ReadonlyArray<unknown>)[idx]).fn ??
            "";
        if (isInternalName(name)) {
          idx++;
        } else {
          break;
        }
      }
      idx += framesToSkip;

      return fromCallSite((stack as ReadonlyArray<unknown>)[idx]);
    } catch {
      return;
    } finally {
      (Error as unknown as { prepareStackTrace?: unknown })
        .prepareStackTrace = original;
    }
  };

  const parsed = () => {
    const s = stackProvider ? stackProvider() : new Error().stack;

    if (typeof s !== "string") {
      return { url, reason: "no-stack-string" } as const;
    }

    const frames = s
      .split("\n")
      .slice(1, 1 + maxDepth)
      .map((l) => l.trim())
      .filter((l) => {
        // Filter out our internal helper frames
        const fn = l.match(/^at\s+(?<fn>.+?)\s+\(/)?.groups?.fn ??
          l.match(/^at\s+(?<fn>[^\s(]+)\s*$/)?.groups?.fn ??
          "";
        return !isInternalName(fn);
      });

    const line = frames[framesToSkip] ?? frames[0];
    if (!line) return { url, reason: "no-frame-after-filter" } as const;

    // Matches:
    //  - "at Class.method (file:///path/file.ts:10:5)"
    //  - "at functionName (file:///...:10:5)"
    //  - "at file:///path/file.ts:10:5"
    const m = line.match(/^at\s+(?<fn>.+?)\s+\((?<loc>.+)\)$/) ??
      line.match(/^at\s+(?<loc>file:.*|\w+:\/\/.*|\S+:\d+:\d+)$/);

    const rawFn = m?.groups?.fn?.replace(/^async\s+|^new\s+|^bound\s+/, "");
    const loc = m?.groups?.loc;

    let file: string | undefined;
    let lineNo: number | undefined;
    let colNo: number | undefined;

    if (loc) {
      const lm = loc.match(/^(.*?):(\d+):(\d+)$/);
      if (lm) {
        file = lm[1];
        lineNo = Number(lm[2]);
        colNo = Number(lm[3]);
      } else {
        file = loc;
      }
    }

    let className: string | undefined;
    let methodName: string | undefined;
    let functionName: string | undefined;

    if (rawFn) {
      const dot = rawFn.lastIndexOf(".");
      if (dot > 0) {
        className = rawFn.slice(0, dot);
        methodName = rawFn.slice(dot + 1);
      } else {
        methodName = rawFn;
      }
      functionName = rawFn;
    }

    return {
      className,
      methodName,
      functionName,
      file: includeSourcePos ? file : undefined,
      line: includeSourcePos ? lineNo : undefined,
      column: includeSourcePos ? colNo : undefined,
      url,
      reason: rawFn ? undefined : "no-function-name",
    };
  };

  // Prefer injected stack (deterministic tests) → else structured → fallback string parsing
  return (stackProvider ? parsed() : structured()) ?? parsed();
}

/**
 * Render a human-friendly one-liner from {@link sourceCodeProvenance}.
 *
 * Format example:
 * ```
 * code provenance: `MyService.doWork` (/path/to/file.ts:42:7)
 * ```
 *
 * The output **always** contains:
 * - A backticked function/method identifier (falls back to `unknown`)
 * - A source location (either `file:line:col`, or the normalized `url`)
 * - If incomplete, a trailing reason in brackets, e.g. `[no-function-name]`
 */
export function provenanceText(
  opts: Parameters<typeof sourceCodeProvenance>[0],
) {
  const p: ReturnType<typeof sourceCodeProvenance> = sourceCodeProvenance(
    opts,
  );
  const name = p.functionName ??
    (p.className && p.methodName
      ? `${p.className}.${p.methodName}`
      : p.methodName) ??
    "unknown";
  const loc = p.file && p.line != null && p.column != null
    ? `${p.file}:${p.line}:${p.column}`
    : p.url ?? "unknown-source";

  // deno-fmt-ignore
  return `\`${name}\` (${loc})${p.reason ? ` [${p.reason}]` : ""}`;
}
