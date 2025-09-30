import { AbsCanonical, parseAbs } from "./path.ts";
import { FsDriver, FsStat } from "./reactive-fs.ts";

export function localDriver(): FsDriver {
    const parentDir = (abs: AbsCanonical): AbsCanonical => {
        if (abs === ("/" as AbsCanonical)) return "/" as AbsCanonical;
        const idx = abs.lastIndexOf("/");
        return (idx <= 0 ? "/" : abs.slice(0, idx)) as AbsCanonical;
    };

    return {
        provider: "local",

        async read(abs, opts) {
            if (opts?.as === "text") {
                const s = await Deno.readTextFile(abs);
                return s;
            }
            const u8 = await Deno.readFile(abs);
            return u8;
        },

        async write(abs, data, _opts) {
            // Ensure parent exists
            const p = parentDir(abs);
            await Deno.mkdir(p, { recursive: true }).catch(() => {});
            if (typeof data === "string") {
                await Deno.writeTextFile(abs, data);
                return new TextEncoder().encode(data).byteLength;
            }
            await Deno.writeFile(abs, data);
            return data.byteLength;
        },

        async mkdir(abs, opts) {
            await Deno.mkdir(abs, { recursive: opts?.recursive ?? false });
        },

        async rm(abs, opts) {
            await Deno.remove(abs, { recursive: opts?.recursive ?? false });
        },

        async move(fromAbs, toAbs, opts) {
            const overwrite = opts?.overwrite ?? false;
            if (overwrite) {
                try {
                    await Deno.remove(toAbs, { recursive: true });
                } catch { /* ignore */ }
            } else {
                try {
                    await Deno.lstat(toAbs);
                    throw new Error(`Destination exists: ${toAbs}`);
                } catch {
                    // ok if not exists
                }
            }
            // Ensure parent of dest exists
            const p = parentDir(toAbs);
            await Deno.mkdir(p, { recursive: true }).catch(() => {});
            await Deno.rename(fromAbs, toAbs);
        },

        async copy(fromAbs, toAbs, opts) {
            const overwrite = opts?.overwrite ?? false;
            const fromInfo = await Deno.lstat(fromAbs);
            if (fromInfo.isDirectory) {
                // directory copy (recursive)
                if (overwrite) {
                    try {
                        await Deno.remove(toAbs, { recursive: true });
                    } catch { /* ignore */ }
                } else {
                    try {
                        await Deno.lstat(toAbs);
                        throw new Error(`Destination exists: ${toAbs}`);
                    } catch {
                        // ok if not exists
                    }
                }
                await Deno.mkdir(toAbs, { recursive: true });
                for await (const entry of Deno.readDir(fromAbs)) {
                    const src = parseAbs(`${fromAbs}/${entry.name}`);
                    const dst = parseAbs(`${toAbs}/${entry.name}`);
                    if (entry.isDirectory) await this.copy(src, dst, opts);
                    else if (entry.isFile) await Deno.copyFile(src, dst);
                }
                return;
            }
            // file copy
            if (!overwrite) {
                try {
                    await Deno.lstat(toAbs);
                    throw new Error(`Destination exists: ${toAbs}`);
                } catch {
                    // ok
                }
            }
            const p = parentDir(toAbs);
            await Deno.mkdir(p, { recursive: true }).catch(() => {});
            await Deno.copyFile(fromAbs, toAbs);
        },

        async list(absDir) {
            const info = await Deno.lstat(absDir);
            if (!info.isDirectory) {
                throw new Error(`Not a directory: ${absDir}`);
            }
            const out: AbsCanonical[] = [];
            for await (const entry of Deno.readDir(absDir)) {
                out.push(
                    parseAbs(
                        `${
                            absDir === ("/" as AbsCanonical)
                                ? ""
                                : absDir
                        }/${entry.name}`,
                    ),
                );
            }
            return out;
        },

        async stat(abs) {
            try {
                const st = await Deno.lstat(abs);
                return {
                    exists: true,
                    isFile: st.isFile,
                    isDir: st.isDirectory,
                    size: st.size,
                    mtimeMs: st.mtime ? st.mtime.getTime() : undefined,
                } as FsStat;
            } catch {
                return { exists: false, isFile: false, isDir: false } as FsStat;
            }
        },
    } as const;
}
