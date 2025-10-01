import { dirname, fromFileUrl, join, relative, resolve } from "jsr:@std/path@1";
import {
  AnnotatedRoute,
  Assembler,
  AssemblerBusesInit,
  cleaner,
  fsFilesContributor,
  isRouteSupplier,
  isWebPathSupplier,
  Resource,
  ResourcesCollection,
  Routes,
} from "../assembler/mod.ts";
import {
  localDriver,
  ReactiveFs,
  reactiveFs,
  rel,
  RelCanonical,
  rootFs,
  RootLiteral,
} from "../universal/event-fs/mod.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

export class SqlPageAssembler<R extends Resource> extends Assembler<R> {
  readonly projectFsDriver = localDriver();
  readonly projectHomeFs: ReactiveFs<Any>;
  readonly projectSrcFs: ReactiveFs<Any>;
  readonly spryDropInfsHomeFs: ReactiveFs<Any>;
  readonly spryDropInfsAutoFs: ReactiveFs<Any>;

  constructor(
    projectId: string,
    moduleHome: string, // import.meta.resolve('./') from module
    assemblerBuses: AssemblerBusesInit<R>,
    readonly stdlibSymlinkDest: string,
    init: { dryRun: boolean; cleaningRequested?: boolean },
  ) {
    super(projectId, moduleHome, assemblerBuses, init);

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

    const paths = this.projectPaths();
    this.projectHomeFs = reactiveFs(rootFs(
      this.projectFsDriver,
      paths.projectHome as RootLiteral,
    ));
    this.projectSrcFs = reactiveFs(rootFs(
      this.projectFsDriver,
      paths.projectSrcHome as RootLiteral,
    ));
    this.spryDropInfsHomeFs = reactiveFs(rootFs(
      this.projectFsDriver,
      paths.spryDropIn.fsHome as RootLiteral,
    ));
    this.spryDropInfsAutoFs = reactiveFs(rootFs(
      this.projectFsDriver,
      paths.spryDropIn.fsAuto as RootLiteral,
    ));

    this.resourceBus.on("assembler:state:mutated", async (ev) => {
      if (ev.current.step === "final" && !ev.assemblerState.init.dryRun) {
        try {
          await Deno.mkdir(paths.projectSrcHome, { recursive: true });
          await Deno.mkdir(paths.spryDropIn.fsHome, {
            recursive: true,
          });
          await Deno.mkdir(paths.spryDropIn.fsAuto, {
            recursive: true,
          });
        } catch (err) {
          // TODO: create an event from this and report to the bus
          console.error(err);
        }

        await this.dropInArtifacts(ev.current.materialized);
      }
    });
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
    const relPathToSpryLocal = relative(Deno.cwd(), absPathToSpryLocal);

    // Spry is usually symlinked and Deno.watchFs doesn't follow symlinks
    // so we watch the physical Spry because the symlink won't be watched
    // even though it's under the "src".
    const devWatchRoots = [
      relative(Deno.cwd(), projectSrcHome),
      relative(Deno.cwd(), this.stdlibSymlinkDest),
    ];
    return {
      ...super.projectPaths(projectHome),
      projectSqlDropIn: {
        fsHome: resolve(projectSrcHome, "sql.d"),
        fsHeadHome: resolve(projectSrcHome, "sql.d", "head"),
        fsTailHome: resolve(projectSrcHome, "sql.d", "tail"),
      },
      spryDropIn: {
        fsHome: resolve(projectSrcHome, "spry.d"),
        fsAuto: resolve(projectSrcHome, "spry.d", "auto"),
        webHome: join("spry.d"),
        webAuto: join("spry.d", "auto"),
      },
      spryStd: {
        fsHomeFromSymlink: relative(
          dirname(absPathToSpryLocal),
          this.stdlibSymlinkDest,
        ),
        fsHomeAbs: absPathToSpryLocal,
        fsHomeRelToProject: relPathToSpryLocal,
        sqlDropIn: {
          fsHome: resolve(relPathToSpryLocal, "sql.d"),
          fsHeadHome: resolve(relPathToSpryLocal, "sql.d", "head"),
          fsTailHome: resolve(relPathToSpryLocal, "sql.d", "tail"),
        },
      },
      sqlPage: {
        fsConfDirHome: join(projectHome, "sqlpage"),
      },
      devWatchRoots,
      relativeToCWD: (path: string) => relative(Deno.cwd(), path),
    };
  }

  override projectStatePathEnvVars() {
    const paths = this.projectPaths();
    return {
      ...super.projectStatePathEnvVars(),
      "SPRY_STD_SQLD_HEAD_HOME": paths.spryStd.sqlDropIn.fsHeadHome,
      "SPRY_STD_SQLD_TAIL_HOME": paths.spryStd.sqlDropIn.fsTailHome,
      "PROJECT_SQLD_HEAD_HOME": paths.projectSqlDropIn.fsHeadHome,
      "PROJECT_SQLD_TAIL_HOME": paths.projectSqlDropIn.fsTailHome,
      "SQLPAGE_HOME": paths.sqlPage.fsConfDirHome,
      "SPRY_STD_HOME": paths.spryStd.fsHomeAbs,
      "SPRY_STD_HOME_FROM_SYMLINK": paths.spryStd.fsHomeFromSymlink,
      "SPRY_STD_HOME_REL": paths.spryStd.fsHomeRelToProject,
      "SPRYD_HOME": paths.spryDropIn.fsHome,
      "SPRYD_AUTO": paths.spryDropIn.fsAuto,
      "SPRYD_WEB_HOME": paths.spryDropIn.webHome,
      "SPRYD_WEB_AUTO": paths.spryDropIn.webAuto,
    };
  }

  protected async dropInArtifacts(rc: ResourcesCollection<R>) {
    // don't store absFsPath because it will be different across systems
    // making it harder to store in Git (because it will show diffs)
    const _omitNonIdempotent = (k: unknown, v: unknown) =>
      k === "absFsPath" || k === "origin" ? undefined : v;

    for await (const rcr of rc.resources) {
      if (isWebPathSupplier(rcr)) {
        const path = rel(rcr.webPath);
        await this.spryDropInfsAutoFs.mkdir(
          dirname(path) as RelCanonical,
          { recursive: true },
        );
        await this.spryDropInfsAutoFs.write(
          `${path}.auto.json` as RelCanonical,
          JSON.stringify(rcr, null, 2),
          { overwrite: true },
        );
      }
    }

    await this.spryDropInfsAutoFs.write(
      rel("resources.auto.json"),
      JSON.stringify(
        rc.resources.map((r) => ({
          nature: r.nature,
          path: isWebPathSupplier(r) ? r.webPath : undefined,
        })),
        null,
        2,
      ),
      { overwrite: true },
    );

    const routes = new Routes(
      rc.resources.filter(isRouteSupplier)
        .map((rs) =>
          isRouteSupplier(rs) ? rs.route.annotated : {} as AnnotatedRoute
        ),
    );
    const { serializers, breadcrumbs, edges } = await routes.populate();

    await this.spryDropInfsAutoFs.write(
      rel("routes.auto.json"),
      serializers.jsonText({ space: 2 }),
      { overwrite: true },
    );

    await this.spryDropInfsAutoFs.write(
      rel("routes-tree.auto.txt"),
      serializers.asciiTreeText(),
      { overwrite: true },
    );

    for await (const [webPath, bc] of Object.entries(breadcrumbs)) {
      const path = rel(`breadcrumbs/${webPath}`);
      await this.spryDropInfsAutoFs.mkdir(
        dirname(path) as RelCanonical,
        { recursive: true },
      );
      await this.spryDropInfsAutoFs.write(
        `${path}.auto.json` as RelCanonical,
        JSON.stringify(bc, null, 2),
        { overwrite: true },
      );
    }

    await this.spryDropInfsAutoFs.write(
      rel("edges.auto.json"),
      JSON.stringify(edges, null, 2),
      { overwrite: true },
    );
  }
}
