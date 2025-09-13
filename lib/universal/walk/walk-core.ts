// deno-lint-ignore no-explicit-any
type Any = any;

/** A key that uniquely identifies an item across a run (used for de-dup). */
export type Key = string;

/** A flexible supplier that can yield specs via sync/async iterables. */
export type AnyIterable<T> = Iterable<T> | AsyncIterable<T>;
export type MaybePromise<T> = T | Promise<T>;
export type SpecSupplier<Spec> =
    | MaybePromise<AnyIterable<Spec>>
    | (() => MaybePromise<AnyIterable<Spec>>);

/** Optional payload attached to each encountered item. */
type WithPayload<P, T> = P extends undefined ? T : T & { readonly payload: P };

/**
 * The *normalized* form of a source spec, specific to each adapter.
 * Adapters choose what they need (e.g., absRoot for FS, DSN for DB, base URL for API).
 */
export type NormalizedSpec<SpecNorm extends object> = Readonly<SpecNorm>;

/**
 * Strongly typed description of an encountered item.
 * - `K`: unique Key (dedupe)
 * - `I`: the adapter's raw item metadata
 * - `S`: the adapter's normalized spec type
 * - `P`: optional payload
 */
export type Encountered<
    I,
    S extends object,
    P = undefined,
> = WithPayload<P, Readonly<{ key: Key; spec: NormalizedSpec<S>; item: I }>>;

/**
 * Adapter contract: implement this once per source type (FS, DB, API).
 * It gives the walker everything it needs without knowing transport details.
 */
export interface WalkerAdapter<
    Spec, // user-facing spec (e.g., FS root config)
    SpecNorm extends object, // normalized spec (e.g., absRoot + compiled globs)
    Item, // raw item type emitted by the adapter
    P = undefined, // optional payload type (per encountered item)
> {
    /** Human-readable kind, used for logs/diagnostics. */
    readonly kind: string;

    /**
     * Normalize a user-facing spec into an adapter-specific normalized structure.
     * Throw on invalid specs.
     */
    normalize(spec: Spec): Promise<SpecNorm>;

    /**
     * Enumerate items for a normalized spec.
     * Must yield each item at most once for that spec.
     */
    list(spec: SpecNorm): AsyncIterable<Item>;

    /**
     * Derive a unique key for the item (e.g., absolute path, tuple(table,pk), URL).
     * Used for global de-duplication across *all* specs in a run.
     */
    keyOf(spec: SpecNorm, item: Item): Key;

    /**
     * Optional payload producer (constant or per-item). If omitted, no payload is attached.
     * This keeps payload logic co-located with adapter-specific item metadata.
     */
    payload?(
        ctx: Readonly<{ spec: SpecNorm; item: Item }>,
    ): P | Promise<P>;
}

/** Walker options shared by all adapters. */
export type WalkerOptions<Spec> = Readonly<{
    specs: SpecSupplier<Spec>;
    /** Optional hook for specs the adapter rejects (e.g., non-existent FS root). */
    onInvalidSpec?: (
        details: { kind: string; reason: string },
    ) => void | Promise<void>;
}>;

/** Utility: turn sync/async iterables (or promised) into an AsyncIterable. */
export async function* toAsyncIterable<T>(
    src: MaybePromise<AnyIterable<T>>,
): AsyncIterable<T> {
    const value: Any = await src;
    if (value && typeof value[Symbol.asyncIterator] === "function") {
        yield* value as AsyncIterable<T>;
    } else {
        yield* value as Iterable<T>;
    }
}

/**
 * Generic walker: yields strongly-typed Encountered<> records for *any* adapter.
 *
 * @example
 * for await (const e of walk({ specs, onInvalidSpec }, fsAdapter)) {
 *   console.log(e.key, e.item);
 * }
 */
export async function* walk<
    Spec,
    SpecNorm extends object,
    Item,
    P = undefined,
>(
    opts: WalkerOptions<Spec>,
    adapter: WalkerAdapter<Spec, SpecNorm, Item, P>,
): AsyncGenerator<Encountered<Item, SpecNorm, P>, void, unknown> {
    const seen = new Set<Key>();

    const specs = typeof opts.specs === "function" ? opts.specs() : opts.specs;
    for await (const spec of toAsyncIterable(specs)) {
        let norm: SpecNorm;
        try {
            norm = await adapter.normalize(spec);
        } catch (err) {
            await opts.onInvalidSpec?.({
                kind: adapter.kind,
                reason: (err instanceof Error ? err.message : String(err)),
            });
            continue;
        }

        for await (const item of adapter.list(norm)) {
            const key = adapter.keyOf(norm, item);
            if (seen.has(key)) continue;
            seen.add(key);

            let payload: P | undefined = undefined;
            if (adapter.payload) {
                payload = await adapter.payload({ spec: norm, item });
            }

            const base = {
                key,
                spec: norm,
                item,
            } as const;

            const encountered = (payload === undefined
                ? base
                : { ...base, payload }) as Encountered<Item, SpecNorm, P>;

            yield encountered;
        }
    }
}
