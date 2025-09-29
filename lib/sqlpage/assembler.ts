import { dirname, fromFileUrl, join, relative, resolve } from "jsr:@std/path@1";
import {
    Assembler,
    AssemblerBusesInit,
    cleaner,
    fsFilesContributor,
    Resource,
} from "../assembler/mod.ts";

export class SqlPageAssembler<R extends Resource> extends Assembler<R> {
    constructor(
        projectId: string,
        moduleHome: string, // import.meta.resolve('./') from module
        assemblerBuses: AssemblerBusesInit<R>,
        readonly stdlibSymlinkDest: string,
    ) {
        super(projectId, moduleHome, assemblerBuses);

        const resourceSupplierIdentity = ["PROJECT_HOME"] as const;
        type ResourceSupplierIdentity = typeof resourceSupplierIdentity[number];

        this.withSuppliers(fsFilesContributor<R, ResourceSupplierIdentity>({
            identity: "PROJECT_HOME",
            root: this.projectPaths().projectSrcHome,
            walkOptions: {
                includeDirs: false,
                includeFiles: true,
                includeSymlinks: false,
                followSymlinks: true, // important for "src/spry"
                canonicalize: true,
            },
            relFsPath: (path) => this.relToPrjOrStd(path),
            webPath: (path) => this.relToPrjOrStd(path).replace(/^.*src\//, ""),
        }));
    }

    cleaner() {
        const paths = this.projectPaths();
        return cleaner({
            removeDirs: [{
                absFsPath: paths.spryDropIn.fsAuto,
                recursive: true,
            }, {
                absFsPath: paths.spryDropIn.fsHome,
                onlyIfEmpty: true,
            }],
        });
    }

    relToPrjOrStd(supplied: string) {
        const result = relative(this.projectPaths().projectHome, supplied);
        if (result.startsWith(this.stdlibSymlinkDest)) {
            return relative(
                Deno.cwd(), // assume that CWD is the project home
                join("src", "spry", relative(this.stdlibSymlinkDest, supplied)),
            );
        }
        return result;
    }

    override projectPaths(
        projectHome = this.moduleHome.startsWith("file:")
            ? fromFileUrl(this.moduleHome)
            : this.moduleHome,
    ) {
        const projectSrcHome = resolve(projectHome, "src");
        const absPathToSpryLocal = join(projectSrcHome, "spry");

        // Spry is usually symlinked and Deno.watchFs doesn't follow symlinks
        // so we watch the physical Spry because the symlink won't be watched
        // even though it's under the "src".
        const spryStdLibAbs = fromFileUrl(import.meta.resolve("../std"));
        const devWatchRoots = [
            relative(Deno.cwd(), projectSrcHome),
            relative(Deno.cwd(), spryStdLibAbs),
        ];
        return {
            ...super.projectPaths(projectHome),
            spryDropIn: {
                fsHome: resolve(projectSrcHome, "spry.d"),
                fsAuto: resolve(projectSrcHome, "spry.d", "auto"),
                webHome: join("spry.d"),
                webAuto: join("spry.d", "auto"),
            },
            spryStd: {
                homeFromSymlink: relative(
                    dirname(absPathToSpryLocal),
                    spryStdLibAbs,
                ),
                absPathToLocal: absPathToSpryLocal,
                relPathToHome: relative(Deno.cwd(), absPathToSpryLocal),
            },
            sqlPage: {
                absPathToConfDir: join(projectHome, "sqlpage"),
            },
            devWatchRoots,
        };
    }

    override projectStatePathEnvVars() {
        const paths = this.projectPaths();
        return {
            ...super.projectStatePathEnvVars(),
            "SQLPAGE_HOME": paths.sqlPage.absPathToConfDir,
            "SPRY_STD_HOME": paths.spryStd.absPathToLocal,
            "SPRY_STD_HOME_FROM_SYMLINK": paths.spryStd.homeFromSymlink,
            "SPRY_STD_HOME_REL": paths.spryStd.relPathToHome,
            "SPRYD_HOME": paths.spryDropIn.fsHome,
            "SPRYD_AUTO": paths.spryDropIn.fsAuto,
            "SPRYD_WEB_HOME": paths.spryDropIn.webHome,
            "SPRYD_WEB_AUTO": paths.spryDropIn.webAuto,
        };
    }
}
