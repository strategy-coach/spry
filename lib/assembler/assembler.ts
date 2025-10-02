import { fromFileUrl, resolve } from "jsr:@std/path@1";
import z from "jsr:@zod/zod@4";
import {
  AnnotationCatalog,
  extractAnnotationsFromText,
} from "../universal/content/code-comments.ts";
import { LanguageSpec } from "../universal/content/code.ts";
import { eventBus } from "../universal/event-bus.ts";
import {
  flatten,
  propertiesBag,
  toScreamingSnake,
} from "../universal/properties.ts";
import { includeDirective } from "./directives.ts";
import {
  executables,
  FsFileResource,
  isFsFileResource,
  isFsSrcCodeFileSupplier,
} from "./fs.ts";
import {
  isSrcCodeLangSpecSupplier,
  isTextSupplier,
  Resource,
  ResourcesCollection,
  ResourceSupplier,
  SrcCodeLangSpecSupplier,
  TextProducer,
  TextSupplier,
  zodParsedResourceAnns,
} from "./resource.ts";
import { Route } from "./route.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

export type ResourceEvents<R extends Resource> = {
  "diag:issue:annotations:resource": {
    assemblerState: AssemblerState;
    resource: R;
    supplier: ResourceSupplier<R>;
    annotations?: AnnotationCatalog;
    srcCodeLanguage?: LanguageSpec;
    annsParseResult: ReturnType<typeof zodParsedResourceAnns>;
  };
  "diag:issue:annotations:route": {
    assemblerState: AssemblerState;
    resource: R;
    supplier: ResourceSupplier<R>;
    annotations?: AnnotationCatalog;
    srcCodeLanguage?: LanguageSpec;
    routeParseResult: ReturnType<typeof Route.zodParsedAnnsCatalog>;
  };
  "resource:encountered": {
    assemblerState: AssemblerState;
    resource: R;
    supplier: ResourceSupplier<R>;
    annotations?: AnnotationCatalog;
    srcCodeLanguage?: LanguageSpec;
    resAnnsParseResult?: ReturnType<typeof zodParsedResourceAnns>;
  };
  "resource:mutated": {
    assemblerState: AssemblerState;
    resource: R;
    reason: string;
  };
  "directive:include:materialized": {
    assemblerState: AssemblerState;
    resource: R & SrcCodeLangSpecSupplier;
    contentState: "unmodified" | "modified";
    replacerResult: {
      before: string;
      after: string;
      changed: boolean;
    } | {
      after: string;
      before?: undefined;
      changed?: undefined;
    };
    written: boolean;
  };
  "foundry:materialized": {
    assemblerState: AssemblerState;
    resource: FsFileResource;
    cmd: string;
    env: Record<string, string>;
    cwd: string;
    matAbsFsPath: false | string;
    isCleanable: boolean;
    error?: unknown;
  };
  "assembler:state:mutated": {
    assemblerState: AssemblerState;
    current: WorkflowStep;
    previous: WorkflowStep;
  };
};

export type WorkflowStep =
  | { readonly step: "init" }
  | {
    readonly step: "discovery";
    readonly discovering: ResourcesCollection<Any>;
    readonly discovered: (resource: Resource) => Promise<void>;
  }
  | {
    readonly step: "materialization";
    readonly discovered: ResourcesCollection<Any>;
    readonly materializing: ResourcesCollection<Any>;
    readonly materialized: (resource: Resource) => Promise<void>;
  }
  | {
    readonly step: "final";
    readonly discovered: ResourcesCollection<Any>;
    readonly materialized: ResourcesCollection<Any>;
  };

export class AssemblerState {
  #workflow: WorkflowStep;

  constructor(
    readonly init: { dryRun: boolean; cleaningRequested?: boolean },
  ) {
    this.#workflow = { step: "init" };
  }

  get workflow() {
    return this.#workflow;
  }

  isTerminal() {
    return this.#workflow.step === "final";
  }

  hasNext() {
    const { step } = this.#workflow;
    return step === "init" || step === "discovery" ||
        step === "materialization"
      ? true
      : false;
  }

  createCollection<R extends Resource>() {
    const resources: R[] = [];
    return {
      resources,
      // deno-lint-ignore require-await
      register: async (resource) => {
        resources.push(resource);
      },
    } satisfies ResourcesCollection<R>;
  }

  nextStep(
    resourceBus: ReturnType<typeof eventBus<ResourceEvents<Resource>>>,
  ) {
    const previous = this.#workflow;
    switch (this.#workflow.step) {
      case "init": {
        const fcDiscovering = this.createCollection<Resource>();
        this.#workflow = {
          step: "discovery",
          discovering: fcDiscovering,
          discovered: async (ev) => await fcDiscovering.register(ev),
        };
        resourceBus.emit("assembler:state:mutated", {
          assemblerState: this,
          current: this.#workflow,
          previous,
        });
        return this.#workflow;
      }

      case "discovery": {
        const materializing = this.createCollection<Resource>();
        this.#workflow = {
          step: "materialization",
          discovered: this.#workflow.discovering,
          materializing,
          materialized: async (ev) => await materializing.register(ev),
        };
        resourceBus.emit("assembler:state:mutated", {
          assemblerState: this,
          current: this.#workflow,
          previous,
        });
        return this.#workflow;
      }

      case "materialization":
        this.#workflow = {
          step: "final",
          discovered: this.#workflow.discovered,
          materialized: this.#workflow.materializing,
        };
        resourceBus.emit("assembler:state:mutated", {
          assemblerState: this,
          current: this.#workflow,
          previous,
        });
        return this.#workflow;

      default:
        console.error({ workflow: this.#workflow });
        throw new Error(`Invalid state`);
    }
  }
}

// TODO: remove console.log in favor of EventBus
export function cleaner(
  init: {
    removeDirs?: Iterable<
      { absFsPath: string; recursive: boolean } | {
        absFsPath: string;
        onlyIfEmpty: boolean;
      }
    >;
  },
) {
  const rmDirIfEmpty = async (path: string) => {
    try {
      if ((await Array.fromAsync(Deno.readDir(path))).length === 0) {
        await Deno.remove(path);
      }
      console.log("removed empty directory", path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) { /**ignore */ }
    }
  };

  const rmDirRecursive = async (path: string) => {
    try {
      await Deno.remove(path, { recursive: true });
      console.log("removed directory recursively", path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) { /**ignore */ }
    }
  };

  const clean = async (assembler: Assembler<Resource>) => {
    // remove any fully auto-generated directories
    if (init?.removeDirs) {
      for await (const rdr of init?.removeDirs) {
        if ("recursive" in rdr && rdr.recursive) {
          await rmDirRecursive(rdr.absFsPath);
        }
      }
    }

    assembler.resourceBus.on("foundry:materialized", async (ev) => {
      if (ev.matAbsFsPath) {
        if (ev.isCleanable) {
          try {
            await Deno.remove(ev.matAbsFsPath);
            console.log("removed", ev.matAbsFsPath);
          } catch (error) {
            if (error instanceof Deno.errors.NotFound) return;
            console.info(
              "Error cleaning isCleanable auto-materialized foundry",
              ev.matAbsFsPath,
            );
            console.info(ev.matAbsFsPath);
            console.error(error);
          }
        } else {
          console.log("not cleanable:", ev.matAbsFsPath);
        }
      }
    });

    // run workflow in dryRun to catalog the resources which will call
    // resourceBus.on.materializedFoundry
    await assembler.materialize();

    // now that files have been cleaned, see if there's request for any directory cleanup
    if (init?.removeDirs) {
      for await (const rdr of init.removeDirs) {
        if ("onlyIfEmpty" in rdr && rdr.onlyIfEmpty) {
          await rmDirIfEmpty(rdr.absFsPath);
        }
      }
    }
  };

  return { rmDirIfEmpty, rmDirRecursive, clean };
}

export interface AssemblerBusesInit<R extends Resource> {
  resources: ReturnType<typeof eventBus<ResourceEvents<R>>>;
}

export function assemblerBusesInit<R extends Resource>(
  defaults?: Partial<AssemblerBusesInit<R>>,
): AssemblerBusesInit<R> {
  const resources = eventBus<ResourceEvents<R>>();

  resources.on("resource:encountered", (ev) => {
    if (ev.annotations) {
      if (ev.resAnnsParseResult?.error) {
        resources.emit("diag:issue:annotations:resource", {
          resource: ev.resource,
          annsParseResult: ev.resAnnsParseResult,
          assemblerState: ev.assemblerState,
          supplier: ev.supplier,
          srcCodeLanguage: ev.srcCodeLanguage,
        });
      }
      if (isFsFileResource(ev.resource)) {
        const safeParse = Route.fromFsFileResource(
          ev.resource,
          ev.annotations,
        );
        if (safeParse?.success) {
          // this adds resource.route so isRouteSupplier will be true
          const route = new Route(safeParse.data, ev.annotations);
          route.mutateAsRouteSupplier(ev.resource);
          resources.emit("resource:mutated", {
            assemblerState: ev.assemblerState,
            resource: ev.resource,
            reason: "Route detected",
          });
        } else {
          if (ev.resAnnsParseResult?.error) {
            resources.emit("diag:issue:annotations:route", {
              resource: ev.resource,
              routeParseResult: safeParse,
              assemblerState: ev.assemblerState,
              supplier: ev.supplier,
              srcCodeLanguage: ev.srcCodeLanguage,
            });
          }
        }
      }
    }

    const { workflow } = ev.assemblerState;
    switch (workflow.step) {
      case "discovery":
        workflow.discovered(ev.resource);
        break;

      case "materialization":
        workflow.materialized(ev.resource);
        break;

      default:
        console.warn("Not sure why we're here?");
    }
  });

  return { ...defaults, resources };
}

export const typicalProjectPathsSchema = z.object({
  projectHome: z.string().describe("The home path for our entire project"),
  projectSrcHome: z.string().describe("The 'src' path for entire project"),
});

export const typicalAssemblerProjectPropsSchema = z.object({
  projectId: z.string().describe("Project ID"),
  projectPaths: typicalProjectPathsSchema.describe("Project paths"),
});

export class Assembler<R extends Resource> {
  #state: AssemblerState;
  #suppliersSignal?: AbortSignal;
  #suppliers: ResourceSupplier<R>[] = [];

  readonly executables = executables();

  constructor(
    readonly projectId: string,
    readonly moduleHome: string, // import.meta.resolve('./') from module
    readonly assemblerBuses: AssemblerBusesInit<R>,
    readonly init: { dryRun: boolean; cleaningRequested?: boolean },
  ) {
    this.#state = new AssemblerState(init);
  }

  get resourceBus() {
    return this.assemblerBuses.resources;
  }

  withSupplierSignal(signal: AbortSignal) {
    this.#suppliersSignal = signal;
  }

  withSuppliers(...suppliers: ResourceSupplier<R>[]) {
    this.#suppliers.push(...suppliers);
    return this;
  }

  async emitResources() {
    for await (const supplier of this.#suppliers) {
      for await (
        const resource of supplier({ signal: this.#suppliersSignal })
      ) {
        if (this.#suppliersSignal?.aborted) break;

        let annsParseResult:
          | ReturnType<typeof zodParsedResourceAnns>
          | undefined;
        let resAnn: Resource | undefined;
        let annotations:
          | Awaited<ReturnType<typeof extractAnnotationsFromText>>
          | undefined;
        let srcCodeLanguage: LanguageSpec | undefined;
        if (
          isTextSupplier(resource) &&
          isSrcCodeLangSpecSupplier(resource)
        ) {
          srcCodeLanguage = resource.srcCodeLanguage;
          annotations = await extractAnnotationsFromText(
            await resource.text(),
            srcCodeLanguage,
            {
              tags: { multi: true, valueMode: "json" },
              kv: false,
              yaml: false,
              json: false,
            },
          );
          annsParseResult = zodParsedResourceAnns(annotations, {
            nature: "unknown",
            isParsedSuccessfully: true,
            isSystemGenerated: false,
          });

          // the resource annoations `resAnn` will be spread into Resource below
          resAnn = annsParseResult?.success
            ? annsParseResult.data
            : (annsParseResult?.error
              ? {
                isParsedSuccessfully: false,
                isSystemGenerated: false,
                nature: "invalid:annotations",
                error: z.prettifyError(annsParseResult.error),
              }
              : undefined);
        }

        this.assemblerBuses.resources.emit("resource:encountered", {
          assemblerState: this.#state,
          // the resource will now be an AnnotationsSupplier, too
          resource: { ...resource, ...resAnn, annotations },
          supplier,
          annotations,
          srcCodeLanguage,
          resAnnsParseResult: annsParseResult,
        });
      }
    }
    return this;
  }

  projectPaths(
    projectHome = this.moduleHome.startsWith("file:")
      ? fromFileUrl(this.moduleHome)
      : this.moduleHome,
  ) {
    const projectSrcHome = resolve(projectHome, "src");
    return { projectHome, projectSrcHome };
  }

  // subclasses should override for their own schemas
  projectStatePropertiesBag() {
    return propertiesBag(typicalAssemblerProjectPropsSchema);
  }

  /** Single source: validate & store id + base paths; return hierarchical object for JSON. */
  projectStateProperties() {
    const props = {
      projectId: this.projectId,
      projectPaths: this.projectPaths(),
    };
    // validate + cache in the bag (Zod coerces/strips unknowns if any)
    const bag = this.projectStatePropertiesBag();
    bag.set("projectId", props.projectId);
    bag.set("projectPaths", props.projectPaths);
    return { props, bag }; // keep hierarchy for JSON
  }

  /**
   * Derive ENV/SQL vars by flattening whatever `projectStateProperties()` returns.
   */
  projectStateEnvVars(opts?: { debug: boolean }) {
    const { bag, props } = this.projectStateProperties();
    const flattened = flatten(bag);
    const envVars = flattened.record("FOUNDRY_", props, {
      name: (segs) =>
        segs.map((s) => s == "projectPaths" ? "PATH" : toScreamingSnake(s))
          .join("_"),
    });
    if (opts?.debug) {
      envVars["FOUNDRY_ASSEMBLER_STATE_CLEANING_REQUESTED"] =
        "<will be set to TRUE if 'clean' is passed into state>";
    } else {
      if (this.#state.init.cleaningRequested) {
        envVars["FOUNDRY_ASSEMBLER_STATE_CLEANING_REQUESTED"] = "TRUE";
      }
    }
    return envVars;
  }

  async materializeDirectives(
    srcFiles: Iterable<
      & TextSupplier
      & SrcCodeLangSpecSupplier
      & { absFsPath: string }
      & TextProducer
    >,
  ) {
    type ElementOfIterable<I> = I extends Iterable<infer T> ? T : never;
    type SourceFile = {
      resource: ElementOfIterable<typeof srcFiles>;
      contentState: "unmodified" | "modified";
    };
    const { replacer } = includeDirective<SourceFile>();

    for await (const resource of srcFiles) {
      const original = await resource.text();
      const state = {
        resource,
        contentState: "unmodified",
      } satisfies SourceFile;
      const result = await replacer.processToString(original, state);
      let written = false;
      if (
        !this.#state.init.dryRun &&
        (result.changed && result.after != result.before)
      ) {
        await resource.writeText(result.after);
        written = true;
      }
      this.resourceBus.emit("directive:include:materialized", {
        assemblerState: this.#state,
        resource: resource as R & ElementOfIterable<typeof srcFiles>,
        replacerResult: result,
        written,
        contentState: state.contentState,
      });
    }
  }

  async materializeFoundries(
    candidates: Iterable<FsFileResource>,
  ) {
    // now see which files are executable and materialize them appropriately
    const { isExecutable, materialize } = this.executables;

    // when cleaning is requested, we can "auto clean" auto-materialized but
    // foundries that create unmanaged (by Spry) files do their own cleaning
    // by being told through the environment
    const env = this.projectStateEnvVars();
    const cwd = Deno.cwd();

    for await (const wf of candidates) {
      if (wf.nature === "foundry") {
        if (!isExecutable(wf.absFsPath)) {
          // TODO: emit as a diagnostic
          console.error("foundry", wf.relFsPath, "is not executable");
        } else {
          let error: unknown | undefined;
          const matAbsFsPath = wf.extensions.autoMaterializable();
          materialize({
            absFsPath: wf.absFsPath,
            matAbsFsPath,
            env,
            cwd,
            dryRun: this.#state.init.dryRun,
          }, (err) => error = err);
          this.resourceBus.emit("foundry:materialized", {
            assemblerState: this.#state,
            resource: wf,
            cmd: wf.absFsPath,
            matAbsFsPath,
            env,
            cwd,
            error,
            isCleanable: wf.isCleanable ? true : false,
          });
        }
      }
    }
  }

  /**
   * Two-phase materialization -- discover first, perform first-pass of file
   * preparation and then run the exact process again on the "final" set of
   * artifacts. Might converge this into a single-pass at some point but the
   * two-pass model gives more flexibility.
   * @param args
   */
  async materialize() {
    // we start in "init", then move to next stage
    let workflow = this.#state.nextStep(this.resourceBus);
    if (workflow?.step === "discovery") {
      // start the resources events bus
      await this.emitResources();

      // directives are able to modify files so let's do that now
      await this.materializeDirectives(
        workflow.discovering.resources.filter(
          isFsSrcCodeFileSupplier,
        ),
      );

      // now see which files are executable and materialize them appropriately
      this.materializeFoundries(
        workflow.discovering.resources.filter(isFsFileResource),
      );
    } else {
      console.warn("should be in discovery stage now");
    }

    // we were in "discovery", now move to next stage
    // get all files again by running the suppliers, the event handlers know the
    // stage and put state information into the right place
    workflow = this.#state.nextStep(this.resourceBus);
    if (workflow?.step === "materialization") {
      // restart the resources events bus
      await this.emitResources();

      // directives are able to modify files so let's do that again
      await this.materializeDirectives(
        workflow.materializing.resources.filter(
          isFsSrcCodeFileSupplier,
        ),
      );

      // now see which files are executable and materialize them again
      this.materializeFoundries(
        workflow.materializing.resources.filter(isFsFileResource),
      );
    } else {
      console.warn("should be in materialization stage now");
    }

    workflow = this.#state.nextStep(this.resourceBus);
    console.assert(this.#state.isTerminal(), "Should be in terminal state");
  }
}
