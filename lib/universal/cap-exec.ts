/**
 * @module cap-exec
 *
 * Parallel **executor of executables** with a small, composable builder.
 *
 * - Each candidate is an executable (string/URL or `{ cmd, args?, env?, cwd?, stdin?, outPath?, label?, timeoutMs? }`).
 * - Global config (env/stdin/args/timeout/retry/concurrency) applies to all jobs and can be overridden per candidate.
 * - Default materialization writes a job’s `stdoutRaw` to an out path.
 * - **Multi-file generator mode**: if the executable name has a `+` in the **second-to-last extension** or the **basename**
 *   (e.g. `abc.sql+.ts` or `abc+.sql.ts`), stdout is treated as JSON Lines where each line is
 *   `{ "path": string, "content": string }`. Files are created accordingly (relative paths resolve under candidate/global cwd).
 * - Events: `start`, `success`, `error`, `generated` (per file in generator mode), `materialized`, `progress`, `done`, `log`.
 */

import { Spawnable } from "./spawnable.ts";
import {
  dirname as pathDirname,
  isAbsolute as pathIsAbsolute,
  resolve as pathResolve,
} from "jsr:@std/path@^1.0.6";

// deno-lint-ignore no-explicit-any
type Any = any;

/** Types accepted for stdin. */
type StdinLike =
  | Uint8Array
  | string
  | Iterable<string | Uint8Array>
  | AsyncIterable<string | Uint8Array>
  | (() =>
    | string
    | Uint8Array
    | Iterable<string | Uint8Array>
    | AsyncIterable<string | Uint8Array>)
  | ((w: WritableStreamDefaultWriter<Uint8Array>) => Promise<void> | void);

/** A single executable to run. Use a string/URL for shorthand, or the object form for overrides. */
export type ExecCandidate =
  | string
  | URL
  | {
    cmd: string | URL;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    stdin?: StdinLike;
    outPath?: string; // where default materializer writes stdout
    label?: string; // for naming outputs/logs
    timeoutMs?: number; // per-candidate override
  };

type SpawnRunResult = Awaited<ReturnType<Spawnable["run"]>>;

type Listener = (...args: unknown[]) => void;
type EventName =
  | "start"
  | "success"
  | "error"
  | "generated" // (candidate, filePath) per file in generator mode
  | "materialized" // (candidate, outPath | string[]) after materialization
  | "progress"
  | "done"
  | "log";
type ListenerMap = Partial<Record<EventName, Listener[]>>;

interface Semaphore {
  acquire(): Promise<() => void>;
}

function toAsyncIterable<T>(
  src: T | Iterable<T> | AsyncIterable<T>,
): AsyncIterable<T> {
  const s = src as {
    [Symbol.asyncIterator]?: () => AsyncIterator<T>;
    [Symbol.iterator]?: () => Iterator<T>;
  };
  if (typeof s[Symbol.asyncIterator] === "function") {
    return src as AsyncIterable<T>;
  }
  if (typeof s[Symbol.iterator] === "function") {
    return (async function* () {
      for (const v of src as Iterable<T>) yield v;
    })();
  }
  return (async function* () {
    yield src as T;
  })();
}

/** Normalized internal candidate form. */
type NCandidate = {
  cmd: string | URL;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  stdin?: StdinLike;
  outPath?: string;
  label?: string;
  timeoutMs?: number;
};

function normalizeCandidate(x: ExecCandidate): NCandidate {
  if (typeof x === "string" || x instanceof URL) return { cmd: x, args: [] };
  const { cmd, args = [], env, cwd, stdin, outPath, label, timeoutMs } = x;
  return { cmd, args, env, cwd, stdin, outPath, label, timeoutMs };
}

/** Get a crude basename from a command string/URL. */
function cmdBase(cmd: string | URL): string {
  const s = typeof cmd === "string" ? cmd : cmd.pathname;
  const slash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return slash >= 0 ? s.slice(slash + 1) || "cmd" : (s || "cmd");
}

/** Detect `+` marker for generator mode; returns nature like ".sql" if present. */
function detectMultiGen(
  cmd: string | URL,
): { isGenerator: boolean; nature: string | null } {
  const base = cmdBase(cmd);
  const parts = base.split(".");
  if (parts.length >= 3) {
    const secondToLast = parts[parts.length - 2];
    if (secondToLast.endsWith("+")) {
      return { isGenerator: true, nature: `.${secondToLast.slice(0, -1)}` };
    }
  }
  if (parts.length >= 2 && parts[0].endsWith("+")) {
    return { isGenerator: true, nature: `.${parts[1]}` };
  }
  return { isGenerator: false, nature: null };
}

/** Default single-file out-path:
 *  - "<name>.<nature>.<domain>"  ->  "<name>.auto.<nature>"
 *  - "<name>.<domain>"           ->  "<name>.auto"
 *  - "<name>"                    ->  "<name>.auto"
 *  Strips any trailing "+" from <name> or <nature>.
 *  Keeps any extra segments before <nature> (e.g. "pkg.data.sql.ts" -> "pkg.data.auto.sql").
 */
function defaultOutPath(c: NCandidate): string {
  const base = cmdBase(c.cmd); // e.g. "package.sql.ts", "abc+.sql.ts", "abc.sql+.ts"

  const lastDot = base.lastIndexOf(".");
  if (lastDot <= 0) {
    // no dot or dotfile like ".env" with no additional dot
    const name = base.replace(/\+$/, ""); // strip trailing "+" on basename
    return `${name}.auto`;
  }

  const secondLastDot = base.lastIndexOf(".", lastDot - 1);
  if (secondLastDot <= 0) {
    // only one extension present: "<name>.<domain>" -> "<name>.auto"
    const name = base.slice(0, lastDot).replace(/\+$/, ""); // strip trailing "+" on basename
    return `${name}.auto`;
  }

  // two or more extensions:
  // head = everything before the <nature> segment
  // nature = second-to-last extension (strip trailing "+")
  const head = base.slice(0, secondLastDot).replace(/\+$/, ""); // e.g. "abc+" -> "abc"
  const nature = base.slice(secondLastDot + 1, lastDot).replace(/\+$/, ""); // e.g. "sql+" -> "sql"
  return nature ? `${head}.auto.${nature}` : `${head}.auto`;
}

function hcDefault() {
  const nav =
    (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator;
  return Math.max(1, nav?.hardwareConcurrency ?? 4);
}

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

const TD = new TextDecoder();

function decode(u8: Uint8Array) {
  return TD.decode(u8);
}

/** Try write text; never throw. */
async function ensureWriteTextSafe(
  absPath: string,
  content: string,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  try {
    await Deno.mkdir(pathDirname(absPath), { recursive: true });
    await Deno.writeTextFile(absPath, content);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Parallel executor of executables with optional multi-file generator support.
 *
 * - **Single-file mode (default):** writes `stdoutRaw` to an output path.
 * - **Generator mode:** if the executable name contains a `+` marker in the
 *   second-to-last extension or basename (e.g. `abc.sql+.ts` or `abc+.sql.ts`),
 *   stdout is parsed as JSON Lines: each line must be `{"path": string, "content": string}`.
 *   The executor writes each file accordingly and emits `"generated"` per file.
 *
 * Notes:
 * - In generator mode, the user-provided `materialize` callback is **not invoked** (its signature is single-file).
 *   The executor handles writing each `{"path","content"}` line instead. After all writes, it emits `"materialized"`
 *   with a `string[]` of generated paths. In single-file mode, `"materialized"` receives the single outPath string.
 */
export class CapExec<R = SpawnRunResult> {
  private constructor(
    private readonly cfg: {
      candidates?:
        | ExecCandidate
        | Iterable<ExecCandidate>
        | AsyncIterable<ExecCandidate>;
      // global composition
      prependArgs?: string[];
      appendArgs?: string[];
      env?: { value: Record<string, string>; inherit?: boolean };
      stdin?: StdinLike;
      cwd?: string;
      timeoutMs?: number;
      // behavior
      materialize?: (
        candidate: NCandidate,
        result: R,
        outPath: string,
      ) => void | Promise<void>;
      outPathRule?: (candidate: NCandidate) => string;
      resultMapper?: (raw: SpawnRunResult, candidate: NCandidate) => R;
      concurrency?: number;
      semaphore?: Semaphore;
      listeners?: ListenerMap;
      // optional filtering / hooks
      filter?: (c: NCandidate) => boolean;
      preflight?: (c: NCandidate) => void | Promise<void>;
      postflight?: (c: NCandidate, result: R | null) => void | Promise<void>;
      // retry / robustness
      retry?: {
        times: number;
        backoff?: (attempt: number) => number;
        retryOn?: (
          ctx: {
            candidate: NCandidate;
            attempt: number;
            error?: unknown;
            result?: SpawnRunResult;
          },
        ) => boolean;
      };
      // misc
      dryRun?: boolean;
      logger?: Partial<
        Record<
          "debug" | "info" | "warn" | "error",
          (...args: unknown[]) => void
        >
      >;
    } = {},
  ) {}

  /** Start a new builder. */
  static create<R = SpawnRunResult>() {
    return new CapExec<R>({ concurrency: 10 });
  }

  // ------------- Builder (immutable) -------------

  withCandidates(src: NonNullable<CapExec<R>["cfg"]["candidates"]>) {
    return new CapExec<R>({ ...this.cfg, candidates: src });
  }

  /** Replace (not append) the global args placed **before** each candidate's own args. */
  withPrependArgs(...args: string[]) {
    return new CapExec<R>({ ...this.cfg, prependArgs: args });
  }

  /** Replace (not append) the global args placed **after** each candidate's own args. */
  withAppendArgs(...args: string[]) {
    return new CapExec<R>({ ...this.cfg, appendArgs: args });
  }

  withEnv<T extends Record<string, string>>(
    env: T,
    opts?: { inherit?: boolean },
  ) {
    return new CapExec<R>({
      ...this.cfg,
      env: { value: env, inherit: opts?.inherit },
    });
  }

  withStdin(stdin: NonNullable<CapExec<R>["cfg"]["stdin"]>) {
    return new CapExec<R>({ ...this.cfg, stdin });
  }

  withCwd(cwd: string) {
    return new CapExec<R>({ ...this.cfg, cwd });
  }

  withTimeout(ms: number) {
    return new CapExec<R>({ ...this.cfg, timeoutMs: Math.max(0, ms | 0) });
  }

  withMaterialize(fn: NonNullable<CapExec<R>["cfg"]["materialize"]>) {
    return new CapExec<R>({ ...this.cfg, materialize: fn });
  }

  withOutPathRule(fn: NonNullable<CapExec<R>["cfg"]["outPathRule"]>) {
    return new CapExec<R>({ ...this.cfg, outPathRule: fn });
  }

  /** Change the mapped result type R. Drops materialize/postflight, which referenced the old R. */
  withResultMapper<M>(fn: (raw: SpawnRunResult, candidate: NCandidate) => M) {
    const { materialize: _m, postflight: _p, ...rest } = this.cfg;
    return new CapExec<M>({ ...rest, resultMapper: fn });
  }

  withConcurrency(n = 10) {
    return new CapExec<R>({ ...this.cfg, concurrency: Math.max(1, n | 0) });
  }

  withConcurrencyAuto() {
    return this.withConcurrency(hcDefault());
  }

  withSemaphore(semaphore: Semaphore) {
    return new CapExec<R>({ ...this.cfg, semaphore });
  }

  withFilter(fn: NonNullable<CapExec<R>["cfg"]["filter"]>) {
    return new CapExec<R>({ ...this.cfg, filter: fn });
  }

  withPreflight(fn: NonNullable<CapExec<R>["cfg"]["preflight"]>) {
    return new CapExec<R>({ ...this.cfg, preflight: fn });
  }

  withPostflight(fn: NonNullable<CapExec<R>["cfg"]["postflight"]>) {
    return new CapExec<R>({ ...this.cfg, postflight: fn });
  }

  withRetry(opts: NonNullable<CapExec<R>["cfg"]["retry"]>) {
    const times = Math.max(1, opts.times | 0);
    return new CapExec<R>({ ...this.cfg, retry: { ...opts, times } });
  }

  withDryRun(on = true) {
    return new CapExec<R>({ ...this.cfg, dryRun: on });
  }
  withLog(logger: NonNullable<CapExec<R>["cfg"]["logger"]>) {
    return new CapExec<R>({ ...this.cfg, logger });
  }

  on<Evt extends EventName>(event: Evt, listener: Listener) {
    const listeners: ListenerMap = { ...(this.cfg.listeners ?? {}) };
    listeners[event] = [...(listeners[event] ?? []), listener];
    return new CapExec<R>({ ...this.cfg, listeners });
  }

  static isExecutable(path: string) {
    try {
      const info = Deno.statSync(path);
      if (!info.isFile) return false;

      const mode = info.mode ?? 0;
      // POSIX: any of user/group/other execute bits
      if (mode !== 0) return (mode & 0o111) !== 0;

      // Windows / platforms without mode: fall back to extension heuristic
      const p = path.toLowerCase();
      return [".exe", ".cmd", ".bat", ".com", ".ps1"].some((ext) =>
        p.endsWith(ext)
      );
    } catch {
      return false;
    }
  }

  /**
   * Parse a filename/path and detect “capturable executables” with the following rules:
   *
   *   <name>.<nature>.<domain>                      // domain like ts/py/sh; nature like sql/txt
   *   <name>+.<nature>.<domain>                     // multi-file (marker on basename)
   *   <name>+.<nature>+.<domain>                    // multi-file (marker on basename and nature)
   *   <name>.<nature>+.<domain>                     // multi-file (marker on nature)
   *
   * isCapExec === (isExecutable && has <nature>)     // multi-file flag is optional
   */
  static capExecCandidacy(filename: string) {
    const lastSlash = Math.max(
      filename.lastIndexOf("/"),
      filename.lastIndexOf("\\"),
    );
    const base = lastSlash >= 0 ? filename.slice(lastSlash + 1) : filename;

    // Treat dotfiles like ".env" as having no extensions
    const isDotFile = base.startsWith(".") && base.indexOf(".", 1) === -1;
    const rawParts = isDotFile ? [base] : base.split(".");

    const stem = rawParts[0] ?? "";
    const stemNoPlus = stem.endsWith("+") ? stem.slice(0, -1) : stem;

    const extensions = rawParts.length > 1 ? rawParts.slice(1) : [];
    const extension = extensions.length
      ? extensions[extensions.length - 1]
      : null; // <domain>
    const extensionWithDot = extension ? `.${extension}` : null;

    // <nature> (second-to-last extension; may carry '+')
    const natureRaw = extensions.length >= 2
      ? extensions[extensions.length - 2]
      : null;
    const natureCore = natureRaw ? natureRaw.replace(/\+$/, "") : null;
    const secondExtension = natureCore; // keep for backward compatibility in result
    const nature = natureCore ? `.${natureCore}` : null;

    // multi-file marker can be on <name> or on <nature> (or both)
    const markerOnName = stem.endsWith("+");
    const markerOnNature = !!natureRaw && natureRaw.endsWith("+");
    const isMulti = markerOnName || markerOnNature;
    const markerPosition = markerOnNature
      ? "secondExt"
      : (markerOnName ? "basename" : null);

    const isExecutable = CapExec.isExecutable(filename);

    // NEW rule: CapExec candidacy requires executability + a <nature>, multi is optional
    const isCapExec = !!nature && isExecutable;

    return {
      base,
      stem,
      stemNoPlus,
      extensions,
      extension, // <domain> without dot
      extensionWithDot, // <domain> with dot
      secondExtension, // <nature> without dot (+ stripped)
      isMulti,
      nature, // ".<nature>" or null
      markerPosition, // "basename" | "secondExt" | null
      rawParts,
      isExecutable,
      isCapExec,
    };
  }

  // ------------- Internals -------------

  private emit(event: EventName, ...args: unknown[]) {
    const arr = this.cfg.listeners?.[event];
    if (!arr) return;
    for (const fn of arr) {
      try {
        fn(...args);
      } catch { /* ignore */ }
    }
  }

  private log(level: "debug" | "info" | "warn" | "error", ...args: unknown[]) {
    this.cfg.logger?.[level]?.(...args);
    this.emit("log", level, ...args);
  }

  private buildArgs(c: NCandidate) {
    const pre = this.cfg.prependArgs ?? [];
    const post = this.cfg.appendArgs ?? [];
    return [...pre, ...c.args, ...post];
  }

  private outPathFor(c: NCandidate) {
    return c.outPath ??
      (this.cfg.outPathRule ? this.cfg.outPathRule(c) : defaultOutPath(c));
  }

  private mapResult(raw: SpawnRunResult, c: NCandidate): R {
    return this.cfg.resultMapper
      ? this.cfg.resultMapper(raw, c)
      : (raw as unknown as R);
  }

  /** Attempt to run a candidate; never throws. */
  private async attemptRun(
    c: NCandidate,
  ): Promise<
    { ok: true; res: SpawnRunResult } | { ok: false; error: unknown }
  > {
    const r = this.cfg.retry;
    const attempts = r?.times ?? 1;
    const backoff = r?.backoff ?? (() => 0);
    const retryOn = r?.retryOn ??
      ((ctx: { result?: SpawnRunResult; error?: unknown }) =>
        !!ctx.error || (ctx.result ? !ctx.result.success : true));

    let lastErr: unknown = undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        // Build a fresh Spawnable for each candidate
        let sp = Spawnable.from(c.cmd).withArgs(this.buildArgs(c));
        const mergedEnv = {
          ...((this.cfg.env?.inherit ? Deno.env.toObject() : {}) as Record<
            string,
            string
          >),
          ...(this.cfg.env?.value ?? {}),
          ...(c.env ?? {}),
        };
        if (Object.keys(mergedEnv).length) sp = sp.withEnv(mergedEnv);
        if (this.cfg.stdin || c.stdin) {
          sp = sp.withStdin(c.stdin ?? this.cfg.stdin!);
        }
        if (this.cfg.cwd || c.cwd) sp = sp.withCwd(c.cwd ?? this.cfg.cwd!);
        const tmo = c.timeoutMs ?? this.cfg.timeoutMs;
        if (tmo) sp = sp.withTimeout(tmo);

        const res = await sp.run();
        const again = retryOn({ candidate: c, attempt, result: res });
        if (!again) return { ok: true, res };
        lastErr = new Error(`retryOn requested retry (attempt=${attempt})`);
      } catch (e) {
        lastErr = e;
        const again = retryOn({ candidate: c, attempt, error: e });
        if (!again) return { ok: false, error: e };
      }
      const wait = backoff(attempt);
      if (wait > 0) await delay(wait);
    }
    return { ok: false, error: lastErr };
  }

  // deno-lint-ignore require-await
  private async runWorkers<T>(n: number, worker: () => Promise<T>) {
    const size = Math.max(1, n | 0);
    const arr = Array.from({ length: size }, () => worker());
    return Promise.all(arr);
  }

  // ------------- Public API -------------

  /**
   * Run all candidates with a concurrency limit (or external semaphore).
   * Returns successful items (see `generatedPaths` for generator mode).
   * Errors are **emitted** via `"error"` and do **not** throw.
   */
  async run() {
    const { candidates } = this.cfg;
    if (!candidates) {
      const err = new Error("CapExec: no candidates provided");
      this.emit("error", undefined, err);
      this.emit("done", []);
      return [];
    }

    // Determine source + optional total for progress
    let total: number | undefined;
    let source: AsyncIterable<NCandidate>;
    const candObj = candidates as {
      [Symbol.iterator]?: () => Iterator<ExecCandidate>;
      [Symbol.asyncIterator]?: () => AsyncIterator<ExecCandidate>;
    };
    if (candObj[Symbol.iterator] && !candObj[Symbol.asyncIterator]) {
      const arr = Array.from(candidates as Iterable<ExecCandidate>).map(
        normalizeCandidate,
      );
      total = arr.length;
      source = toAsyncIterable(arr);
    } else if (!candObj[Symbol.iterator] && !candObj[Symbol.asyncIterator]) {
      total = 1;
      source = toAsyncIterable(normalizeCandidate(candidates as ExecCandidate));
    } else {
      source = (async function* (it) {
        for await (const v of toAsyncIterable(it)) yield normalizeCandidate(v);
      })(candidates);
    }

    const iterator = source[Symbol.asyncIterator]();
    const semaphore = this.cfg.semaphore;
    const pool = this.cfg.concurrency ?? 10;

    let done = 0;
    const results: Array<{
      candidate: NCandidate;
      result: R | null;
      outPath?: string;
      generatedPaths?: string[];
    }> = [];

    const one = async () => {
      while (true) {
        const next = await iterator.next();
        if (next.done) return;
        const c = next.value as NCandidate;

        if (this.cfg.filter && !this.cfg.filter(c)) {
          done++;
          this.emit("progress", { done, total });
          continue;
        }

        const permit = semaphore ? await semaphore.acquire() : undefined;
        let lastResult: R | null = null;
        try {
          this.emit("start", c);
          try {
            await this.cfg.preflight?.(c);
          } catch (e) {
            this.emit("error", c, e);
            continue;
          }

          const { isGenerator, nature } = detectMultiGen(c.cmd);

          if (this.cfg.dryRun) {
            if (isGenerator) {
              this.log(
                "info",
                `CapExec: generator${nature ? `(${nature})` : ""} [dry-run]`,
                c.cmd,
              );
              this.emit("materialized", c, [] as string[]);
              this.emit("success", c, null);
              results.push({ candidate: c, result: null, generatedPaths: [] });
            } else {
              const out = this.outPathFor(c);
              this.log("info", "[dry-run] plan", {
                cmd: c.cmd,
                args: this.buildArgs(c),
                outPath: out,
              });
              this.emit("materialized", c, out);
              this.emit("success", c, null);
              results.push({ candidate: c, result: null, outPath: out });
            }
          } else {
            const attempt = await this.attemptRun(c);
            if (!attempt.ok) {
              this.emit("error", c, attempt.error);
            } else {
              const raw = attempt.res;
              lastResult = this.mapResult(raw, c);

              if (isGenerator) {
                const text = decode(raw.stdoutRaw);
                const baseCwd = c.cwd ?? this.cfg.cwd ?? Deno.cwd();
                const generated: string[] = [];
                const lines = text.split(/\r?\n/);
                let genFailed = false;

                for (const line of lines) {
                  const trimmed = line.trim();
                  if (!trimmed) continue;
                  let obj: unknown;
                  try {
                    obj = JSON.parse(trimmed);
                  } catch (e) {
                    this.emit(
                      "error",
                      c,
                      new Error(
                        `Generator JSONL parse error: ${
                          (e as Error).message
                        }\nLine: ${trimmed}`,
                      ),
                    );
                    genFailed = true;
                    break;
                  }
                  if (
                    !obj || typeof obj !== "object" ||
                    typeof (obj as Any).path !== "string" ||
                    typeof (obj as Any).content !== "string"
                  ) {
                    this.emit(
                      "error",
                      c,
                      new Error(
                        `Generator JSONL line must be { "path": string, "content": string }.\nLine: ${trimmed}`,
                      ),
                    );
                    genFailed = true;
                    break;
                  }
                  const rel = (obj as Any).path as string;
                  const content = (obj as Any).content as string;
                  const abs = pathIsAbsolute(rel)
                    ? rel
                    : pathResolve(baseCwd, rel);
                  const wrote = await ensureWriteTextSafe(abs, content);
                  if (!wrote.ok) {
                    this.emit("error", c, wrote.error);
                    genFailed = true;
                    break;
                  }
                  generated.push(abs);
                  this.emit("generated", c, abs);
                }

                if (!genFailed) {
                  this.log(
                    "info",
                    `CapExec: generator${
                      nature ? `(${nature})` : ""
                    } -> ${generated.length} file(s)`,
                  );
                  this.emit("materialized", c, generated);
                  this.emit("success", c, lastResult);
                  results.push({
                    candidate: c,
                    result: lastResult,
                    generatedPaths: generated,
                  });
                }
              } else {
                const out = this.outPathFor(c);
                if (this.cfg.materialize) {
                  try {
                    await this.cfg.materialize(c, lastResult, out);
                  } catch (e) {
                    this.emit("error", c, e);
                    // do not push result
                    continue;
                  }
                } else {
                  try {
                    await Deno.writeFile(
                      out,
                      (lastResult as unknown as SpawnRunResult).stdoutRaw ??
                        raw.stdoutRaw,
                    );
                  } catch (e) {
                    this.emit("error", c, e);
                    continue;
                  }
                }
                this.emit("materialized", c, out);
                this.emit("success", c, lastResult);
                results.push({
                  candidate: c,
                  result: lastResult,
                  outPath: out,
                });
              }
            }
          }
        } finally {
          try {
            await this.cfg.postflight?.(c, lastResult);
          } catch (e) {
            this.emit("error", c, e);
          }
          if (permit) permit();
          done++;
          this.emit("progress", { done, total });
        }
      }
    };

    await this.runWorkers(pool, one);
    this.emit("done", results);
    return results;
  }

  /**
   * Like `run()` but returns settled tuples for each candidate.
   * For generator mode, see `generatedPaths` on fulfilled values.
   * Errors are **emitted** via `"error"` and included in returned tuples.
   */
  async runSettled() {
    const { candidates } = this.cfg;
    if (!candidates) {
      const err = new Error("CapExec: no candidates provided");
      this.emit("error", undefined, err);
      return [];
    }

    const iterator = (async function* (it) {
      for await (const v of toAsyncIterable(it)) yield normalizeCandidate(v);
    })(candidates)[Symbol.asyncIterator]();
    const semaphore = this.cfg.semaphore;
    const pool = this.cfg.concurrency ?? 10;

    const settled: Array<
      | {
        candidate: NCandidate;
        status: "fulfilled";
        value: {
          result: R | null;
          outPath?: string;
          generatedPaths?: string[];
        };
      }
      | { candidate: NCandidate; status: "rejected"; reason: unknown }
    > = [];

    const one = async () => {
      while (true) {
        const next = await iterator.next();
        if (next.done) return;
        const c = next.value as NCandidate;

        if (this.cfg.filter && !this.cfg.filter(c)) continue;

        const permit = semaphore ? await semaphore.acquire() : undefined;
        let lastResult: R | null = null;

        try {
          if (this.cfg.dryRun) {
            const { isGenerator } = detectMultiGen(c.cmd);
            if (isGenerator) {
              settled.push({
                candidate: c,
                status: "fulfilled",
                value: { result: null, generatedPaths: [] },
              });
            } else {
              const out = this.outPathFor(c);
              settled.push({
                candidate: c,
                status: "fulfilled",
                value: { result: null, outPath: out },
              });
            }
            continue;
          }

          const attempt = await this.attemptRun(c);
          if (!attempt.ok) {
            this.emit("error", c, attempt.error);
            settled.push({
              candidate: c,
              status: "rejected",
              reason: attempt.error,
            });
            continue;
          }

          const raw = attempt.res;
          lastResult = this.mapResult(raw, c);

          const { isGenerator } = detectMultiGen(c.cmd);
          if (isGenerator) {
            const text = decode(raw.stdoutRaw);
            const baseCwd = c.cwd ?? this.cfg.cwd ?? Deno.cwd();
            const generated: string[] = [];
            const lines = text.split(/\r?\n/);

            let genFailed = false;
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              let obj: unknown;
              try {
                obj = JSON.parse(trimmed);
              } catch (e) {
                const err = new Error(
                  `Generator JSONL parse error: ${
                    (e as Error).message
                  }\nLine: ${trimmed}`,
                );
                this.emit("error", c, err);
                settled.push({ candidate: c, status: "rejected", reason: err });
                genFailed = true;
                break;
              }
              if (
                !obj || typeof obj !== "object" ||
                typeof (obj as Any).path !== "string" ||
                typeof (obj as Any).content !== "string"
              ) {
                const err = new Error(
                  `Generator JSONL line must be { "path": string, "content": string }.\nLine: ${trimmed}`,
                );
                this.emit("error", c, err);
                settled.push({ candidate: c, status: "rejected", reason: err });
                genFailed = true;
                break;
              }
              const rel = (obj as Any).path as string;
              const content = (obj as Any).content as string;
              const abs = pathIsAbsolute(rel) ? rel : pathResolve(baseCwd, rel);
              const wrote = await ensureWriteTextSafe(abs, content);
              if (!wrote.ok) {
                this.emit("error", c, wrote.error);
                settled.push({
                  candidate: c,
                  status: "rejected",
                  reason: wrote.error,
                });
                genFailed = true;
                break;
              }
              generated.push(abs);
              this.emit("generated", c, abs);
            }
            if (!genFailed) {
              settled.push({
                candidate: c,
                status: "fulfilled",
                value: { result: lastResult, generatedPaths: generated },
              });
            }
          } else {
            const out = this.outPathFor(c);
            if (this.cfg.materialize) {
              try {
                await this.cfg.materialize(c, lastResult, out);
              } catch (e) {
                this.emit("error", c, e);
                settled.push({ candidate: c, status: "rejected", reason: e });
                continue;
              }
            } else {
              try {
                await Deno.writeFile(
                  out,
                  (lastResult as unknown as SpawnRunResult).stdoutRaw ??
                    raw.stdoutRaw,
                );
              } catch (e) {
                this.emit("error", c, e);
                settled.push({ candidate: c, status: "rejected", reason: e });
                continue;
              }
            }
            settled.push({
              candidate: c,
              status: "fulfilled",
              value: { result: lastResult, outPath: out },
            });
          }
        } catch (reason) {
          // Any unexpected error (defensive): emit + reject
          this.emit("error", c, reason);
          settled.push({ candidate: c, status: "rejected", reason });
        } finally {
          try {
            await this.cfg.postflight?.(c, lastResult);
          } catch (e) {
            this.emit("error", c, e);
          }
          if (permit) permit();
        }
      }
    };

    await this.runWorkers(pool, one);
    return settled;
  }
}
