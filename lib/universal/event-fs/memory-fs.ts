import { AbsCanonical, parseAbs } from "./path.ts";
import { FsDriver, FsStat } from "./reactive-fs.ts";

export function memoryDriver(): FsDriver {
    const dirs = new Set<AbsCanonical>([parseAbs("/")]);
    const files = new Map<AbsCanonical, Uint8Array>();

    const parentDir = (abs: AbsCanonical): AbsCanonical => {
        if (abs === ("/" as AbsCanonical)) return "/" as AbsCanonical;
        const idx = abs.lastIndexOf("/");
        return (idx <= 0 ? "/" : abs.slice(0, idx)) as AbsCanonical;
    };

    const ensureDir = (abs: AbsCanonical) => {
        const parent = parentDir(abs);
        if (!dirs.has(parent)) throw new Error(`No such directory: ${parent}`);
    };

    return {
        provider: "memory",

        // deno-lint-ignore require-await
        async read(abs, opts) {
            const f = files.get(abs);
            if (!f) throw new Error(`File not found: ${abs}`);
            if (opts?.as === "text") return new TextDecoder().decode(f);
            return f;
        },

        // deno-lint-ignore require-await
        async write(abs, data, _opts) {
            ensureDir(abs);
            const bytes = typeof data === "string"
                ? new TextEncoder().encode(data)
                : data;
            files.set(abs, bytes);
            return bytes.byteLength;
        },

        // deno-lint-ignore require-await
        async mkdir(abs, opts) {
            const recursive = opts?.recursive ?? false;
            if (dirs.has(abs)) return;
            if (!recursive) {
                ensureDir(abs);
                dirs.add(abs);
                return;
            }
            const segments = abs.split("/").filter((p) => p.length > 0);
            let cur = "/" as AbsCanonical;
            for (const s of segments) {
                cur = (cur === ("/" as AbsCanonical)
                    ? `/${s}`
                    : `${cur}/${s}`) as AbsCanonical;
                dirs.add(cur);
            }
        },

        // deno-lint-ignore require-await
        async rm(abs, opts) {
            const recursive = opts?.recursive ?? false;
            if (files.has(abs)) {
                files.delete(abs);
                return;
            }
            if (dirs.has(abs)) {
                if (!recursive) {
                    for (const f of files.keys()) {
                        if (parentDir(f) === abs) {
                            throw new Error(`Directory not empty: ${abs}`);
                        }
                    }
                    for (const d of dirs.values()) {
                        if (d !== abs && parentDir(d) === abs) {
                            throw new Error(`Directory not empty: ${abs}`);
                        }
                    }
                }
                for (const f of Array.from(files.keys())) {
                    if (f === abs || f.startsWith(`${abs}/`)) files.delete(f);
                }
                for (const d of Array.from(dirs.values())) {
                    if (d === abs || d.startsWith(`${abs}/`)) dirs.delete(d);
                }
                return;
            }
            throw new Error(`No such file or directory: ${abs}`);
        },

        // deno-lint-ignore require-await
        async move(fromAbs, toAbs, opts) {
            const overwrite = opts?.overwrite ?? false;
            if (files.has(fromAbs)) {
                const data = files.get(fromAbs);
                if (!data) throw new Error("Race: source file vanished");
                if (!overwrite && files.has(toAbs)) {
                    throw new Error(`Destination exists: ${toAbs}`);
                }
                ensureDir(toAbs);
                files.set(toAbs, data);
                files.delete(fromAbs);
                return;
            }
            if (dirs.has(fromAbs)) {
                const toChildren: Array<[AbsCanonical, AbsCanonical]> = [];
                for (const d of dirs.values()) {
                    if (d === fromAbs || d.startsWith(`${fromAbs}/`)) {
                        const rel = d.slice(fromAbs.length);
                        const target = (toAbs + rel) as AbsCanonical;
                        toChildren.push([d, target]);
                    }
                }
                for (const [, newp] of toChildren) dirs.add(newp);
                for (const [oldp] of toChildren) dirs.delete(oldp);
                const fileMoves: Array<
                    [AbsCanonical, AbsCanonical, Uint8Array]
                > = [];
                for (const [f, buf] of files.entries()) {
                    if (f === fromAbs || f.startsWith(`${fromAbs}/`)) {
                        const rel = f.slice(fromAbs.length);
                        const target = (toAbs + rel) as AbsCanonical;
                        fileMoves.push([f, target, buf]);
                    }
                }
                for (const [, newf, buf] of fileMoves) {
                    if (!overwrite && files.has(newf)) {
                        throw new Error(`Destination file exists: ${newf}`);
                    }
                    files.set(newf, buf);
                }
                for (const [oldf] of fileMoves) files.delete(oldf);
                return;
            }
            throw new Error(`No such source: ${fromAbs}`);
        },

        // deno-lint-ignore require-await
        async copy(fromAbs, toAbs, opts) {
            const overwrite = opts?.overwrite ?? false;
            if (files.has(fromAbs)) {
                const data = files.get(fromAbs);
                if (!data) throw new Error("Race: source file vanished");
                if (!overwrite && files.has(toAbs)) {
                    throw new Error(`Destination exists: ${toAbs}`);
                }
                ensureDir(toAbs);
                files.set(toAbs, new Uint8Array(data));
                return;
            }
            if (dirs.has(fromAbs)) {
                const toChildren: Array<AbsCanonical> = [];
                for (const d of dirs.values()) {
                    if (d === fromAbs || d.startsWith(`${fromAbs}/`)) {
                        const rel = d.slice(fromAbs.length);
                        const target = (toAbs + rel) as AbsCanonical;
                        toChildren.push(target);
                    }
                }
                for (const newp of toChildren) dirs.add(newp);
                for (const [f, buf] of files.entries()) {
                    if (f === fromAbs || f.startsWith(`${fromAbs}/`)) {
                        const rel = f.slice(fromAbs.length);
                        const target = (toAbs + rel) as AbsCanonical;
                        if (!overwrite && files.has(target)) {
                            throw new Error(
                                `Destination file exists: ${target}`,
                            );
                        }
                        files.set(target, new Uint8Array(buf));
                    }
                }
                return;
            }
            throw new Error(`No such source: ${fromAbs}`);
        },

        // deno-lint-ignore require-await
        async list(absDir) {
            const out = new Set<AbsCanonical>();
            const prefix = absDir === ("/" as AbsCanonical)
                ? "/"
                : (`${absDir}/` as const);
            for (const d of Array.from(new Set(dirs))) {
                if (d !== absDir && d.startsWith(prefix)) {
                    const rel = d.slice(prefix.length);
                    if (!rel.includes("/")) out.add(d);
                }
            }
            for (const f of files.keys()) {
                if (f.startsWith(prefix)) {
                    const rel = f.slice(prefix.length);
                    if (!rel.includes("/")) out.add(f);
                }
            }
            if (!dirs.has(absDir)) {
                throw new Error(`Not a directory: ${absDir}`);
            }
            return Array.from(out.values());
        },

        // deno-lint-ignore require-await
        async stat(abs) {
            if (files.has(abs)) {
                return {
                    exists: true,
                    isFile: true,
                    isDir: false,
                    size: files.get(abs)?.byteLength,
                } as FsStat;
            }
            if (dirs.has(abs)) {
                return { exists: true, isFile: false, isDir: true } as FsStat;
            }
            return { exists: false, isFile: false, isDir: false } as FsStat;
        },
    } as const;
}
