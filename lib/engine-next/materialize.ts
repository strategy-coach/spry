import { dirname, fromFileUrl, join, relative, resolve } from "jsr:@std/path@1";
import { Engine, LintCatalog } from "./core.ts";
import { FsFilesCollection, fsFilesContributor } from "./core-fs.ts";

export const resSupplierIdentity = ["PROJECT_HOME"] as const;
export type ResSupplierIdentity = typeof resSupplierIdentity[number];

export class MaterializationState {
  readonly fc = new FsFilesCollection<MaterializationState>();
}

export class MaterializationEngine
  extends Engine<MaterializationState, LintCatalog> {
  readonly paths: ReturnType<MaterializationEngine["projectPaths"]>;

  protected constructor(
    readonly moduleHome: string, // import.meta.resolve('./') from module
    readonly stdlibSymlinkDest: string, // relative dest to stdlib
  ) {
    super(new MaterializationState());
    this.paths = this.projectPaths();

    this.on(
      "resource:contribute",
      fsFilesContributor<MaterializationState, ResSupplierIdentity>({
        identity: "PROJECT_HOME",
        root: this.paths.projectSrcHome,
        walkOptions: {
          includeSymlinks: false,
          followSymlinks: true, // important for "src/spry"
          canonicalize: true,
        },
        relFsPath: (path) => this.relToPrjOrStd(path),
        webPath: (path) => this.relToPrjOrStd(path).replace(/^.*src\//, ""),
      }),
    );
    this.on("resource:encountered", this.state.fc.listen);
  }

  relToPrjOrStd(supplied: string) {
    const result = relative(this.paths.projectHome, supplied);
    if (result.startsWith(this.stdlibSymlinkDest)) {
      return relative(
        Deno.cwd(), // assume that CWD is the project home
        join("src", "spry", relative(this.stdlibSymlinkDest, supplied)),
      );
    }
    return result;
  }

  projectPaths(
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
      projectHome: projectHome,
      projectSrcHome: projectSrcHome,
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

  static instance(moduleHome: string, sprySymlinkDest: string) {
    return new MaterializationEngine(moduleHome, sprySymlinkDest);
  }
}
