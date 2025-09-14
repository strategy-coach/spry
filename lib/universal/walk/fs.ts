// walk-fs.ts
import { walk, type WalkEntry, type WalkOptions } from "jsr:@std/fs@1/walk";
import {
  globToRegExp,
  isAbsolute,
  join,
  relative,
  resolve,
} from "jsr:@std/path@1";
import {
  type Encountered,
  type Key,
  walk as genericWalk,
  type WalkerAdapter,
  type WalkerOptions,
} from "./core.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** User-facing filesystem spec (what authors provide). */
export type FSWalkSpec = Readonly<{
  /** Root directory to walk (abs or relative to baseDir). */
  root: string;
  /** Base directory to resolve relative `root` and globs. */
  baseDir: string;
  /** Optional include globs (absolute or relative to root). If empty, include all. */
  include?: readonly string[];
  /** Optional exclude globs (absolute or relative to root). */
  exclude?: readonly string[];
}>;

/** Adapter’s normalized spec — what the walker uses at runtime. */
export type FSWalkSpecNorm = Readonly<{
  /** Absolute, canonical root directory. */
  absRoot: string;
  /** Original spec for reference. */
  spec: FSWalkSpec;
  /** Pre-compiled absolute-path regexes for include/exclude. */
  includeRes: readonly RegExp[];
  excludeRes: readonly RegExp[];
  /** Fast path: include all when there are no include globs. */
  includeAll: boolean;
}>;

/** Payload shape example (you can parameterize this in your code). */
export type FSPayload = Readonly<{
  /** Relative path from root (convenience). */
  relPath: string;
}>;

/** Build absolute-path regex from a glob scoped to `absRoot`. */
function compileGlob(absRoot: string, g: string): RegExp {
  const absGlob = isAbsolute(g) ? g : join(absRoot, g);
  return globToRegExp(absGlob, { extended: true, globstar: true });
}

/** Filesystem adapter implementing WalkerAdapter. */
export function createFSAdapter<P = FSPayload>(
  payloadFactory?: (args: {
    norm: FSWalkSpecNorm;
    entry: WalkEntry;
    absPath: string;
    relPath: string;
  }) => P | Promise<P>,
  fsWalkOptions?: WalkOptions,
): WalkerAdapter<FSWalkSpec, FSWalkSpecNorm, WalkEntry, P> {
  return {
    kind: "filesystem",

    async normalize(spec: FSWalkSpec): Promise<FSWalkSpecNorm> {
      const absRoot = isAbsolute(spec.root)
        ? spec.root
        : resolve(spec.baseDir, spec.root);

      // Validate root dir early; throw with a helpful message.
      let st: Deno.FileInfo;
      try {
        st = await Deno.stat(absRoot);
      } catch {
        throw new Error(`FS root does not exist: ${absRoot}`);
      }
      if (!st.isDirectory) {
        throw new Error(`FS root is not a directory: ${absRoot}`);
      }

      const includeGlobs = spec.include ?? [];
      const excludeGlobs = spec.exclude ?? [];
      const includeRes = includeGlobs.map((g) => compileGlob(absRoot, g));
      const excludeRes = excludeGlobs.map((g) => compileGlob(absRoot, g));

      return {
        absRoot,
        spec,
        includeRes,
        excludeRes,
        includeAll: includeRes.length === 0,
      };
    },

    async *list(norm: FSWalkSpecNorm): AsyncIterable<WalkEntry> {
      for await (
        const entry of walk(
          norm.absRoot,
          fsWalkOptions ?? {
            includeDirs: false,
            followSymlinks: false,
          },
        )
      ) {
        const abs = entry.path;
        // include / exclude checks against absolute path
        if (
          !(norm.includeAll ||
            norm.includeRes.some((re) => re.test(abs))) ||
          norm.excludeRes.some((re) => re.test(abs))
        ) {
          continue;
        }
        yield entry;
      }
    },

    keyOf(_norm: FSWalkSpecNorm, item: WalkEntry): Key {
      // absolute path is a stable cross-run key in the FS adapter
      return item.path;
    },

    // deno-lint-ignore require-await
    async payload({ spec: norm, item }) {
      // Default payload provides relPath convenience; callers can override via payloadFactory
      const relPath = relative(norm.absRoot, item.path);
      if (payloadFactory) {
        return payloadFactory({
          norm,
          entry: item,
          absPath: item.path,
          relPath,
        }) as Any;
      }
      return { relPath } as Any;
    },
  };
}

/** Public: type alias for encountered FS entries with optional payload. */
export type FSEncountered<P = FSPayload> = Encountered<
  WalkEntry,
  FSWalkSpecNorm,
  P
>;

/** Re-export the generic walk with FS typings for convenience. */
export async function* walkFS<P = FSPayload>(
  opts: WalkerOptions<FSWalkSpec>,
  adapter = createFSAdapter<P>(),
): AsyncGenerator<FSEncountered<P>, void, unknown> {
  yield* genericWalk<FSWalkSpec, FSWalkSpecNorm, WalkEntry, P>(opts, adapter);
}
