import { walk, WalkEntry } from "jsr:@std/fs@1/walk";
import {
    globToRegExp,
    isAbsolute,
    join,
    relative,
    resolve,
} from "jsr:@std/path@1";

/**
 * Describes a filesystem entry encountered during a walk.
 *
 * All paths are normalized for convenience:
 * - `root` is the absolute directory that the walk is currently traversing.
 * - `path` is the absolute path to the file that matched all filters.
 * - `relPath` is `path` expressed relative to `root`.
 */
export type Encountered = WalkEntry & {
    /** Absolute filesystem path of the current root being walked. */
    root: string;
    /** Absolute path of the matched file. (Directories are not emitted.) */
    path: string;
    /** Path of the matched file relative to `root`. */
    relPath: string;
};

/**
 * Walk one or more root directories and invoke an `ingest` callback for each file
 * that passes optional include/exclude globs.
 *
 * ## Roots
 * - Each entry in `init.root` can be absolute or relative.
 * - Relative roots are resolved against the directory containing this module
 *   (`import.meta.url`), not the current working directory.
 * - At least one root is required; otherwise error is returned.
 *
 * ## Include/Exclude Globs
 * - Globs in `include` and `exclude` are compiled to **absolute-path** regular
 *   expressions. If a glob is relative, it is joined to the current `root`
 *   before compilation.
 * - If `include` is omitted or empty, all files are considered included by default.
 * - A file is emitted iff it matches at least one include (or include list is
 *   empty) and matches **none** of the exclude globs.
 * - Globs support `extended` and `globstar` features (e.g. `**\/*.ts`).
 *
 * ## Symlinks & Directories
 * - Directories are never emitted (`includeDirs: false`).
 * - Symlinks are not followed (`followSymlinks: false`).
 *
 * ## De-duplication
 * - If multiple roots overlap (or the same root is given more than once), the
 *   same absolute file path is only processed once in the entire run.
 *
 * @typeParam Context - Arbitrary context object passed through to each `ingest` call.
 *
 * @param init.ctx - A user-provided context object forwarded to `ingest`.
 * @param init.root - One or more root directories to walk. Must contain at least one entry.
 * @param init.include - Optional glob patterns. If provided, a file must match **some**
 *   include pattern (after absolute resolution) to be considered.
 * @param init.exclude - Optional glob patterns. If provided, a file is skipped if it
 *   matches **any** exclude pattern (after absolute resolution).
 *
 * @param ingest - Async or sync callback invoked for each passing file. Receives the
 *   user `ctx` and a readonly {@link Encountered} describing the match.
 *
 * @returns A promise that resolves when all roots have been walked and all `ingest`
 *   callbacks have completed.
 *
 * @example
 * ```ts
 * await walkRoots(
 *   {
 *     ctx: { collected: [] as string[] },
 *     root: ["./examples"],
 *     include: ["**\/*.ts"],
 *     exclude: ["**\/*.test.ts"],
 *   },
 *   async (ctx, { path }) => {
 *     ctx.collected.push(path);
 *   }
 * );
 * ```
 */
export async function walkRoots<Context>(
    init: {
        ctx: Context;
        root: string[];
        baseDir: string;
        include?: string[] | undefined;
        exclude?: string[] | undefined;
        onInvalidRoot?: (root: string) => void | Promise<void>;
    },
    ingest: (
        ctx: Context,
        encountered: Readonly<Encountered>,
    ) => void | Promise<void>,
) {
    const roots = (init.root ?? []).map((
        r,
    ) => (isAbsolute(r) ? r : resolve(init.baseDir, r)));
    const seen = new Set<string>();
    for (const root of roots) {
        try {
            const st = await Deno.stat(root);
            if (!st.isDirectory) {
                init.onInvalidRoot?.(root);
                continue;
            }
        } catch {
            init.onInvalidRoot?.(root);
            continue;
        }

        // Pre-compile include/exclude patterns against ABSOLUTE paths.
        const includeGlobs = init.include ?? [];
        const excludeGlobs = init.exclude ?? [];
        const includeRes = includeGlobs.map((g) =>
            globToRegExp(isAbsolute(g) ? g : join(root, g), {
                extended: true,
                globstar: true,
            })
        );
        const excludeRes = excludeGlobs.map((g) =>
            globToRegExp(isAbsolute(g) ? g : join(root, g), {
                extended: true,
                globstar: true,
            })
        );
        const includeAll = includeRes.length === 0;

        for await (
            const entry of walk(root, {
                includeDirs: false,
                followSymlinks: false,
            })
        ) {
            const abs = entry.path;
            if (seen.has(abs)) continue; // skip dupes if roots overlap

            const passesInclude = includeAll ||
                includeRes.some((re) => re.test(abs));
            if (!passesInclude) continue;

            const hitsExclude = excludeRes.some((re) => re.test(abs));
            if (hitsExclude) continue;

            seen.add(abs);
            const relPath = relative(root, abs);
            await ingest(init.ctx, {
                ...entry,
                root,
                path: abs,
                relPath,
            });
        }
    }
}
