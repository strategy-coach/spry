import { dirname, fromFileUrl, join, relative, resolve } from "jsr:@std/path@1";
import {
  executableCandidate,
  FsFileResource,
  fsFilesContributor,
  FsWalkedEncounter,
  isFsFileResource,
  isFsWalkedEncounter,
} from "./core-fs.ts";
import {
  Engine,
  EngineEvents,
  EngineListener,
  isSrcCodeLangSpecSupplier,
  LintCatalog,
  ResourceSupplier,
  SrcCodeLangSpecSupplier,
} from "./core.ts";
import { directives as directivesHanders } from "./directives.ts";
import { Resource } from "./resource.ts";

type WorkflowState =
  | { stage: "init" }
  | {
    stage: "discovery";
    fcDiscovered: FsFilesCollection<EngineState>;
    registerDiscovery: (
      ev: Parameters<
        EngineListener<
          EngineEvents<EngineState, Resource>,
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
        EngineListener<
          EngineEvents<EngineState, Resource>,
          "resource:encountered"
        >
      >[0],
    ) => Promise<void>;
  };

class EngineState {
  #workflow: WorkflowState;

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

export const resSupplierIdentity = ["PROJECT_HOME"] as const;
export type ResSupplierIdentity = typeof resSupplierIdentity[number];

export class FsFilesCollection<State> {
  readonly suppliers = new Set<ResourceSupplier<State, Resource>>();
  readonly resources: readonly Resource[] = [];
  readonly fsFiles: readonly FsFileResource[] = [];
  readonly walkedFiles: readonly (FsFileResource & FsWalkedEncounter)[] = [];
  readonly walkedSrcFiles:
    readonly (FsFileResource & FsWalkedEncounter & SrcCodeLangSpecSupplier)[] =
      [];
  readonly execCandidate = executableCandidate();
  readonly isExecutable = this.execCandidate.isExecutable;

  constructor() {
  }

  // deno-lint-ignore require-await
  async onEncountered(
    ev: Parameters<
      EngineListener<
        EngineEvents<State, Resource>,
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
          (this
            .walkedSrcFiles as (
              & FsFileResource
              & FsWalkedEncounter
              & SrcCodeLangSpecSupplier
            )[]).push(resource);
        }
      }
    }
  }
}

export class MaterializationEngine extends Engine<EngineState, LintCatalog> {
  readonly paths: ReturnType<MaterializationEngine["projectPaths"]>;

  protected constructor(
    readonly moduleHome: string, // import.meta.resolve('./') from module
    readonly stdlibSymlinkDest: string, // relative dest to stdlib
  ) {
    super(new EngineState());
    this.paths = this.projectPaths();

    // register our resource contributors, thse are called when "discover"
    // event is fired
    this.on(
      "resource:contribute",
      fsFilesContributor<EngineState, ResSupplierIdentity>({
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

    this.on("resource:encountered", (ev) => {
      const { workflow } = this.state;
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

  async materialize(args?: { readonly dryRun?: boolean }) {
    const { dryRun = false } = args ?? {};

    // we start in "init", then move to next stage
    const workflow = this.state.nextStage();

    if (workflow?.stage === "discovery") {
      // get all files by running the contributors, the event handlers know the
      // stage and put state information into the right place
      await this.discover();

      // directives are able to modify files so let's do that now
      const dh = directivesHanders(workflow.fcDiscovered.walkedSrcFiles);
      if (!dryRun) await dh.materialize();
    } else {
      console.warn("should be in discovery stage now");
    }

    // we were in "discovery", now move to next stage
    // get all files again by running the contributors, the event handlers know the
    // stage and put state information into the right place
    // this.state.nextStage();
    // await this.discover();
  }

  static instance(moduleHome: string, sprySymlinkDest: string) {
    return new MaterializationEngine(moduleHome, sprySymlinkDest);
  }
}
