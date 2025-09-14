/**
 * content/hash.ts
 * Minimal hashing helpers for bytes and Web ReadableStreams using Web Crypto.
 *
 * NOTE: Web Crypto digests are not streaming; we buffer in-memory for simplicity.
 * For very large content, prefer a platform streaming hash (Node crypto, Deno std/io hashing)
 * or use createHashingTap() to compute a digest while pass-through streaming—still buffers
 * but keeps the "tap" composable with your pipelines.
 */

function toHex(bytes: ArrayBuffer): string {
    const v = new Uint8Array(bytes);
    let s = "";
    for (let i = 0; i < v.length; i++) {
        const h = v[i].toString(16).padStart(2, "0");
        s += h;
    }
    return s;
}

export type HashAlg = "SHA-256" | "SHA-1" | "MD5"; // MD5 is not in Web Crypto spec universally; keep for compatibility

/** Hash raw bytes with Web Crypto (buffers in memory). */
export async function hashBytes(
    bytes: Uint8Array,
    alg: HashAlg = "SHA-256",
): Promise<string> {
    const d = await crypto.subtle.digest(alg, bytes);
    return toHex(d);
}

/** Drain a ReadableStream<Uint8Array> and hash the concatenated bytes (buffers in memory). */
export async function hashReadable(
    rs: ReadableStream<Uint8Array>,
    alg: HashAlg = "SHA-256",
): Promise<string> {
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
    return hashBytes(out, alg);
}

/**
 * Create a pass-through TransformStream that *also* computes a digest of the bytes that pass through.
 * Usage:
 *   const { transform, digest } = createHashingTap("SHA-256");
 *   const rs = await pipe(content, [transform]); // pass-through
 *   const hex = await digest; // resolves when stream finishes
 */
export function createHashingTap(alg: HashAlg = "SHA-256"): {
    transform: TransformStream<Uint8Array, Uint8Array>;
    digest: Promise<string>;
} {
    let resolve!: (v: string) => void;
    let reject!: (e: unknown) => void;
    const done = new Promise<string>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    const bufs: Uint8Array[] = [];
    let total = 0;

    const transform = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            bufs.push(chunk);
            total += chunk.byteLength;
            controller.enqueue(chunk);
        },
        async flush() {
            try {
                const out = new Uint8Array(total);
                let o = 0;
                for (const b of bufs) {
                    out.set(b, o);
                    o += b.byteLength;
                }
                const hex = await hashBytes(out, alg);
                resolve(hex);
            } catch (e) {
                reject(e);
            }
        },
    });

    return { transform, digest: done };
}
