import { dirname, fromFileUrl, join, relative, resolve } from "jsr:@std/path@1";
import {
    AnnotationCatalog,
    extractAnnotationsFromText,
} from "../universal/content/code-comments.ts";
import { LanguageSpec } from "../universal/content/code.ts";
import { eventBus, EventMap } from "../universal/event-bus.ts";
import { includeDirective } from "./directives.ts";
import {
    executables,
    FsFileResource,
    fsFilesContributor,
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

export interface DiagnosticEvents<R extends Resource> extends EventMap {
    resourceAnnsIssue: {
        engineState: EngineState;
        resource: R;
        supplier: ResourceSupplier<R>;
        annsCatalog?: AnnotationCatalog;
        srcCodeLanguage?: LanguageSpec;
        annsParseResult: ReturnType<typeof zodParsedResourceAnns>;
    };
    routeAnnsIssue: {
        engineState: EngineState;
        resource: R;
        supplier: ResourceSupplier<R>;
        annsCatalog?: AnnotationCatalog;
        srcCodeLanguage?: LanguageSpec;
        routeParseResult: ReturnType<typeof Route.zodParsedAnnsCatalog>;
    };
}

export interface ResourceEvents<R extends Resource> extends EventMap {
    resource: {
        engineState: EngineState;
        resource: R;
        supplier: ResourceSupplier<R>;
        annsCatalog?: AnnotationCatalog;
        srcCodeLanguage?: LanguageSpec;
        resAnnsParseResult?: ReturnType<typeof zodParsedResourceAnns>;
    };
    resourceMutated: {
        engineState: EngineState;
        resource: R;
        reason: string;
    };
    materializedInclude: {
        engineState: EngineState;
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
        dryRun?: boolean;
    };
    materializedFoundry: {
        engineState: EngineState;
        resource: FsFileResource;
        cmd: string;
        env: Record<string, string>;
        cwd: string;
        matAbsFsPath: false | string;
        error?: unknown;
        dryRun?: boolean;
    };
    engineStateChange: {
        engineState: EngineState;
        current: WorkflowStep;
        previous: WorkflowStep;
    };
}

export type WorkflowStep =
    | { readonly step: "init" }
    | {
        readonly step: "discovery";
        readonly discovering: ResourcesCollection<Resource>;
        readonly discovered: (resource: Resource) => Promise<void>;
    }
    | {
        readonly step: "materialization";
        readonly discovered: ResourcesCollection<Resource>;
        readonly materializing: ResourcesCollection<Resource>;
        readonly materialized: (resource: Resource) => Promise<void>;
    }
    | {
        readonly step: "final";
        readonly discovered: ResourcesCollection<Resource>;
        readonly materialized: ResourcesCollection<Resource>;
    };

export class EngineState {
    #workflow: WorkflowStep;

    constructor() {
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
        // deno-lint-ignore no-explicit-any
        resourceBus: ReturnType<typeof eventBus<ResourceEvents<any>>>,
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
                resourceBus.emit.engineStateChange({
                    engineState: this,
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
                    materialized: async (ev) =>
                        await materializing.register(ev),
                };
                resourceBus.emit.engineStateChange({
                    engineState: this,
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
                resourceBus.emit.engineStateChange({
                    engineState: this,
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

export interface EngineBusesInit<R extends Resource> {
    resources: ReturnType<typeof eventBus<ResourceEvents<R>>>;
    diagnostics: ReturnType<typeof eventBus<DiagnosticEvents<R>>>;
}

export function engineBusesInit<R extends Resource>(
    defaults?: Partial<EngineBusesInit<R>>,
): EngineBusesInit<R> {
    const resources = eventBus<ResourceEvents<R>>();
    const diagnostics = eventBus<DiagnosticEvents<R>>();

    resources.on.resource((ev) => {
        if (ev.annsCatalog) {
            if (ev.resAnnsParseResult?.error) {
                diagnostics.emit.resourceAnnsIssue({
                    resource: ev.resource,
                    annsParseResult: ev.resAnnsParseResult,
                    engineState: ev.engineState,
                    supplier: ev.supplier,
                    srcCodeLanguage: ev.srcCodeLanguage,
                });
            }
            if (isFsFileResource(ev.resource)) {
                const safeParse = Route.fromFsFileResource(
                    ev.resource,
                    ev.annsCatalog,
                );
                if (safeParse?.success) {
                    // this adds resource.route so isRouteSupplier will be true
                    const route = new Route(safeParse.data, ev.annsCatalog);
                    route.mutateAsRouteSupplier(ev.resource);
                    resources.emit.resourceMutated({
                        engineState: ev.engineState,
                        resource: ev.resource,
                        reason: "Route detected",
                    });
                } else {
                    if (ev.resAnnsParseResult?.error) {
                        diagnostics.emit.routeAnnsIssue({
                            resource: ev.resource,
                            routeParseResult: safeParse,
                            engineState: ev.engineState,
                            supplier: ev.supplier,
                            srcCodeLanguage: ev.srcCodeLanguage,
                        });
                    }
                }
            }
        }

        const { workflow } = ev.engineState;
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

    return { ...defaults, resources, diagnostics };
}

export class Engine<R extends Resource> {
    #state: EngineState;
    #suppliersSignal?: AbortSignal;
    #suppliers: ResourceSupplier<R>[] = [];

    readonly paths: ReturnType<Engine<R>["projectPaths"]>;
    readonly executables = executables();

    constructor(
        readonly projectId: string,
        readonly moduleHome: string, // import.meta.resolve('./') from module
        readonly stdlibSymlinkDest: string,
        readonly engineBuses: EngineBusesInit<R>,
    ) {
        this.#state = new EngineState();
        this.paths = this.projectPaths();
    }

    get resourceBus() {
        return this.engineBuses.resources;
    }

    withSupplierSignal(signal: AbortSignal) {
        this.#suppliersSignal = signal;
    }

    withSuppliers(...suppliers: ResourceSupplier<R>[]) {
        this.#suppliers.push(...suppliers);
        return this;
    }

    // deno-lint-ignore require-await
    protected async initDefaults() {
        const resourceSupplierIdentity = ["PROJECT_HOME"] as const;
        type ResourceSupplierIdentity = typeof resourceSupplierIdentity[number];

        if (this.#suppliers.length == 0) {
            this.withSuppliers(fsFilesContributor<R, ResourceSupplierIdentity>({
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
                webPath: (path) =>
                    this.relToPrjOrStd(path).replace(/^.*src\//, ""),
            }));
        }
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
                let annsCatalog:
                    | Awaited<ReturnType<typeof extractAnnotationsFromText>>
                    | undefined;
                let srcCodeLanguage: LanguageSpec | undefined;
                if (
                    isTextSupplier(resource) &&
                    isSrcCodeLangSpecSupplier(resource)
                ) {
                    srcCodeLanguage = resource.srcCodeLanguage;
                    annsCatalog = await extractAnnotationsFromText(
                        await resource.text(),
                        srcCodeLanguage,
                        {
                            tags: { multi: true, valueMode: "json" },
                            kv: false,
                            yaml: false,
                            json: false,
                        },
                    );
                    annsParseResult = zodParsedResourceAnns(annsCatalog, {
                        isSystemGenerated: false,
                    });
                    resAnn = annsParseResult?.success
                        ? annsParseResult.data
                        : undefined;
                }

                this.engineBuses.resources.emit.resource({
                    engineState: this.#state,
                    resource: { ...resource, ...resAnn },
                    supplier,
                    annsCatalog,
                    srcCodeLanguage,
                    resAnnsParseResult: annsParseResult,
                });
            }
        }
        return this;
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
        result[`${projectVarPrefix}WORKFLOW_STEP`] = this.#state.workflow.step;
        result[`${projectVarPrefix}PATHS_JSON`] = JSON.stringify(paths);
        for (const [k, v] of Object.entries(projectVars)) {
            if (typeof k === "string") {
                result[`${projectVarPrefix}${k}`] = String(v);
            }
        }
        for (const [k, v] of Object.entries(pathVars)) {
            if (typeof k === "string") {
                result[`${pathVarPrefix}${k}`] = String(v);
            }
        }
        return result;
    }

    async materializeDirectives(
        srcFiles: Iterable<
            & TextSupplier
            & SrcCodeLangSpecSupplier
            & { absFsPath: string }
            & TextProducer
        >,
        args?: { readonly dryRun?: boolean },
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
                !args?.dryRun &&
                (result.changed && result.after != result.before)
            ) {
                await resource.writeText(result.after);
                written = true;
            }
            this.resourceBus.emit.materializedInclude({
                engineState: this.#state,
                resource: resource as R & ElementOfIterable<typeof srcFiles>,
                replacerResult: result,
                dryRun: args?.dryRun,
                written,
                contentState: state.contentState,
            });
        }
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
                        dryRun: args?.dryRun,
                    }, (err) => error = err);
                    this.resourceBus.emit.materializedFoundry({
                        engineState: this.#state,
                        resource: wf,
                        cmd: wf.absFsPath,
                        matAbsFsPath,
                        env,
                        cwd,
                        dryRun: args?.dryRun,
                        error,
                    });
                }
            }
        }
    }

    async materialize(args?: { readonly dryRun?: boolean }) {
        // TODO: this seems to have a lot of copy/paste of code?
        // TODO: publish events before/after/etc. stage changes and other works
        // TODO: refine how dryRun works
        // TODO: add linting
        // TODO: add observability for CLI directly into resources?

        // in the caller did not setup any suppliers or other options, use sane defaults
        await this.initDefaults();

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
                args,
            );

            // now see which files are executable and materialize them appropriately
            this.materializeFoundries(
                workflow.discovering.resources.filter(isFsFileResource),
                args,
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

            // directives are able to modify files so let's do that now
            await this.materializeDirectives(
                workflow.materializing.resources.filter(
                    isFsSrcCodeFileSupplier,
                ),
                args,
            );

            // now see which files are executable and materialize them appropriately
            this.materializeFoundries(
                workflow.materializing.resources.filter(isFsFileResource),
                args,
            );
        } else {
            console.warn("should be in materialization stage now");
        }

        workflow = this.#state.nextStep(this.resourceBus);
        console.assert(this.#state.isTerminal(), "Should be in terminal state");
    }

    static instance(
        projectId: string,
        moduleHome: string,
        sprySymlinkDest: string,
        engineBuses = engineBusesInit(),
    ) {
        return new Engine(
            projectId,
            moduleHome,
            sprySymlinkDest,
            engineBuses,
        );
    }
}
