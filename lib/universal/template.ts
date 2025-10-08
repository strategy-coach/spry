/**
 * @module template
 *
 * Sandboxed TypeScript template evaluator for Deno.
 *
 * This module allows evaluation of template strings that contain full
 * TypeScript expressions inside ${ ... }. Evaluation occurs inside a
 * dedicated Web Worker for safety and isolation.
 *
 * Features:
 * - Full TypeScript support inside template expressions
 * - Execution in a sandboxed Web Worker
 * - Works on stable Deno by default
 * - Optional granular permission model with --unstable-worker-options
 * - Zero external dependencies
 *
 * API Overview:
 *   const { evaluate } = createTsEvaluator<Ctx, G>(init);
 *   await evaluate(code, ctx);
 *
 * For detailed, runnable examples, see `lib/universal/template_test.ts`.
 *
 * Why it is powerful:
 * - Supports full TypeScript syntax and async/await.
 * - Sandboxed execution keeps user expressions isolated from host environment.
 * - Optional least-privilege security model using worker permissions.
 * - Minimal API for embedding within higher-level templating systems.
 *
 * Security Model:
 * - By default (no unstable flag), WorkerOptions.deno is not attached; the
 *   worker inherits your process permissions.
 * - If unstableWorkerOptions is true and you run with
 *   --unstable-worker-options, WorkerOptions.deno.permissions is attached
 *   with your specified allow-lists.
 * - Inside the template, Deno, process, and require are shadowed to undefined.
 * - Timeout protection terminates long-running templates after timeoutMs.
 * - Both ctx and globals must be structured-cloneable (no functions, symbols,
 *   DOM nodes, etc.). Non-cloneable values throw before posting to the worker.
 * - Imports should be pure helpers (no FS/Net/Env) unless permissions are granted.
 *
 * Types:
 *   AllowList = boolean | string[]
 *     false / []  -> deny
 *     true        -> allow all
 *     string[]    -> allowlist (hosts for net, paths for read/write, env names for env)
 *
 *   ImportSpec = { spec: string; as: string }
 *     ESM helper modules exposed under the alias "as" inside the template.
 *
 * Factory:
 *   createTsEvaluator<Ctx, G>(init?: TsEvalInit<G>) -> { evaluate }
 *
 * Parameters:
 *   @param {AllowList} allowNet   Allowlist for network access (unstable worker mode)
 *   @param {AllowList} allowRead  Allowlist for filesystem read (unstable worker mode)
 *   @param {AllowList} allowWrite Allowlist for filesystem write (unstable worker mode)
 *   @param {AllowList} allowEnv   Allowlist for environment variables (unstable worker mode)
 *   @param {boolean} unstableWorkerOptions  If true, attaches WorkerOptions.deno.permissions;
 *           requires running with --unstable-worker-options
 *   @param {number} timeoutMs  Hard kill timeout for long-running templates (default: 1000ms)
 *   @param {ImportSpec[]} imports  Helper modules available inside templates
 *   @param {G} globals  Cloneable globals available to all renders from this factory
 *
 * Returns:
 *   { evaluate }
 *
 * evaluate Overloads:
 *   evaluate(code: string): Promise<(ctx: Ctx) => Promise<string>>
 *     Compiles the code once and returns a reusable runner.
 *
 *   evaluate(code: string, ctx: Ctx): Promise<string>
 *     Compiles and immediately runs the template once.
 *
 * Usage examples are in `lib/universal/template_test.ts`, including:
 * - Basic render with typed ctx
 * - One-shot vs. reusable evaluation
 * - Importing helpers (e.g., UUID from Deno std)
 * - Safety checks for Deno.*, timeouts, and error handling
 * - Validation of cloneable ctx and globals
 * - Factory-time permission validation behavior
 *
 * Caveats:
 * - Do not pass functions in ctx or globals. Use imports or inline logic.
 * - Imported helpers should be pure and deterministic.
 * - For performance, reuse compiled runners for multiple ctx values.
 * - Only strings are supported; for files, read content externally.
 * - When using unstable worker permissions, run with:
 *     deno test --unstable-worker-options
 *     or deno run --unstable-worker-options
 *
 * Troubleshooting:
 * - "must be structured-cloneable": remove non-cloneable data from ctx/globals.
 * - "Granular worker permissions requested": remove allow-lists or enable the flag.
 * - "timed out": the template exceeded timeoutMs; fix logic or increase timeout.
 *
 * Remarks:
 * This module is small and dependency-free. It can serve as a foundation for
 * higher-level templating or multi-engine systems, where this acts as the
 * TypeScript evaluation engine.
 */

export type ImportSpec = { spec: string; as: string };
export type AllowList = boolean | string[];

export interface TsEvalInit<
  G extends Record<string, unknown> = Record<string, unknown>,
> {
  // Security (default: deny unless using unstable worker options explicitly):
  allowNet?: AllowList;
  allowRead?: AllowList;
  allowWrite?: AllowList;
  allowEnv?: AllowList;

  /**
   * Set true if running with `--unstable-worker-options`.
   * Without this, we won't set `WorkerOptions.deno`, so it runs fine on stable.
   */
  unstableWorkerOptions?: boolean;

  // Execution limit:
  timeoutMs?: number; // default 1000

  // Usability:
  imports?: ImportSpec[];
  /**
   * Must be structured-cloneable (NO functions/symbols/etc.). If you need
   * callable helpers, expose them via `imports` (ESM) or compute inside template.
   */
  globals?: G;
}

/** Internal shape from the worker. */
interface WorkerResponse {
  ok: boolean;
  out?: string;
  err?: string;
}

/** Pretty error if something isn't structured-cloneable. */
function assertCloneable(name: string, value: unknown) {
  try {
    // eslint-disable-next-line no-undef
    structuredClone(value);
  } catch {
    throw new Error(
      `${name} must be structured-cloneable (no functions/symbols/DOM nodes, etc.).`,
    );
  }
}

/**
 * Create a sandboxed TypeScript evaluator.
 * `ctx` is generic and must be structured-cloneable at runtime.
 */
export function createTsEvaluator<
  Ctx extends Record<string, unknown> = Record<string, unknown>,
  G extends Record<string, unknown> = Record<string, unknown>,
>(init: TsEvalInit<G> = {}) {
  const timeoutMs = init.timeoutMs ?? 1000;

  // Validate globals up front
  assertCloneable("globals", init.globals ?? {});

  const granularRequested = init.allowNet !== undefined ||
    init.allowRead !== undefined ||
    init.allowWrite !== undefined ||
    init.allowEnv !== undefined;

  if (granularRequested && !init.unstableWorkerOptions) {
    throw new Error(
      "Granular worker permissions requested (allowRead/allowNet/allowWrite/allowEnv). " +
        "Run with --unstable-worker-options and set { unstableWorkerOptions: true }.",
    );
  }

  type PermissionOpts = Deno.PermissionOptions;
  type MaybeUnstableWorkerOptions = WorkerOptions & {
    deno?: { permissions?: PermissionOpts };
  };

  // Reusable worker program (module) that receives TS source + ctx/globals
  const workerBlobUrl = URL.createObjectURL(
    new Blob(
      [
        `
self.onmessage = async (ev) => {
  const { tsSource, ctx, globals } = ev.data;
  const url = "data:application/typescript;charset=utf-8," + encodeURIComponent(tsSource);
  try {
    const mod = await import(url);
    if (!mod || typeof mod.run !== "function") {
      throw new Error("Template module must export async function run(ctx, globals).");
    }
    const out = await mod.run(ctx, globals);
    if (typeof out !== "string") throw new Error("Template result must be a string.");
    self.postMessage({ ok: true, out });
  } catch (e) {
    self.postMessage({ ok: false, err: String(e && e.stack || e) });
  }
};
        `,
      ],
      { type: "application/javascript" },
    ),
  );

  function makeModuleTs(code: string): string {
    const importLines = (init.imports ?? [])
      .map(({ spec, as }) => `import * as ${as} from ${JSON.stringify(spec)};`)
      .join("\n");

    const body = code.replace(/`/g, "\\`");

    return `
${importLines}

export type Ctx = Record<string, unknown>;
export type Globals = Record<string, unknown>;

export async function run(ctx: Ctx, globals: Globals): Promise<string> {
  const Deno = undefined as unknown as never;
  const process = undefined as unknown as never;
  const require = undefined as unknown as never;

  const scope = Object.freeze({ ctx, ...globals });
  const { ..._ } = scope;

  return (\`${body}\`);
}
//# sourceURL=inline:ts-evaluator-template
`;
  }

  function compile(code: string) {
    const tsSource = makeModuleTs(code);

    const baseOptions: WorkerOptions = {
      type: "module",
      name: "ts-evaluator",
    };

    const options: MaybeUnstableWorkerOptions = { ...baseOptions };

    if (init.unstableWorkerOptions) {
      // Build a valid PermissionOptions object (no hrtime key)
      const permissions: PermissionOpts = granularRequested
        ? {
          net: init.allowNet ?? false,
          read: init.allowRead ?? false,
          write: init.allowWrite ?? false,
          env: init.allowEnv ?? false,
        }
        : {
          net: false,
          read: false,
          write: false,
          env: false,
        };

      options.deno = { permissions };
    }

    const worker = new Worker(workerBlobUrl, options);

    function postWithTimeout<TReq extends unknown>(
      payload: TReq,
      ms: number,
    ): Promise<WorkerResponse> {
      return new Promise((resolve, reject) => {
        const onMessage = (ev: MessageEvent) => {
          cleanup();
          resolve(ev.data as WorkerResponse);
        };
        const onError = (ev: Event) => {
          cleanup();
          reject(
            new Error(
              `Worker error: ${String((ev as ErrorEvent).message || ev)}`,
            ),
          );
        };
        const cleanup = () => {
          clearTimeout(timer);
          worker.removeEventListener("message", onMessage);
          worker.removeEventListener("error", onError);
        };
        const timer = setTimeout(() => {
          cleanup();
          try {
            worker.terminate();
            // deno-lint-ignore no-empty
          } catch (_e) {}
          reject(new Error(`Evaluation timed out after ${ms} ms`));
        }, ms);

        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", onError);
        worker.postMessage(payload);
      });
    }

    const runCompiled = async (ctx: Ctx): Promise<string> => {
      // Validate ctx on every call so we fail before posting
      assertCloneable("ctx", ctx);
      try {
        const res = await postWithTimeout(
          { tsSource, ctx, globals: init.globals ?? {} },
          timeoutMs,
        );
        if (!res.ok) throw new Error(res.err ?? "Unknown template error");
        return res.out ?? "";
      } finally {
        try {
          worker.terminate();
          // deno-lint-ignore no-empty
        } catch (_e) {}
      }
    };

    return runCompiled;
  }

  // Overloads:
  async function evaluate(code: string): Promise<(ctx: Ctx) => Promise<string>>;
  async function evaluate(code: string, ctx: Ctx): Promise<string>;
  // deno-lint-ignore require-await
  async function evaluate(code: string, ctx?: Ctx) {
    const runner = compile(code);
    if (arguments.length === 2) return runner(ctx as Ctx);
    return runner;
  }

  return { evaluate };
}
