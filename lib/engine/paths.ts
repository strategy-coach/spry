import { WalkEntry } from "jsr:@std/fs@1/walk";
import { dirname, fromFileUrl, join, relative } from "jsr:@std/path@1";

export type PathSupplier = {
    readonly absolute: (path: string | WalkEntry) => string;
    readonly relative: (path: string | WalkEntry) => string;
};

export type FsPathSupplier = PathSupplier & {
    readonly root: string;
    readonly identity?: string;
};

export function projectPaths(moduleHome: string, sprySymlinkDest: string) {
    const SRC = "src" as const;
    const pickPath = (p: string | WalkEntry) =>
        typeof p === "string" ? p : p.path;

    const relToPrjOrStd = (p: string | WalkEntry) => {
        const supplied = pickPath(p);
        const result = relative(moduleHome, supplied);
        if (result.startsWith(sprySymlinkDest)) {
            return relative(
                Deno.cwd(),
                join(SRC, "spry", relative(sprySymlinkDest, supplied)),
            );
        }
        return result;
    };

    const projectFsPaths: FsPathSupplier = {
        identity: "project", // current module's unique identity
        root: moduleHome,
        absolute: (p) => join(moduleHome, pickPath(p)),
        relative: relToPrjOrStd,
    };

    const projectSrcFsPaths: FsPathSupplier = {
        identity: "project-src", // current module's unique identity
        root: join(moduleHome, SRC),
        absolute: (p) => join(moduleHome, SRC, pickPath(p)),
        relative: (p: string | WalkEntry) =>
            relative(join(moduleHome, SRC), pickPath(p)),
    };

    const webPaths: PathSupplier = {
        absolute: (p) => relToPrjOrStd(p).replace(/^.*src\//, ""),
        relative: (p) => relToPrjOrStd(p).replace(/^.*src\//, ""),
    };

    const absPathToSpryLocal = join(moduleHome, SRC, "spry");

    // Spry is usually symlinked and Deno.watchFs doesn't follow symlinks
    // so we watch the physical Spry because the symlink won't be watched
    // even though it's under the "src".
    const spryStdLibAbs = fromFileUrl(import.meta.resolve("../std"));
    const devWatchRoots = [
        relative(
            Deno.cwd(),
            projectSrcFsPaths.root,
        ),
        relative(Deno.cwd(), spryStdLibAbs),
    ];
    return {
        projectFsPaths,
        projectSrcFsPaths,
        webPaths,
        spryStd: {
            homeFromSymlink: relative(
                dirname(absPathToSpryLocal),
                spryStdLibAbs,
            ),
            absPathToLocal: absPathToSpryLocal,
            relPathToHome: relative(Deno.cwd(), absPathToSpryLocal),
        },
        sqlPage: {
            absPathToConfDir: join(moduleHome, "sqlpage"),
        },
        devWatchRoots,
    };
}
