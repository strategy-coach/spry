/**
 * core.ts
 * Standalone, stream-first content abstraction with fully generic, type-safe governance.
 * No dependency on the walker/traversal layer.
 */

// deno-lint-ignore no-explicit-any
type Any = any;

export type DefaultProvenance = {
    readonly source?: string; // e.g., "fs", "http", "git"
    readonly collectedAt?: Date;
    readonly agent?: string; // producer identifier/version
};

export type DefaultPermissions = {
    readonly canRead?: boolean;
    readonly canWrite?: boolean;
};

export type ReadRange = { start: number; end?: number };
export type ReadOpts = { range?: ReadRange };
export type WriteOpts = { truncate?: boolean; append?: boolean };

export type CapabilityFlags = {
    readonly rangeReads?: boolean;
    readonly randomAccess?: boolean;
    readonly atomicWrite?: boolean;
};

export type ContentChecksum = {
    readonly alg: "sha256" | "sha1" | "md5";
    readonly value: string;
};

/**
 * Generic, type-safe governance base. Plug in your own types:
 *  - Annotations (structured)
 *  - Provenance (e.g., lineage, datasetId, commit)
 *  - Permissions (IAM shape)
 *  - Tags (literal union array)
 */
export type GovernanceBase<
    Annotations = Record<string, unknown>,
    Provenance = DefaultProvenance,
    Permissions = DefaultPermissions,
    Tags extends readonly string[] = readonly string[],
> = {
    readonly tags?: Tags;
    readonly annotations?: Annotations;
    readonly provenance?: Provenance;
    readonly permissions?: Permissions;
};

export type DefaultNature = "text" | "binary";

/**
 * Content is independent of traversal. It models a single streamable artifact.
 * Everything here is environment-agnostic (Web Streams).
 */
export interface Content<
    Nature extends string = DefaultNature,
    Anno = Record<string, unknown>,
    Prov = DefaultProvenance,
    Perm = DefaultPermissions,
    TTags extends readonly string[] = readonly string[],
    Governance extends GovernanceBase<Anno, Prov, Perm, TTags> = GovernanceBase<
        Anno,
        Prov,
        Perm,
        TTags
    >,
    Payload = unknown,
> {
    // Identity & location
    readonly contentId: string; // stable within the producing system
    readonly uri: string; // canonical locator (file://, https://, etc.)
    readonly scheme: string; // "file", "http", "git", "s3", ...
    readonly sourceRef?: { // optional linkage back to a producer
        readonly system?: string;
        readonly scope?: string;
        readonly id?: string;
    };

    // Classification & extensions
    readonly nature: Nature;
    readonly governance: Governance;
    readonly payload?: Payload;

    // Capabilities & hints (may be unknown)
    readonly capabilities?: CapabilityFlags;
    readonly size?: number;
    readonly etag?: string;
    readonly modifiedAt?: Date;
    readonly checksum?: ContentChecksum;

    // Streaming primitives (Web Streams)
    getReadable(opts?: ReadOpts): Promise<ReadableStream<Uint8Array>>;
    getWritable(opts?: WriteOpts): Promise<WritableStream<Uint8Array>>;

    // Ergonomics
    readBytes(opts?: ReadOpts): Promise<Uint8Array>;
    readText(encoding?: string, opts?: ReadOpts): Promise<string>;
    writeBytes(bytes: Uint8Array, opts?: WriteOpts): Promise<void>;
    writeText(text: string, encoding?: string, opts?: WriteOpts): Promise<void>;
    pipeThrough(
        transforms: readonly TransformStream<Uint8Array, Uint8Array>[],
        opts?: ReadOpts,
    ): Promise<ReadableStream<Uint8Array>>;

    // Lifecycle
    close(): Promise<void>;
}

// Narrow only the Nature while preserving all other generics (including G)
export function isText<
    A,
    Prov,
    Perm,
    TTags extends readonly string[],
    G extends GovernanceBase<A, Prov, Perm, TTags>,
    P,
>(
    c: Content<string, A, Prov, Perm, TTags, G, P>,
): c is Content<"text", A, Prov, Perm, TTags, G, P> {
    return (c.nature as string) === "text";
}

export function isBinary<
    A,
    Prov,
    Perm,
    TTags extends readonly string[],
    G extends GovernanceBase<A, Prov, Perm, TTags>,
    P,
>(
    c: Content<string, A, Prov, Perm, TTags, G, P>,
): c is Content<"binary", A, Prov, Perm, TTags, G, P> {
    return (c.nature as string) === "binary";
}

/**
 * Portable, JSON-safe descriptor (no streams) for persisting references.
 * A resolver in your app can revive a live Content from this.
 */
export type ContentDescriptor = {
    readonly contentId: string;
    readonly uri: string;
    readonly scheme: string;
    readonly nature: string;
    readonly governance?: unknown; // snapshot (optional)
    readonly hints?: {
        readonly size?: number;
        readonly etag?: string;
        readonly modifiedAt?: string; // ISO
        readonly checksum?: ContentChecksum;
        readonly capabilities?: CapabilityFlags;
    };
    readonly adapter?: { name: string; data?: unknown };
};

export type AdapterResolver = (
    desc: ContentDescriptor,
) => Promise<Content<Any, Any, Any, Any, Any, Any, Any>>;

/** Optional helpers for codecs/transforms can live in a separate utils module. */
export async function streamToUint8Array(
    rs: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
    const reader = rs.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
        out.set(c, o);
        o += c.byteLength;
    }
    return out;
}

export function asReadableUint8(rs: ReadableStream<unknown>) {
    return rs as unknown as ReadableStream<Uint8Array>;
}
