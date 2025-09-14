/**
 * content/typical.ts
 * Friendly DX wrappers that keep the power of the generic core,
 * while giving "just works" helpers for common cases.
 */

import {
    type Content,
    type DefaultPermissions,
    type DefaultProvenance,
    type GovernanceBase,
    type ReadOpts,
    type WriteOpts,
} from "./core.ts";
import {
    createFileContent,
    type FileContent,
    type FSGovernance,
} from "./fs.ts";

// ---------- Opinionated aliases (general) ----------

/** Typical, general-purpose governance with default shapes. */
export type TypicalGovernance = GovernanceBase<
    Record<string, unknown>,
    DefaultProvenance,
    DefaultPermissions
>;

/** Typical Content (text or binary), with default governance and unknown payload. */
export type TypicalContent = Content<
    "text" | "binary",
    Record<string, unknown>,
    DefaultProvenance,
    DefaultPermissions
>;

// ---------- Opinionated aliases (filesystem) ----------

/** Typical FS governance (adds optional policy) with default shapes. */
export type TypicalFsGovernance = FSGovernance<
    Record<string, unknown>,
    DefaultProvenance,
    DefaultPermissions
>;

/** Typical FS Content (text or binary), with default governance and unknown payload. */
export type TypicalFsContent = FileContent<
    "text" | "binary",
    Record<string, unknown>,
    DefaultProvenance,
    DefaultPermissions
>;

// ---------- Governance presets (FS) ----------

/** UTF-8 default; auto-detect text by extension. */
export function withUtf8(): TypicalFsGovernance {
    return {
        policy: { defaultEncoding: "utf-8", detectTextByExtension: true },
    };
}

/** No extension detection; treat as binary by default unless overridden. */
export function withNoDetect(): TypicalFsGovernance {
    return {
        policy: { detectTextByExtension: false, defaultEncoding: "utf-8" },
    };
}

// ---------- Open helpers (FS) ----------

/** Open a file with sensible defaults (UTF-8, extension-based detection). */
// deno-lint-ignore require-await
export async function openFile(path: string, opts?: {
    contentId?: string;
    governance?: TypicalFsGovernance;
    baseDir?: string;
    rel?: string;
}): Promise<TypicalFsContent> {
    const g = opts?.governance ?? withUtf8();
    const fc = createFileContent<
        TypicalFsContent["nature"],
        Record<string, unknown>,
        DefaultProvenance,
        DefaultPermissions,
        readonly string[],
        TypicalFsGovernance
    >({
        contentId: opts?.contentId ?? path,
        path,
        baseDir: opts?.baseDir,
        rel: opts?.rel,
        governance: g,
    }) as TypicalFsContent;
    return fc;
}

/** Force nature to "text" regardless of extension. */
// deno-lint-ignore require-await
export async function openTextFile(path: string, opts?: {
    contentId?: string;
    governance?: TypicalFsGovernance;
    baseDir?: string;
    rel?: string;
}): Promise<FileContent<"text">> {
    const g = opts?.governance ?? withUtf8();
    const fc = createFileContent<
        "text",
        Record<string, unknown>,
        DefaultProvenance,
        DefaultPermissions,
        readonly string[],
        TypicalFsGovernance
    >({
        contentId: opts?.contentId ?? path,
        path,
        baseDir: opts?.baseDir,
        rel: opts?.rel,
        governance: g,
        known: { nature: "text" },
    });
    return fc;
}

/** Force nature to "binary" regardless of extension. */
// deno-lint-ignore require-await
export async function openBinaryFile(path: string, opts?: {
    contentId?: string;
    governance?: TypicalFsGovernance;
    baseDir?: string;
    rel?: string;
}): Promise<FileContent<"binary">> {
    const g = opts?.governance ?? withNoDetect();
    const fc = createFileContent<
        "binary",
        Record<string, unknown>,
        DefaultProvenance,
        DefaultPermissions,
        readonly string[],
        TypicalFsGovernance
    >({
        contentId: opts?.contentId ?? path,
        path,
        baseDir: opts?.baseDir,
        rel: opts?.rel,
        governance: g,
        known: { nature: "binary" },
    });
    return fc;
}

// ---------- Friendly read/write helpers ----------

// deno-lint-ignore require-await
export async function readAllText(
    c: Pick<Content, "readText">,
    encoding?: string,
    opts?: ReadOpts,
): Promise<string> {
    return c.readText(encoding, opts);
}

// deno-lint-ignore require-await
export async function readAllBytes(
    c: Pick<Content, "readBytes">,
    opts?: ReadOpts,
): Promise<Uint8Array> {
    return c.readBytes(opts);
}

// deno-lint-ignore require-await
export async function writeAllText(
    c: Pick<Content, "writeText">,
    text: string,
    opts?: WriteOpts & { encoding?: string },
): Promise<void> {
    return c.writeText(text, opts?.encoding ?? "utf-8", opts);
}

// deno-lint-ignore require-await
export async function writeAllBytes(
    c: Pick<Content, "writeBytes">,
    bytes: Uint8Array,
    opts?: WriteOpts,
): Promise<void> {
    return c.writeBytes(bytes, opts);
}

/** Pipe through a list of TransformStreams; returns the resulting readable. */
// deno-lint-ignore require-await
export async function pipe(
    c: Pick<Content, "pipeThrough">,
    transforms: readonly TransformStream<Uint8Array, Uint8Array>[],
    opts?: ReadOpts,
): Promise<ReadableStream<Uint8Array>> {
    return c.pipeThrough(transforms, opts);
}

// ---------- Lightweight FileContent builder ----------

type KnownOpts = {
    size?: number;
    modifiedAt?: Date;
    etag?: string;
    checksum?: { alg: "sha256" | "sha1" | "md5"; value: string };
    // deno-lint-ignore ban-types
    nature?: "text" | "binary" | (string & {});
};

export class FileContentBuilder<
    N extends string = "text" | "binary",
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
    P = unknown,
> {
    private _contentId!: string;
    private _path!: string;
    private _baseDir?: string;
    private _rel?: string;
    private _governance?: G;
    private _payload?: P;
    private _known?: KnownOpts;

    id(id: string) {
        this._contentId = id;
        return this;
    }
    path(p: string) {
        this._path = p;
        return this;
    }
    baseDir(b: string) {
        this._baseDir = b;
        return this;
    }
    rel(r: string) {
        this._rel = r;
        return this;
    }
    governance(g: G) {
        this._governance = g;
        return this;
    }
    payload(p: P) {
        this._payload = p;
        return this;
    }
    known(k: KnownOpts) {
        this._known = k;
        return this;
    }

    /** Build a FileContent instance using the core factory. */
    build(): FileContent<N, A, Prov, Perm, TTags, G, P> {
        if (!this._contentId) this._contentId = this._path;
        if (!this._path) {
            throw new Error("FileContentBuilder: path() is required.");
        }
        return createFileContent<N, A, Prov, Perm, TTags, G, P>({
            contentId: this._contentId,
            path: this._path,
            baseDir: this._baseDir,
            rel: this._rel,
            governance: this._governance,
            payload: this._payload,
            known: this._known,
        });
    }
}

/** Convenience: start a builder with good defaults (UTF-8 & detect by extension). */
export function fileContentBuilder(): FileContentBuilder<
    "text" | "binary",
    Record<string, unknown>,
    DefaultProvenance,
    DefaultPermissions,
    readonly string[],
    TypicalFsGovernance,
    unknown
> {
    return new FileContentBuilder<
        "text" | "binary",
        Record<string, unknown>,
        DefaultProvenance,
        DefaultPermissions,
        readonly string[],
        TypicalFsGovernance,
        unknown
    >().governance(withUtf8());
}
