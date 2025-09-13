// capexec-prepare.ts
import {
    type AnyIterable,
    type MaybePromise,
    toAsyncIterable,
} from "../walk/mod.ts"; // re-exported from walk-core.ts
import { type CapExecFound } from "./walk.ts";

/* ------------------------------ Core aliases ------------------------------ */

/** Byte stream flowing through pre → sink → post. */
export type ContentStream = ReadableStream<Uint8Array>;

/** Build/prepare mode for CapExec runs. */
export type PrepareMode = "build" | "watch" | "dry-run";

/* --------------------------- Context & Pipeline --------------------------- */

/**
 * Execution context made available to pipelines and sinks.
 * - `ctx`     : your validated run context (typesafe, e.g., Zod-inferred)
 * - `payload` : pipeline-scoped payload (shared variables/state for that pipeline)
 */
export type ContentContext<Ctx, Payload> = Readonly<{
    ctx?: Ctx;
    payload?: Payload;
}>;

/**
 * A generic, strongly typed pipeline that transforms an input byte stream into an output byte stream.
 *
 * Generics:
 *  - `Stage`   : adapter-defined stage descriptor (argv, function, container spec, etc.)
 *  - `Ctx`     : validated run context type
 *  - `Payload` : pipeline-scoped payload type shared across stages of this pipeline
 */
export interface Pipeline<Stage, Ctx = unknown, Payload = unknown> {
    /**
     * Ordered description of the stages that compose this pipeline.
     * Accepts arrays, generators, and async generators.
     */
    readonly stages: AnyIterable<Stage>;

    /** Strongly-typed pipeline payload (shared variables/state). */
    readonly payload?: Payload;

    /**
     * Execute the pipeline: `input` → [ stages ] → `output`.
     * The adapter implements chaining behavior and honors `mode` + `context`.
     */
    execute(
        input: ContentStream,
        args: Readonly<{
            mode?: PrepareMode;
            context?: ContentContext<Ctx, Payload>;
            env?: Readonly<Record<string, string>>;
        }>,
    ): Promise<Readonly<{ output: ContentStream }>>;
}

/* ------------------------ Prepared plan & execution ----------------------- */

/**
 * The prepared, immutable execution plan for one CapExec sink.
 *
 * Generics:
 *  - `SpecNorm`     : adapter’s normalized spec (e.g., FSWalkSpecNorm)
 *  - `Item`         : adapter’s raw item (e.g., WalkEntry)
 *  - `WalkPayload`  : payload attached by the walker (if any)
 *  - `Ctx`          : validated run context type
 *  - `Executable`   : adapter-defined descriptor for the sink itself
 *  - `Stage`        : stage descriptor used by pre/post pipelines
 *  - `PrePayload`   : pre-pipeline payload type
 *  - `PostPayload`  : post-pipeline payload type
 */
export type PreparedCapExec<
    SpecNorm extends object,
    Item,
    WalkPayload,
    Ctx = unknown,
    Executable = unknown,
    Stage = unknown,
    PrePayload = unknown,
    PostPayload = unknown,
> = Readonly<{
    /** Source discovered by the walker & parser. */
    source: CapExecFound<SpecNorm, Item, WalkPayload>;

    /** Immutable plan to execute (pre → sink → post). */
    plan: Readonly<{
        /** Pre-pipeline: produces STDIN for the sink. */
        pre: Pipeline<Stage, Ctx, PrePayload>;
        /** The sink executable itself (adapter-defined semantics). */
        sink: Executable;
        /** Post-pipeline: transforms sink STDOUT into final output stream. */
        post: Pipeline<Stage, Ctx, PostPayload>;
    }>;

    /** Context snapshot available to pre/sink/post (read-only). */
    context?: Ctx;

    /** Mode hint (e.g., skip writes in dry-run). */
    mode?: PrepareMode;
}>;

/**
 * Fully generic execution result. Define your own result payload shape per adapter.
 * Examples:
 *  - `{ kind: "single"; target: string; bytesWritten?: number }`
 *  - `{ kind: "multi"; manifest?: string; files: { path: string }[] }`
 *  - `{ ok: true; stats: {...} }`
 */
export type ExecuteResult<ResultPayload> = Readonly<ResultPayload>;

/* ------------------------ Output adapter abstraction ---------------------- */

/**
 * CapExec Output Adapter:
 *   PREPARE: resolve pre/sink/post and produce a plan with `Pipeline`s
 *   EXECUTE: stream bytes through pre → sink → post, then materialize outputs
 *
 * All non-essential details (targets, limits, metadata) are left to your generics.
 */
export interface CapExecOutputAdapter<
    SpecNorm extends object,
    Item,
    WalkPayload,
    Ctx = unknown,
    Executable = unknown,
    Stage = unknown,
    PrePayload = unknown,
    PostPayload = unknown,
    ResultPayload = unknown,
> {
    readonly kind: string;

    prepare(
        found: CapExecFound<SpecNorm, Item, WalkPayload>,
        init: Readonly<{ context?: Ctx; mode?: PrepareMode }>,
    ): Promise<
        PreparedCapExec<
            SpecNorm,
            Item,
            WalkPayload,
            Ctx,
            Executable,
            Stage,
            PrePayload,
            PostPayload
        >
    >;

    execute(
        prepared: PreparedCapExec<
            SpecNorm,
            Item,
            WalkPayload,
            Ctx,
            Executable,
            Stage,
            PrePayload,
            PostPayload
        >,
    ): Promise<ExecuteResult<ResultPayload>>;
}

/* ----------------------- Prepare & execute orchestrator ------------------- */

/**
 * Supplier of CapExec sources discovered by `walkCapExecs`.
 * Accepts:
 *  - AsyncIterable/Iterable of `CapExecFound`
 *  - A function returning (maybe promised) AsyncIterable/Iterable
 */
export type CapExecSupplier<SpecNorm extends object, Item, WalkPayload> =
    | MaybePromise<AnyIterable<CapExecFound<SpecNorm, Item, WalkPayload>>>
    | (() => MaybePromise<
        AnyIterable<CapExecFound<SpecNorm, Item, WalkPayload>>
    >);

export type PrepareCapExecsInit<
    SpecNorm extends object,
    Item,
    WalkPayload,
    Ctx = unknown,
    Executable = unknown,
    Stage = unknown,
    PrePayload = unknown,
    PostPayload = unknown,
    ResultPayload = unknown,
> = Readonly<{
    adapter: CapExecOutputAdapter<
        SpecNorm,
        Item,
        WalkPayload,
        Ctx,
        Executable,
        Stage,
        PrePayload,
        PostPayload,
        ResultPayload
    >;
    context?: Ctx;
    mode?: PrepareMode;
    run?: boolean; // default: true
    onError?: "abort" | "skip"; // default: "abort"
    logger?: (e: {
        level: "debug" | "info" | "warn" | "error";
        msg: string;
        meta?: Record<string, unknown>;
    }) => void;
}>;

export type PreparedOrExecuted<
    SpecNorm extends object,
    Item,
    WalkPayload,
    Ctx = unknown,
    Executable = unknown,
    Stage = unknown,
    PrePayload = unknown,
    PostPayload = unknown,
    ResultPayload = unknown,
> =
    | Readonly<{
        phase: "prepared";
        prepared: PreparedCapExec<
            SpecNorm,
            Item,
            WalkPayload,
            Ctx,
            Executable,
            Stage,
            PrePayload,
            PostPayload
        >;
    }>
    | Readonly<{
        phase: "executed";
        prepared: PreparedCapExec<
            SpecNorm,
            Item,
            WalkPayload,
            Ctx,
            Executable,
            Stage,
            PrePayload,
            PostPayload
        >;
        result: ExecuteResult<ResultPayload>;
    }>;

/**
 * Iterate CapExec sources, prepare via the adapter, and (optionally) execute.
 * Yields either a "prepared" item or an "executed" item per source.
 */
export async function* prepareCapExecs<
    SpecNorm extends object,
    Item,
    WalkPayload,
    Ctx = unknown,
    Executable = unknown,
    Stage = unknown,
    PrePayload = unknown,
    PostPayload = unknown,
    ResultPayload = unknown,
>(
    supplier: CapExecSupplier<SpecNorm, Item, WalkPayload>,
    init: PrepareCapExecsInit<
        SpecNorm,
        Item,
        WalkPayload,
        Ctx,
        Executable,
        Stage,
        PrePayload,
        PostPayload,
        ResultPayload
    >,
): AsyncGenerator<
    PreparedOrExecuted<
        SpecNorm,
        Item,
        WalkPayload,
        Ctx,
        Executable,
        Stage,
        PrePayload,
        PostPayload,
        ResultPayload
    >,
    void,
    unknown
> {
    const {
        adapter,
        context,
        mode = "build",
        run = true,
        onError = "abort",
        logger,
    } = init;

    const iterable = typeof supplier === "function"
        ? await supplier()
        : await supplier;

    for await (const found of toAsyncIterable(iterable)) {
        try {
            const prepared = await adapter.prepare(found, { context, mode });
            yield { phase: "prepared", prepared };

            if (run) {
                const started = performance.now?.() ?? Date.now();
                const result = await adapter.execute(prepared);
                const ended = performance.now?.() ?? Date.now();

                logger?.({
                    level: "info",
                    msg: "capexec.executed",
                    meta: {
                        kind: adapter.kind,
                        name: prepared.source.name,
                        elapsedMs: ended - started,
                    },
                });

                yield { phase: "executed", prepared, result };
            }
        } catch (err) {
            logger?.({
                level: "error",
                msg: "capexec.error",
                meta: {
                    kind: adapter.kind,
                    name: (found as { name?: string })?.name,
                    error: err instanceof Error ? err.message : String(err),
                },
            });
            if (onError === "abort") throw err;
            // else skip and continue
        }
    }
}
