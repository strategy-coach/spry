import { dirname, fromFileUrl, join, relative, resolve } from "jsr:@std/path@1";
import {
  executables,
  FsFileResource,
  fsFilesContributor,
  FsWalkedEncounter,
  isFsFileResource,
  isFsWalkedEncounter,
} from "./core-fs.ts";
import {
  isSrcCodeLangSpecSupplier,
  LintCatalog,
  PipelineBus,
  PipelineEvents,
  PipelineListener,
  ResourceSupplier,
  SrcCodeLangSpecSupplier,
} from "./core.ts";
import { directives as directivesHandlers } from "./directives.ts";
import { Resource } from "./resource.ts";

type PipelineStage =
  | { stage: "init" }
  | {
    stage: "discovery";
    fcDiscovered: FsFilesCollection<EngineState>;
    registerDiscovery: (
      ev: Parameters<
        PipelineListener<
          PipelineEvents<EngineState, Resource>,
          "resource:encountered"
        >
      >[0],
    ) => Promise<void>;
  }
  | {
    stage: "materialization";
    fcDiscovered: FsFilesCollection<EngineState>;
    fcMaterialized: FsFilesCollection<EngineState>;
    registerRediscovery: (
      ev: Parameters<
        PipelineListener<
          PipelineEvents<EngineState, Resource>,
          "resource:encountered"
        >
      >[0],
    ) => Promise<void>;
  };

class EngineState {
  #workflow: PipelineStage;

  constructor() {
    this.#workflow = { stage: "init" };
  }

  get workflow() {
    return this.#workflow;
  }

  nextStage() {
    switch (this.#workflow.stage) {
      case "init": {
        const fcDiscovered = new FsFilesCollection<EngineState>();
        this.#workflow = {
          stage: "discovery",
          fcDiscovered,
          registerDiscovery: async (ev) =>
            await fcDiscovered.onEncountered(ev.event),
        };
        return this.#workflow;
      }
    }
  }
}

export const resourceSupplierIdentity = ["PROJECT_HOME"] as const;
export type ResourceSupplierIdentity = typeof resourceSupplierIdentity[number];

export class FsFilesCollection<State> {
  readonly suppliers = new Set<ResourceSupplier<State, Resource>>();
  readonly resources: readonly Resource[] = [];
  readonly fsFiles: readonly FsFileResource[] = [];
  readonly walkedFiles: readonly (FsFileResource & FsWalkedEncounter)[] = [];
  readonly walkedSrcFiles:
    readonly (FsFileResource & FsWalkedEncounter & SrcCodeLangSpecSupplier)[] =
      [];
  readonly execCandidate = executables();
  readonly isExecutable = this.execCandidate.isExecutable;

  constructor() {
  }

  // deno-lint-ignore require-await
  async onEncountered(
    ev: Parameters<
      PipelineListener<
        PipelineEvents<State, Resource>,
        "resource:encountered"
      >
    >[0]["event"],
  ) {
    const { resource, supplier } = ev;
    if (supplier) {
      this.suppliers.add(
        supplier as ResourceSupplier<State, Resource>,
      );
    }

    (this.resources as Resource[]).push(resource);
    if (isFsFileResource(resource)) {
      (this.fsFiles as FsFileResource[]).push(resource);
      if (isFsWalkedEncounter(resource)) {
        (this.walkedFiles as (FsFileResource & FsWalkedEncounter)[])
          .push(resource);
        if (isSrcCodeLangSpecSupplier(resource)) {
          (this.walkedSrcFiles as (
            & FsFileResource
            & FsWalkedEncounter
            & SrcCodeLangSpecSupplier
          )[]).push(resource);
        }
      }
    }
  }
}

export class Engine {
  readonly bus: PipelineBus<EngineState, LintCatalog>;
  readonly paths: ReturnType<Engine["projectPaths"]>;
  readonly executables = executables();

  protected constructor(
    readonly projectId: string,
    readonly moduleHome: string, // import.meta.resolve('./') from module
    readonly stdlibSymlinkDest: string, // relative dest to stdlib
  ) {
    this.bus = new PipelineBus(new EngineState());
    this.paths = this.projectPaths();

    // register our resource contributors, thse are called when "discover"
    // event is fired
    this.bus.on(
      "resource:contribute",
      fsFilesContributor<EngineState, ResourceSupplierIdentity>({
        identity: "PROJECT_HOME",
        root: this.paths.projectSrcHome,
        walkOptions: {
          includeDirs: false,
          includeFiles: true,
          includeSymlinks: false,
          followSymlinks: true, // important for "src/spry"
          canonicalize: true,
        },
        relFsPath: (path) => this.relToPrjOrStd(path),
        webPath: (path) => this.relToPrjOrStd(path).replace(/^.*src\//, ""),
      }),
    );

    this.bus.on("resource:encountered", (ev) => {
      const { workflow } = this.bus.state;
      switch (workflow.stage) {
        case "discovery":
          workflow.registerDiscovery(ev);
      }
    });
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
      projectHome,
      projectSrcHome,
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

  projectStateEnv(
    init?: { projectVarPrefix?: string; pathVarPrefix?: string },
  ) {
    const paths = this.projectPaths();
    const {
      pathVarPrefix = "FOUNDRY_PROJECT_PATH_",
      projectVarPrefix = "FOUNDRY_PROJECT_",
    } = init ?? {};
    const projectVars = {
      "ID": this.projectId,
    };
    const pathVars = {
      "HOME": paths.projectHome,
      "SRC_HOME": paths.projectSrcHome,
      "SQLPAGE_HOME": paths.sqlPage.absPathToConfDir,
      "SPRY_STD_HOME": paths.spryStd.absPathToLocal,
      "SPRY_STD_HOME_FROM_SYMLINK": paths.spryStd.homeFromSymlink,
      "SPRY_STD_HOME_REL": paths.spryStd.relPathToHome,
      "SPRYD_HOME": paths.spryDropIn.fsHome,
      "SPRYD_AUTO": paths.spryDropIn.fsAuto,
      "SPRYD_WEB_HOME": paths.spryDropIn.webHome,
      "SPRYD_WEB_AUTO": paths.spryDropIn.webAuto,
    };
    const result: Record<string, string> = {};
    result[`${projectVarPrefix}ID`] = this.projectId;
    result[`${projectVarPrefix}PATHS_JSON`] = JSON.stringify(paths);
    for (const [k, v] of Object.entries(projectVars)) {
      if (typeof k === "string") result[`${projectVarPrefix}${k}`] = String(v);
    }
    for (const [k, v] of Object.entries(pathVars)) {
      if (typeof k === "string") result[`${pathVarPrefix}${k}`] = String(v);
    }
    return result;
  }

  async materializeFoundries(
    candidates: Iterable<FsFileResource>,
    args?: { readonly dryRun?: boolean },
  ) {
    // now see which files are executable and materialize them appropriately
    const { isExecutable, materialize } = this.executables;
    const env = this.projectStateEnv();
    const cwd = Deno.cwd();

    for await (const wf of candidates) {
      if (wf.nature === "foundry") {
        if (!isExecutable(wf.absFsPath)) {
          console.error("foundry", wf.relFsPath, "is not executable");
        } else {
          materialize({
            absFsPath: wf.absFsPath,
            matAbsFsPath: wf.extensions.autoMaterializable(),
            env,
            cwd,
            dryRun: args?.dryRun,
          }, (error) => console.error(error));
        }
      }
    }
  }

  async materialize(args?: { readonly dryRun?: boolean }) {
    const { dryRun = false } = args ?? {};

    // TODO: publish events before/after/etc. stage changes and other works
    // TODO: refine how dryRun works
    // TODO: add linting
    // TODO: add observability for CLI directly into resources?

    // we start in "init", then move to next stage
    const workflow = this.bus.state.nextStage();
    if (workflow?.stage === "discovery") {
      // get all files by running the contributors, the event handlers know the
      // stage and put state information into the right place
      await this.bus.discover();

      // directives are able to modify files so let's do that now
      const dh = directivesHandlers(workflow.fcDiscovered.walkedSrcFiles);
      if (!dryRun) await dh.materialize();

      // now see which files are executable and materialize them appropriately
      this.materializeFoundries(workflow.fcDiscovered.walkedFiles);
    } else {
      console.warn("should be in discovery stage now");
    }

    // we were in "discovery", now move to next stage
    // get all files again by running the contributors, the event handlers know the
    // stage and put state information into the right place
    // this.state.nextStage();
    // await this.discover();
  }

  static instance(
    projectId: string,
    moduleHome: string,
    sprySymlinkDest: string,
  ) {
    return new Engine(projectId, moduleHome, sprySymlinkDest);
  }
}
