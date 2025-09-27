import { dirname, fromFileUrl, join, relative, resolve } from "jsr:@std/path@1";
import { detectLanguageByPath } from "../universal/content/code.ts";
import * as d from "../universal/directive.ts";
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
  LintCatalog,
  ResourceSupplier,
} from "./core.ts";
import { IncludeDirective, includeDirective } from "./include.ts";
import { Resource } from "./resource.ts";

const stages = ["init", "discovery", "materialization"] as const;

export class MaterializationState {
  #fcDiscovered?: FsFilesCollection<MaterializationState>;
  #stage: typeof stages[number];

  constructor() {
    this.#stage = "init";
  }

  get stage() {
    return this.#stage;
  }

  get fcDiscovered() {
    return this.#fcDiscovered;
  }

  nextStage() {
    switch (this.#stage) {
      case "init":
        this.#stage = "discovery";
        this.#fcDiscovered = new FsFilesCollection();
        break;
    }
  }

  // deno-lint-ignore require-await
  async onEncountered(
    ev: Parameters<
      EngineListener<
        EngineEvents<MaterializationState, Resource>,
        "resource:encountered"
      >
    >[0],
  ) {
    if (this.#stage === "discovery") {
      this.#fcDiscovered?.onEncountered(ev.event);
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
      }
    }
  }

  // list (and execute) directives but don't materialize
  // TODO: support more languages
  directives() {
    type SourceFile = {
      resource: FsFileResource & FsWalkedEncounter;
      contentState: "unmodified" | "modified";
    };

    const incDirective = includeDirective<SourceFile>();

    const lcdParsers = new Map<
      string,
      ReturnType<typeof d.lineCommentDirectiveParser>
    >();
    const lcdDefaultParser = d.lineCommentDirectiveParser({
      comment: "--", // e.g. -- #include
      directivePrefix: "#", // e.g. #include
    });

    const replacer = new d.ReplaceStream(incDirective.directive({
      lcdParser: (payload) => {
        const langSpec = detectLanguageByPath(payload.resource.absFsPath);
        if (langSpec) {
          let lcdParser = lcdParsers.get(langSpec.id);
          if (lcdParser) return lcdParser;
          if (langSpec.comment.line.length == 0) {
            console.warn(
              langSpec,
              "has no line comments, using SQL defaults in",
              payload.resource.absFsPath,
            );
            return lcdDefaultParser;
          }
          if (langSpec.comment.line.length > 1) {
            console.warn(
              langSpec,
              "has multiple line comment styles, using first of",
              langSpec.comment.line.join(", "),
              payload.resource.absFsPath,
            );
          }
          lcdParser = d.lineCommentDirectiveParser({
            comment: langSpec.comment.line[0], // e.g. -- #include
            directivePrefix: "#", // e.g. #include
          });
          lcdParsers.set(langSpec.id, lcdParser);
        }
        return lcdDefaultParser;
      },
      onRender: (payload, directive) => {
        return `-- replace ${payload.resource.absFsPath} with ${directive.file}`;
      },
      onError: (payload, _err, _, curLineNo) => {
        console.error(
          `Include materialization error in ${payload.resource.absFsPath} on line ${curLineNo}`,
        );
      },
    }));

    const dryRun = async () => {
      const modified: {
        resource: FsFileResource & FsWalkedEncounter;
        directive: IncludeDirective<SourceFile>;
        beginLineNo: number;
        endLineNo: number;
      }[] = [];

      const emitter = new d.Emitter<
        d.ReplaceStreamEvents<IncludeDirective<SourceFile>, SourceFile>
      >();
      emitter.on(
        "blockRender",
        (i) =>
          modified.push({
            resource: i.payload.resource,
            directive: i.directive,
            beginLineNo: i.beginLineNo,
            endLineNo: i.endLineNo,
          }),
      );
      // TODO: emitter.on("error", () => events.push("error"));

      for await (const resource of this.walkedFiles) {
        const original = await Deno.readTextFile(resource.absFsPath);
        await replacer.processToString(original, {
          resource,
          contentState: "unmodified",
        }, { events: emitter });
      }

      return modified;
    };

    const materialize = async () => {
      for await (const resource of this.walkedFiles) {
        const original = await Deno.readTextFile(resource.absFsPath);
        const result = await replacer.processToString(original, {
          resource,
          contentState: "unmodified",
        });
        if (result.changed && result.after != result.before) {
          await Deno.writeTextFile(resource.absFsPath, result.after);
          console.info("Materialized", resource.absFsPath);
        }
      }
    };

    return { dryRun, materialize };
  }
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

    // register our resource contributors, thse are called when "discover"
    // event is fired
    this.on(
      "resource:contribute",
      fsFilesContributor<MaterializationState, ResSupplierIdentity>({
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

    this.on("resource:encountered", (ev) => ev.event.state.onEncountered(ev));
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

  async materialize() {
    // we start in "init", then move to next stage
    this.state.nextStage();

    // get all files by running the contributors, the event handlers know the
    // stage and put state information into the right place
    await this.discover();

    // directives are able to modify files so let's do that now
    const directives = this.state.fcDiscovered!.directives();
    await directives?.materialize();

    // we were in "discovery", now move to next stage
    // get all files again by running the contributors, the event handlers know the
    // stage and put state information into the right place
    this.state.nextStage();
    await this.discover();
  }

  static instance(moduleHome: string, sprySymlinkDest: string) {
    return new MaterializationEngine(moduleHome, sprySymlinkDest);
  }
}
