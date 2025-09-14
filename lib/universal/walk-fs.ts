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
  root: WalkRoot & { absRoot: string };
  /** Absolute path of the matched file. (Directories are not emitted.) */
  path: string;
  /** Path of the matched file relative to `root`. */
  relPath: string;
};

/** Per-root configuration. */
export type WalkRoot = {
  /** Root directory to walk. Can be absolute or relative (resolved against `baseDir`). */
  root: string;
  /**
   * Base directory used to resolve a relative `root` and any relative include/exclude globs.
   * Typically the directory containing this module (`import.meta.url`) or caller-provided.
   */
  baseDir: string;
  /** Optional include globs. If omitted/empty, all files are considered included. */
  include?: string[];
  /** Optional exclude globs. Files matching any are skipped. */
  exclude?: string[];
};

/**
 * Walk one or more root directories and invoke an `ingest` callback for each file
 * that passes optional include/exclude globs.
 *
 * ## Roots
 * - Each entry in `init.roots` may be absolute or relative.
 * - Relative roots are resolved against that entry's `baseDir`, not the CWD.
 * - At least one root is required; otherwise an error is thrown.
 *
 * ## Include/Exclude Globs
 * - `include` / `exclude` are *per-root* and compiled to **absolute-path** regexes.
 * - Relative globs are joined to the current root before compilation.
 * - A file is emitted iff it matches at least one include (or include list is
 *   empty) and matches **none** of the exclude globs.
 * - Globs support `extended` and `globstar` features (e.g. `**\/*.ts`).
 *
 * ## Symlinks & Directories
 * - Directories are never emitted (`includeDirs: false`).
 * - Symlinks are not followed (`followSymlinks: false`).
 *
 * ## De-duplication
 * - If multiple roots overlap (or the same root appears more than once), the
 *   same absolute file path is processed only once across the entire run.
 *
 * @typeParam Context - Arbitrary context object passed through to each `ingest` call.
 *
 * @param init.ctx - A user-provided context object forwarded to `ingest`.
 * @param init.roots - One or more per-root specs.
 * @param init.onInvalidRoot - Optional callback invoked when a root does not exist or is not a directory.
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
 *     roots: [
 *       {
 *         root: "./examples",
 *         baseDir: new URL(".", import.meta.url).pathname,
 *         include: ["**\/*.ts"],
 *         exclude: ["**\/*.test.ts"],
 *       },
 *     ],
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
    roots: WalkRoot[];
    onInvalidRoot?: (root: string) => void | Promise<void>;
  },
  ingest: (
    ctx: Context,
    encountered: Readonly<Encountered>,
  ) => void | Promise<void>,
) {
  const seen = new Set<string>();
  for (const spec of init.roots) {
    // Resolve the root to an absolute path using the spec's baseDir.
    const absRoot = isAbsolute(spec.root)
      ? spec.root
      : resolve(spec.baseDir, spec.root);

    // Validate root directory.
    let isDir = false;
    try {
      const st = await Deno.stat(absRoot);
      isDir = st.isDirectory;
    } catch {
      /* noop */
    }
    if (!isDir) {
      await init.onInvalidRoot?.(absRoot);
      continue;
    }

    // Pre-compile include/exclude patterns against ABSOLUTE paths for this root.
    const includeGlobs = spec.include ?? [];
    const excludeGlobs = spec.exclude ?? [];
    const includeRes = includeGlobs.map((g) =>
      globToRegExp(isAbsolute(g) ? g : join(absRoot, g), {
        extended: true,
        globstar: true,
      })
    );
    const excludeRes = excludeGlobs.map((g) =>
      globToRegExp(isAbsolute(g) ? g : join(absRoot, g), {
        extended: true,
        globstar: true,
      })
    );
    const includeAll = includeRes.length === 0;

    for await (
      const entry of walk(absRoot, {
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
      const relPath = relative(absRoot, abs);
      await ingest(init.ctx, {
        ...entry,
        root: { ...spec, absRoot },
        path: abs,
        relPath,
      });
    }
  }
  return seen;
}
