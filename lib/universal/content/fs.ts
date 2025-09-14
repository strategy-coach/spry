/**
 * fs.ts
 * Filesystem adapter: FileContent extends Content, implemented for Deno.
 */

import {
    dirname,
    extname,
    isAbsolute,
    resolve,
    toFileUrl,
} from "jsr:@std/path@1";
import type {
    CapabilityFlags,
    Content,
    ContentChecksum,
    DefaultPermissions,
    DefaultProvenance,
    GovernanceBase,
    ReadOpts,
    WriteOpts,
} from "./core.ts";
import { asReadableUint8 } from "./core.ts";

export type FileDefaultNature = "text" | "binary";

// Optional governance extension for FS
export type FSGovernance<
    A = Record<string, unknown>,
    Prov = DefaultProvenance,
    Perm = DefaultPermissions,
    TTags extends readonly string[] = readonly string[],
> = GovernanceBase<A, Prov, Perm, TTags> & {
    readonly baseDir?: string;
    readonly rel?: string;
    readonly policy?: {
        readonly detectTextByExtension?: boolean; // default true
        readonly defaultEncoding?: string; // default "utf-8"
    };
};

// FileContent extends the generic Content with path-aware fields
export interface FileContent<
    Nature extends string = FileDefaultNature,
    A = Record<string, unknown>,
    Prov = DefaultProvenance,
    Perm = DefaultPermissions,
    TTags extends readonly string[] = readonly string[],
    G extends FSGovernance<A, Prov, Perm, TTags> = FSGovernance<
        A,
        Prov,
        Perm,
        TTags
    >,
    Payload = unknown,
> extends Content<Nature, A, Prov, Perm, TTags, G, Payload> {
    readonly path: string; // absolute path
    readonly baseDir?: string;
    readonly rel?: string; // relative to baseDir (if provided)
}

const TEXT_EXT = new Set([
    ".txt",
    ".md",
    ".markdown",
    ".gitignore",
    ".csv",
    ".tsv",
    ".json",
    ".jsonl",
    ".yaml",
    ".yml",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".css",
    ".scss",
    ".html",
    ".xml",
    ".sql",
    ".sh",
    ".bash",
    ".zsh",
    ".cfg",
    ".ini",
    ".toml",
]);

function detectNatureFromPath(path: string): FileDefaultNature {
    const ext = extname(path).toLowerCase();
    return TEXT_EXT.has(ext) ? "text" : "binary";
}

type CreateFileContentKnown = {
    readonly size?: number;
    readonly modifiedAt?: Date;
    readonly etag?: string;
    readonly checksum?: ContentChecksum;
    // deno-lint-ignore ban-types
    readonly nature?: FileDefaultNature | (string & {});
    readonly capabilities?: CapabilityFlags;
};

export function createFileContent<
    Nature extends string = FileDefaultNature,
    A = Record<string, unknown>,
    Prov = DefaultProvenance,
    Perm = DefaultPermissions,
    TTags extends readonly string[] = readonly string[],
    G extends FSGovernance<A, Prov, Perm, TTags> = FSGovernance<
        A,
        Prov,
        Perm,
        TTags
    >,
    Payload = unknown,
>(args: {
    contentId: string;
    path: string; // absolute preferred; will be resolved if not
    baseDir?: string;
    rel?: string;
    governance?: G;
    payload?: Payload;
    sourceRef?: { system?: string; scope?: string; id?: string };
    known?: CreateFileContentKnown;
}): FileContent<Nature, A, Prov, Perm, TTags, G, Payload> {
    const absPath = isAbsolute(args.path) ? args.path : resolve(args.path);
    const uri = toFileUrl(absPath).href;
    const scheme = "file";
    const baseDir = args.baseDir;
    const rel = args.rel;
    const gov = (args.governance ?? {}) as G;
    const policy = gov.policy ?? {};
    const defaultEncoding = policy.defaultEncoding ?? "utf-8";

    let closed = false;
    let lastOpen: Deno.FsFile | null = null;

    // deno-lint-ignore require-await
    async function ensureClosed() {
        if (lastOpen) {
            try {
                lastOpen.close();
            } catch {
                /* noop */
            } finally {
                lastOpen = null;
            }
        }
    }

    async function openForRead(
        range?: ReadOpts["range"],
    ): Promise<ReadableStream<Uint8Array>> {
        if (closed) throw new Error("FileContent is closed");
        const file = await Deno.open(absPath, { read: true });
        lastOpen = file;
        let readable = asReadableUint8(file.readable);

        // Optional ranged read (stream-level slicing)
        if (range && (range.start ?? 0) > 0) {
            const start = range.start!;
            const end = range.end; // optional exclusive
            let offset = 0;

            const slicer = new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                    if (end !== undefined && offset >= end) return;
                    const nextOffset = offset + chunk.byteLength;

                    if (nextOffset <= start) {
                        // Entire chunk is before start: skip
                        offset = nextOffset;
                        return;
                    }

                    let s = 0, e = chunk.byteLength;
                    if (offset < start && nextOffset > start) {
                        s = start - offset;
                    }
                    if (end !== undefined && nextOffset > end) {
                        e = Math.max(0, e - (nextOffset - end));
                    }

                    const slice = chunk.subarray(s, e);
                    offset = nextOffset;
                    if (slice.byteLength > 0) controller.enqueue(slice);
                },
            });
            readable = readable.pipeThrough(slicer);
        }

        // Auto-close handle when stream flushes/errors
        readable = readable.pipeThrough(
            new TransformStream({
                flush: async () => {
                    await ensureClosed();
                },
            }),
        );

        return readable;
    }

    async function openForWrite(
        opts?: WriteOpts,
    ): Promise<WritableStream<Uint8Array>> {
        if (closed) throw new Error("FileContent is closed");
        const truncate = opts?.append ? false : (opts?.truncate ?? true);
        // Ensure directory exists
        await Deno.mkdir(dirname(absPath), { recursive: true }).catch(() => {});
        const file = await Deno.open(absPath, {
            write: true,
            create: true,
            append: !!opts?.append,
            truncate,
        });
        lastOpen = file;

        const sink = new WritableStream<Uint8Array>({
            async write(chunk) {
                await file.write(chunk);
            },
            async close() {
                await ensureClosed();
            },
            async abort() {
                await ensureClosed();
            },
        });
        return sink;
    }

    async function readBytes(opts?: ReadOpts): Promise<Uint8Array> {
        const rs = await openForRead(opts?.range);
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

    async function readText(
        encoding = defaultEncoding,
        opts?: ReadOpts,
    ): Promise<string> {
        const bytes = await readBytes(opts);
        return new TextDecoder(encoding).decode(bytes);
    }

    async function writeBytes(
        bytes: Uint8Array,
        opts?: WriteOpts,
    ): Promise<void> {
        const ws = await openForWrite(opts);
        const writer = ws.getWriter();
        await writer.write(bytes);
        await writer.close();
    }

    async function writeText(
        text: string,
        _encoding = defaultEncoding,
        opts?: WriteOpts,
    ): Promise<void> {
        const bytes = new TextEncoder().encode(text);
        await writeBytes(bytes, opts);
    }

    async function pipeThrough(
        transforms: readonly TransformStream<Uint8Array, Uint8Array>[],
        opts?: ReadOpts,
    ): Promise<ReadableStream<Uint8Array>> {
        let rs = await openForRead(opts?.range);
        for (const t of transforms) rs = rs.pipeThrough(t);
        return rs;
    }

    async function close(): Promise<void> {
        closed = true;
        await ensureClosed();
    }

    const computedNature = ((): Nature => {
        if (args.known?.nature) return args.known.nature as Nature;
        const auto = policy.detectTextByExtension ?? true;
        return (auto ? detectNatureFromPath(absPath) : "binary") as Nature;
    })();

    const capabilities: CapabilityFlags = {
        rangeReads: true,
        randomAccess: false,
        atomicWrite: false,
        ...(args.known?.capabilities ?? {}),
    };

    return {
        // identity
        contentId: args.contentId,
        uri,
        scheme,
        sourceRef: args.sourceRef,

        // classification/extensibility
        nature: computedNature,
        governance: gov,
        payload: args.payload,

        // hints
        capabilities,
        size: args.known?.size,
        etag: args.known?.etag,
        modifiedAt: args.known?.modifiedAt,
        checksum: args.known?.checksum,

        // fs fields
        path: absPath,
        baseDir,
        rel,

        // API
        getReadable: (opts?: ReadOpts) => openForRead(opts?.range),
        getWritable: (opts?: WriteOpts) => openForWrite(opts),
        readBytes,
        readText,
        writeBytes,
        writeText,
        pipeThrough,
        close,
    };
}
