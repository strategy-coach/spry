// fs.ts
// A "typical" filesystem-based CapExec adapter with strongly-typed, generic hooks.
// Keeps decisions with the consumer via generics & callbacks; defaults are minimal and overridable.

import {
  createFSAdapter,
  type FSEncountered,
  type FSWalkSpec,
  type FSWalkSpecNorm,
} from "../walk/mod.ts"; // re-export of walk-fs.ts
import { type CapExecFound, walkCapExecs } from "./walk.ts";
import {
  type AnyIterable,
  type MaybePromise,
  toAsyncIterable,
} from "../walk/mod.ts"; // re-export of walk-core.ts
import {
  type CapExecOutputAdapter,
  type CapExecSupplier,
  type ContentStream,
  type Pipeline,
  prepareCapExecs,
  type PreparedCapExec,
  type PreparedOrExecuted,
  type PrepareMode,
} from "./prepare.ts";
import { basename, dirname, extname, join } from "jsr:@std/path@1";

// --------------------------- Minimal stage/sink bases ---------------------------

// deno-lint-ignore no-explicit-any
type Any = any;

export type FSStageBase = Readonly<{
  /** Process argv; argv[0] is the executable. */
  argv: readonly string[];
  /** Working directory for the process (defaults to sink dir). */
  cwd?: string;
  /** Env vars to overlay; adapter merges with projection. */
  env?: Readonly<Record<string, string>>;
}>;

export type FSSinkBase = Readonly<{
  argv: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
}>;

function coerceStage<Stage extends FSStageBase>(o: FSStageBase): Stage {
  return o as unknown as Stage;
}
function coerceSink<Sink extends FSSinkBase>(o: FSSinkBase): Sink {
  return o as unknown as Sink;
}

// ------------------------------- Helper utilities -------------------------------

// deno-lint-ignore require-await
async function streamFromBytes(
  bytes: Uint8Array,
): Promise<ReadableStream<Uint8Array>> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function bytesFromStream(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

async function atomicWriteFile(
  path: string,
  content: ReadableStream<Uint8Array>,
): Promise<void> {
  const dir = dirname(path);
  await Deno.mkdir(dir, { recursive: true });
  const tmp = join(dir, `.capexec-tmp-${crypto.randomUUID()}`);

  // Open a temp file and stream the content into it.
  const file = await Deno.open(tmp, {
    write: true,
    create: true,
    truncate: true,
  });
  const writer = file.writable.getWriter();
  try {
    const reader = content.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      await writer.write(value);
    }
    // Closing the writer also closes the underlying file resource.
    await writer.close();
  } catch (err) {
    // Best-effort cleanup on failure
    try {
      await writer.abort(err);
    } catch { /** ignore */ }
    try {
      await Deno.remove(tmp);
    } catch { /** ignore */ }
    throw err;
  }

  // Atomically move into place
  await Deno.rename(tmp, path);
}

function decodeLinesUtf8(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const dec = new TextDecoder();
  let buf = "";
  const reader = stream.getReader();
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          while (true) {
            const nl = buf.indexOf("\n");
            if (nl >= 0) {
              const line = buf.slice(0, nl);
              buf = buf.slice(nl + 1);
              return { value: line, done: false };
            }
            const { value, done } = await reader.read();
            if (done) {
              if (buf.length > 0) {
                const last = buf;
                buf = "";
                return { value: last, done: false };
              }
              return { value: undefined, done: true };
            }
            buf += dec.decode(value, { stream: true });
          }
        },
      };
    },
  };
}

function hasExecBit(mode?: number | null): boolean {
  if (mode == null) return false;
  return (mode & 0o111) !== 0;
}

// -------------------------- Subprocess chain execution --------------------------

// deno-lint-ignore require-await
async function runOneProcess(
  input: ContentStream,
  stage: FSStageBase,
  envOverlay: Readonly<Record<string, string>> | undefined,
): Promise<ContentStream> {
  const cmd = new Deno.Command(stage.argv[0]!, {
    args: stage.argv.slice(1),
    cwd: stage.cwd,
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
    env: envOverlay
      ? { ...envOverlay, ...(stage.env ?? {}) }
      : (stage.env as Record<string, string> | undefined),
  });
  const child = cmd.spawn();

  // Pump input into child's stdin
  (async () => {
    try {
      const writer = child.stdin.getWriter();
      const reader = input.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        await writer.write(value);
      }
      await writer.close();
    } catch {
      // ignore
    }
  })();

  // Expose stdout as ContentStream
  const out = child.stdout;
  // Do not await status here; downstream consumer reads until stream ends; process exits thereafter.
  return out;
}

async function chainProcesses(
  input: ContentStream,
  stages: AnyIterable<FSStageBase>,
  envOverlay?: Readonly<Record<string, string>>,
): Promise<ContentStream> {
  let current = input;
  for await (const s of toAsyncIterable(stages)) {
    current = await runOneProcess(current, s, envOverlay);
  }
  return current;
}

// ------------------------------ FSPipeline factory ------------------------------

export function createFSPipeline<
  Stage extends FSStageBase,
  Ctx = unknown,
  Payload = unknown,
>(
  stages: AnyIterable<Stage>,
  payload?: Payload,
): Pipeline<Stage, Ctx, Payload> {
  return {
    stages,
    payload,
    async execute(input, args) {
      // Downcast to FSStageBase for execution; types ensure Stage extends FSStageBase
      const out = await chainProcesses(
        input,
        stages as AnyIterable<FSStageBase>,
        args.env,
      );
      return { output: out };
    },
  };
}

// ------------------------------ Resolver contracts ------------------------------

export type DomainLauncher = (file: string) => readonly string[];

export type FsResolveOptions<Ctx = unknown> = Readonly<{
  /** Extra search directories for stage tokens (in order). */
  stageSearchDirs?: readonly string[];
  /** How to launch a file if no shebang or exec bit; key by lowercase extension without dot (e.g., "ts","py"). */
  domainLaunchers?: Readonly<Record<string, DomainLauncher>>;
  /** Build a base env overlay per invocation. */
  projectEnv?: (args: {
    found:
      | CapExecFound<FSWalkSpecNorm, Deno.DirEntry | unknown, unknown>
      | CapExecFound<FSWalkSpecNorm, Any, Any>;
    ctx?: Ctx;
    mode?: PrepareMode;
  }) => Readonly<Record<string, string>>;
}>;

export type FsMaterializeSingle<ResultPayload, Ctx = unknown> = (args: {
  output: ContentStream;
  found: CapExecFound<FSWalkSpecNorm, Any, Any>;
  ctx?: Ctx;
  mode?: PrepareMode;
  /** Suggested default path: <dirname(sink)>/<basename>.auto.<nature> */
  suggestedPath: string;
}) => Promise<ResultPayload>;

export type FsMaterializeMulti<ResultPayload, Ctx = unknown> = (args: {
  output: ContentStream;
  found: CapExecFound<FSWalkSpecNorm, Any, Any>;
  ctx?: Ctx;
  mode?: PrepareMode;
  /** Base directory to resolve relative file paths (default sink dir). */
  baseDir: string;
}) => Promise<ResultPayload>;

export type FsAdapterOptions<
  Ctx = unknown,
  Stage extends FSStageBase = FSStageBase,
  Sink extends FSSinkBase = FSSinkBase,
  PrePayload = unknown,
  PostPayload = unknown,
  ResultPayload = unknown,
> = Readonly<{
  resolveStage?: (token: string, args: {
    found: CapExecFound<FSWalkSpecNorm, Any, Any>;
    ctx?: Ctx;
    mode?: PrepareMode;
    searchDirs: readonly string[];
    domainLaunchers: Readonly<Record<string, DomainLauncher>>;
  }) => Promise<Stage>;
  resolveSink?: (args: {
    found: CapExecFound<FSWalkSpecNorm, Any, Any>;
    ctx?: Ctx;
    mode?: PrepareMode;
    domainLaunchers: Readonly<Record<string, DomainLauncher>>;
  }) => Promise<Sink>;
  /** Optional per-pipeline payloads (pre/post). */
  createPrePayload?: (
    args: { found: CapExecFound<FSWalkSpecNorm, Any, Any>; ctx?: Ctx },
  ) => Promise<PrePayload>;
  createPostPayload?: (
    args: { found: CapExecFound<FSWalkSpecNorm, Any, Any>; ctx?: Ctx },
  ) => Promise<PostPayload>;
  /** Env projection (merged as base overlay for all processes). */
  projectEnv?: FsResolveOptions<Ctx>["projectEnv"];
  /** Resolution config (search dirs, domain launchers). */
  resolve?: FsResolveOptions<Ctx>;
  /** Materialization for single/multi outputs. Defaults provided. */
  materializeSingle?: FsMaterializeSingle<ResultPayload, Ctx>;
  materializeMulti?: FsMaterializeMulti<ResultPayload, Ctx>;
}>;

// ----------------------------- Defaults / heuristics -----------------------------

const DEFAULT_DOMAIN_LAUNCHERS: Readonly<Record<string, DomainLauncher>> = {
  ts: (f) => ["deno", "run", "-A", f] as const,
  py: (f) => ["python", f] as const,
  sh: (f) => ["bash", f] as const,
  rb: (f) => ["ruby", f] as const,
  js: (f) => ["node", f] as const,
};

async function defaultResolveStage<Stage extends FSStageBase = FSStageBase>(
  token: string,
  args: Parameters<NonNullable<FsAdapterOptions["resolveStage"]>>[1],
): Promise<Stage> {
  const sinkPath = (args.found.item as { path: string }).path;
  const dir = dirname(sinkPath);
  const tryPaths = [
    join(dir, token),
    ...((args.searchDirs ?? []).map((d) => join(d, token))),
  ];

  for (const p of tryPaths) {
    try {
      const st = await Deno.stat(p);
      if (st.isFile && (hasExecBit(st.mode) || (await hasShebang(p)))) {
        // readonly argv
        return coerceStage<Stage>({ argv: [p] as const, cwd: dir });
      }
      const ext = extname(p).toLowerCase().replace(/^\./, "");
      const launcher = args.domainLaunchers[ext];
      if (launcher) {
        return coerceStage<Stage>({ argv: launcher(p), cwd: dir });
      }
    } catch {
      // ignore
    }
  }
  // PATH fallback
  return coerceStage<Stage>({ argv: [token] as const, cwd: dir });
}

async function defaultResolveSink<Sink extends FSSinkBase = FSSinkBase>(
  args: Parameters<NonNullable<FsAdapterOptions["resolveSink"]>>[0],
): Promise<Sink> {
  const sinkPath = (args.found.item as { path: string }).path;
  const dir = dirname(sinkPath);
  const st = await Deno.stat(sinkPath);
  if (hasExecBit(st.mode) || (await hasShebang(sinkPath))) {
    return coerceSink<Sink>({ argv: [sinkPath] as const, cwd: dir });
  }
  const ext = extname(sinkPath).toLowerCase().replace(/^\./, "");
  const launcher = args.domainLaunchers[ext];
  if (launcher) {
    return coerceSink<Sink>({ argv: launcher(sinkPath), cwd: dir });
  }
  return coerceSink<Sink>({ argv: [sinkPath] as const, cwd: dir });
}

async function hasShebang(file: string): Promise<boolean> {
  try {
    const f = await Deno.open(file, { read: true });
    try {
      const buf = new Uint8Array(64);
      const n = await f.read(buf);
      if (n && n > 2) {
        const s = new TextDecoder().decode(buf.subarray(0, n));
        return s.startsWith("#!");
      }
      return false;
    } finally {
      f.close();
    }
  } catch {
    return false;
  }
}

function defaultProjectEnv<Ctx>(args: {
  found: CapExecFound<FSWalkSpecNorm, Any, Any>;
  ctx?: Ctx;
  mode?: PrepareMode;
}): Readonly<Record<string, string>> {
  const p = args.found.parsed;
  const sinkPath = (args.found.item as { path: string }).path;
  return {
    CAPEXEC_MODE: args.mode ?? "build",
    CAPEXEC_SINK: sinkPath,
    CAPEXEC_DIR: dirname(sinkPath),
    CAPEXEC_BASENAME: p.basename,
    CAPEXEC_NATURE: p.nature + (p.isMulti ? "+" : ""),
  };
}

// Default materializers (return user-specified ResultPayload; by default returns {} as unknown)
async function defaultMaterializeSingle<ResultPayload>(
  args: Parameters<FsMaterializeSingle<ResultPayload>>[0],
): Promise<ResultPayload> {
  if (args.mode !== "dry-run") {
    await atomicWriteFile(args.suggestedPath, args.output);
  } else {
    // consume stream to avoid hanging producers
    await bytesFromStream(args.output);
  }
  return {} as unknown as ResultPayload;
}

async function defaultMaterializeMulti<ResultPayload>(
  args: Parameters<FsMaterializeMulti<ResultPayload>>[0],
): Promise<ResultPayload> {
  if (args.mode === "dry-run") {
    // drain stream without writing
    await bytesFromStream(args.output);
    return {} as unknown as ResultPayload;
  }

  for await (const line of decodeLinesUtf8(args.output)) {
    const t = line.trim();
    if (!t) continue;
    let rec: {
      path: string;
      content: string;
      encoding?: "utf8" | "base64";
    };
    try {
      rec = JSON.parse(t);
    } catch {
      // ignore invalid lines
      continue;
    }
    const target = join(args.baseDir, rec.path);
    const content = rec.encoding === "base64"
      ? await streamFromBytes(
        Uint8Array.from(atob(rec.content), (c) => c.charCodeAt(0)),
      )
      : await streamFromBytes(new TextEncoder().encode(rec.content));
    await atomicWriteFile(target, content);
  }
  return {} as unknown as ResultPayload;
}

// ---------------------------- FS Output Adapter core ----------------------------

export function createFsOutputAdapter<
  Ctx = unknown,
  Stage extends FSStageBase = FSStageBase,
  Sink extends FSSinkBase = FSSinkBase,
  PrePayload = unknown,
  PostPayload = unknown,
  ResultPayload = unknown,
>(
  options: FsAdapterOptions<
    Ctx,
    Stage,
    Sink,
    PrePayload,
    PostPayload,
    ResultPayload
  > = {},
): CapExecOutputAdapter<
  FSWalkSpecNorm,
  { path: string }, // WalkEntry has .path; we only depend on path here
  unknown,
  Ctx,
  Sink,
  Stage,
  PrePayload,
  PostPayload,
  ResultPayload
> {
  const domainLaunchers = options.resolve?.domainLaunchers ??
    DEFAULT_DOMAIN_LAUNCHERS;
  const stageSearchDirs = options.resolve?.stageSearchDirs ?? [];
  const resolveStage = options.resolveStage ??
    // deno-lint-ignore require-await
    (async (token, args2) =>
      defaultResolveStage<Stage>(token, {
        ...args2,
        searchDirs: stageSearchDirs,
        domainLaunchers,
      }));
  const resolveSink = options.resolveSink ??
    // deno-lint-ignore require-await
    (async (args2) =>
      defaultResolveSink<Sink>({
        ...args2,
        domainLaunchers,
      }));

  const projectEnv = options.projectEnv ?? defaultProjectEnv<Ctx>;

  const materializeSingle = options.materializeSingle ??
    defaultMaterializeSingle<ResultPayload>;
  const materializeMulti = options.materializeMulti ??
    defaultMaterializeMulti<ResultPayload>;

  return {
    kind: "filesystem",
    async prepare(found, init) {
      const { parsed } = found;
      const ctx = init.context as Ctx | undefined;
      const mode = init.mode;

      // Resolve pre stages / sink / post stages
      const preStages: Stage[] = [];
      for (const t of parsed.preStages) {
        preStages.push(
          await resolveStage(t, {
            found,
            ctx,
            mode,
            searchDirs: stageSearchDirs,
            domainLaunchers,
          }),
        );
      }
      const sink = await resolveSink({
        found,
        ctx,
        mode,
        domainLaunchers,
      });

      const postStages: Stage[] = [];
      for (const t of parsed.postStages) {
        postStages.push(
          await resolveStage(t, {
            found,
            ctx,
            mode,
            searchDirs: stageSearchDirs,
            domainLaunchers,
          }),
        );
      }

      const prePayload = options.createPrePayload
        ? await options.createPrePayload({ found, ctx })
        : (undefined as PrePayload | undefined);
      const postPayload = options.createPostPayload
        ? await options.createPostPayload({ found, ctx })
        : (undefined as PostPayload | undefined);

      const pre = createFSPipeline<Stage, Ctx, PrePayload>(
        preStages,
        prePayload,
      );
      const post = createFSPipeline<Stage, Ctx, PostPayload>(
        postStages,
        postPayload,
      );

      const prepared: PreparedCapExec<
        FSWalkSpecNorm,
        { path: string },
        unknown,
        Ctx,
        Sink,
        Stage,
        PrePayload,
        PostPayload
      > = {
        source: found as CapExecFound<
          FSWalkSpecNorm,
          { path: string },
          unknown
        >,
        plan: { pre, sink, post },
        context: ctx,
        mode,
      };

      return prepared;
    },

    async execute(prepared) {
      const { source, plan, context, mode } = prepared;
      const sink = plan.sink as FSSinkBase;

      // Build env overlay once
      const envOverlay = projectEnv({
        found: source,
        ctx: context as Ctx,
        mode,
      });

      // Start with empty input to pre (default: empty stream)
      const empty = await streamFromBytes(new Uint8Array());

      // Run pre → sink → post as a stream chain
      const preOut = await (plan.pre as Pipeline<FSStageBase, Ctx, unknown>)
        .execute(
          empty,
          {
            env: envOverlay,
            context: { ctx: context, payload: plan.pre.payload },
            mode,
          },
        );

      // Run sink
      const sinkOut = await runOneProcess(
        preOut.output,
        sink,
        envOverlay,
      );

      // Run post
      const postOut = await (plan.post as Pipeline<FSStageBase, Ctx, unknown>)
        .execute(sinkOut, {
          env: envOverlay,
          context: { ctx: context, payload: plan.post.payload },
          mode,
        });

      // Materialize based on nature "+" flag (isMulti)
      const isMulti = prepared.source.parsed.isMulti;
      const sinkPath = (prepared.source.item as { path: string }).path;
      const dir = dirname(sinkPath);
      const suggested = join(
        dir,
        `${prepared.source.parsed.basename}.auto.${prepared.source.parsed.nature}`,
      );

      if (isMulti) {
        // Multi: NDJSON mapping by default
        return await (materializeMulti as FsMaterializeMulti<
          ResultPayload
        >)({
          output: postOut.output,
          found: prepared.source,
          ctx: context as Ctx,
          mode,
          baseDir: dir,
        });
      } else {
        return await (materializeSingle as FsMaterializeSingle<
          ResultPayload
        >)({
          output: postOut.output,
          found: prepared.source,
          ctx: context as Ctx,
          mode,
          suggestedPath: suggested,
        });
      }
    },
  };
}

// ---------------------------- Discovery/prepare wrapper ----------------------------

export type FsSpecsSupplier =
  | MaybePromise<AnyIterable<FSWalkSpec>>
  | (() => MaybePromise<AnyIterable<FSWalkSpec>>);

export type PrepareCapExecsFsInit<
  Ctx = unknown,
  Stage extends FSStageBase = FSStageBase,
  Sink extends FSSinkBase = FSSinkBase,
  PrePayload = unknown,
  PostPayload = unknown,
  ResultPayload = unknown,
> = Readonly<{
  /** File-walk specs supplier (array/generator/async generator or function returning one). */
  specs: FsSpecsSupplier;
  /** Adapter options (resolvers, materializers, env projection). */
  adapter?: FsAdapterOptions<
    Ctx,
    Stage,
    Sink,
    PrePayload,
    PostPayload,
    ResultPayload
  >;
  /** Orchestrator options: */
  context?: Ctx;
  mode?: PrepareMode;
  run?: boolean;
  onError?: "abort" | "skip";
  logger?: (e: {
    level: "debug" | "info" | "warn" | "error";
    msg: string;
    meta?: Record<string, unknown>;
  }) => void;
}>;

/**
 * Typical "one-liner" entrypoint for filesystem CapExecs:
 *  - Walk FS for CapExec sinks
 *  - Prepare (and optionally execute) via the FS adapter
 *  - Yield prepared/executed results (generic over your context and result payload)
 */
export async function* prepareCapExecsFs<
  Ctx = unknown,
  Stage extends FSStageBase = FSStageBase,
  Sink extends FSSinkBase = FSSinkBase,
  PrePayload = unknown,
  PostPayload = unknown,
  ResultPayload = unknown,
>(
  init: PrepareCapExecsFsInit<
    Ctx,
    Stage,
    Sink,
    PrePayload,
    PostPayload,
    ResultPayload
  >,
): AsyncGenerator<
  PreparedOrExecuted<
    FSWalkSpecNorm,
    { path: string },
    unknown,
    Ctx,
    Sink,
    Stage,
    PrePayload,
    PostPayload,
    ResultPayload
  >,
  void,
  unknown
> {
  const fsAdapter = createFSAdapter<{ relPath: string }>(); // FS walker payload default (relPath)
  const selectName = (enc: FSEncountered<{ relPath: string }>) =>
    basename(enc.item.path);

  const supplier: CapExecSupplier<FSWalkSpecNorm, { path: string }, unknown> =
    async function* () {
      // Walk FS via walkCapExecs
      const specs = typeof init.specs === "function"
        ? await init.specs()
        : await init.specs;
      const bundle = {
        adapter: fsAdapter,
        specs,
        selectName,
      } as const;

      for await (const found of walkCapExecs(bundle)) {
        // Keep item shape minimal: { path }
        yield {
          ...found,
          item: { path: (found.item as Any).path },
        } as CapExecFound<FSWalkSpecNorm, { path: string }, unknown>;
      }
    };

  const adapter = createFsOutputAdapter<
    Ctx,
    Stage,
    Sink,
    PrePayload,
    PostPayload,
    ResultPayload
  >(init.adapter);

  yield* prepareCapExecs<
    FSWalkSpecNorm,
    { path: string },
    unknown,
    Ctx,
    Sink,
    Stage,
    PrePayload,
    PostPayload,
    ResultPayload
  >(supplier, {
    adapter,
    context: init.context,
    mode: init.mode ?? "build",
    run: init.run ?? true,
    onError: init.onError ?? "abort",
    logger: init.logger,
  });
}
