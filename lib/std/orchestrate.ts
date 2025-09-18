#!/usr/bin/env -S deno run -A

import {
    basename,
    dirname,
    extname,
    fromFileUrl,
    isAbsolute,
    join,
    normalize,
    relative,
} from "jsr:@std/path@1";
import { ensureDir } from "jsr:@std/fs@^1/ensure-dir";
import * as colors from "jsr:@std/fmt@1/colors";
import { z } from "jsr:@zod/zod@4";
import { Command } from "jsr:@cliffy/command@1.0.0-rc.8";
import {
    prepareCapExecsFs,
    type PrepareMode,
} from "../universal/cap-exec/mod.ts";
import { type FSWalkSpec, walkFS } from "../universal/walk/mod.ts";
import {
    type AnnotationItem,
    extractAnnotationsFromText,
} from "../universal/content/code-comments.ts";
import { detectLanguageByPath } from "../universal/content/code.ts";
import { MarkdownStore } from "../universal/markdown.ts";
import { defineRegistry, defineRule, LintResults } from "../universal/lint.ts";
import { omitPathsReplacer } from "../universal/json.ts";
import {
    pathTree,
    pathTreeNavigation,
    pathTreeSerializers,
} from "../universal/path-tree.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

type YieldOf<T extends (...args: Any) => Any> = Awaited<ReturnType<T>> extends
    AsyncGenerator<infer Y, Any, Any> ? Y
    : Awaited<ReturnType<T>> extends AsyncIterableIterator<infer Y> ? Y
    : never;

const SRC = "src" as const;

/**
 * Basic filesystem store. Writes text/bytes to caller-provided RELATIVE paths under destRoot.
 * No atomic temp/rename; just ensure dirs and write.
 */
export class Store<I extends string> {
    readonly destRoot: string;

    constructor(destRoot: string) {
        this.destRoot = normalize(destRoot);
    }

    /**
     * Write text content to a relative path (typed by I).
     * Returns the absolute path written.
     */
    async writeText(relPath: I, text: string): Promise<string> {
        const bytes = new TextEncoder().encode(text);
        return await this.writeBytes(relPath, bytes);
    }

    /**
     * Write binary content to a relative path (typed by I).
     * Returns the absolute path written.
     */
    async writeBytes(relPath: I, bytes: Uint8Array): Promise<string> {
        const abs = this.resolveRel(relPath);
        await ensureDir(dirname(abs));
        await Deno.writeFile(abs, bytes);
        return abs;
    }

    // ---------- overridables kept inside the class ----------

    protected resolveRel(relPath: string): string {
        if (isAbsolute(relPath)) {
            throw new Error(
                `Expected a relative path, got absolute: ${relPath}`,
            );
        }
        const normRel = normalize(relPath);
        if (normRel.startsWith("../")) {
            throw new Error(`Path escapes store root: ${relPath}`);
        }
        return normalize(join(this.destRoot, normRel));
    }
}

/**
 * JSON convenience wrapper. Optionally validates with Zod before writing.
 */
export class JsonStore<
    I extends string,
    Z extends z.ZodTypeAny | undefined = undefined,
> {
    constructor(
        readonly store: Store<I>,
        readonly schema?: Z,
        readonly init?: { readonly pretty?: boolean },
    ) {
    }

    async write(
        relPath: I,
        value: Z extends z.ZodTypeAny ? z.infer<NonNullable<Z>> : unknown,
        replacer?: (this: Any, key: string, value: Any) => Any,
    ): Promise<string> {
        const validated = this.validate(value);
        const json = this.init?.pretty
            ? JSON.stringify(validated, replacer, 2)
            : JSON.stringify(validated, replacer);
        return await this.store.writeText(relPath, json);
    }

    protected validate(value: unknown): unknown {
        if (!this.schema) return value;
        return (this.schema as z.ZodTypeAny).parse(value);
    }
}

export interface WalkSpecsSupplier {
    readonly walkSpecs: () => Iterable<FSWalkSpec>;
}

export class SqlPageFiles implements WalkSpecsSupplier {
    constructor(readonly importMetaMainHome: string) {
    }

    walkSpecs() {
        return [{
            identity: "local-sql",
            root: "./src",
            include: ["**/*.sql"],
            baseDir: this.importMetaMainHome,
        }, {
            identity: "stdlib-sql",
            root: "./src/spry", // this is symlink and won't be found in ./src by default
            include: ["**/*.sql"],
            baseDir: this.importMetaMainHome,
        }];
    }

    async *sources() {
        yield* walkFS({ specs: this.walkSpecs() });
    }
}

const spryEntryAnnCommon = {
    absPath: z.string(),
    relPath: z.string(),
    documentation: z.json().optional(),
};

export const spryResourceNature = "resource" as const;
export const spryEntryAnnSchema = z.discriminatedUnion("nature", [
    z.object({
        nature: z.literal("action").describe(
            "Code that executes an action and redirects back to a page.",
        ),
        ...spryEntryAnnCommon,
    }),
    z.object({
        nature: z.literal("api").describe(
            "An API endpoint exposed by the system.",
        ),
        ...spryEntryAnnCommon,
    }),
    z.object({
        nature: z.literal("page").describe(
            "A standard SQLPage server-side generated (SSG) page, this is the default.",
        ),
        ...spryEntryAnnCommon,
    }),
    z.object({
        nature: z.literal("partial").describe(
            "Part of a standard SQLPage SSG page which is usually imported into other SQLPage pages using `run_sql`.",
        ),
        ...spryEntryAnnCommon,
    }),
    z.object({
        nature: z.literal(spryResourceNature).describe(
            "A data resource",
        ),
        sqlImpact: z.enum(["unknown", "json"]).describe(
            "Specifies the type of resource.",
        ),
        ...spryEntryAnnCommon,
    }),
    z.object({
        nature: z.literal("sql").describe(
            "A SQL stored procedure, requiring `sqlImpact` to specify whether it's DQL, DML, or DDL.",
        ),
        sqlImpact: z.enum(["dql", "dml", "ddl"]).describe(
            "Specifies the type of SQL impact: DQL (read/query), DML (insert/update/delete), or DDL (schema changes).",
        ),
        ...spryEntryAnnCommon,
    }),
]).describe(
    `The nature of this file influences how it's treated by the system. 
   Possible values are:
   - 'action' for SQLPage code that executes and redirects back to a page
   - 'api' for SQLPage API endpoints
   - 'resource' for JSON or other types of data
   - 'page' for standard SQLPage SSG pages (default)
   - 'partial' for SQLPage SSG partials, usually imported into other pages
   - 'sql' for SQL stored procedures, requiring 'sqlImpact'.`,
);

export const spryRouteAnnSchema = z.object({
    path: z.string().describe(
        "Logical route path; the primary key within a namespace.",
    ),
    pathBasename: z.string().optional().describe(
        "The path's basename without any directory path (usually computed by default from path)",
    ),
    pathBasenameNoExtn: z.string().optional().describe(
        "The path's basename without any directory path or extension (usually computed by default from path)",
    ),
    pathDirname: z.string().optional().describe(
        "The path's dirname without any name (usually computed by default from path)",
    ),
    pathExtnTerminal: z.string().optional().describe(
        "The path's terminal (last) extension (like .sql, usually computed by default from path)",
    ),
    pathExtns: z.string().optional().describe(
        "The path's full set of extensions if there multiple (like .sql.ts, usually computed by default from path)",
    ),
    caption: z.string().describe(
        "Human-friendly general-purpose name for display.",
    ),
    siblingOrder: z.number().optional().describe(
        "Optional integer to order children within the same parent.",
    ),
    url: z.string().optional().describe(
        "Optional external or alternate link target; defaults to using `path` when omitted.",
    ),
    title: z.string().optional().describe(
        "Full/long title for detailed contexts; defaults to `caption` when omitted.",
    ),
    abbreviatedCaption: z.string().optional().describe(
        "Short label for breadcrumbs or compact UIs; defaults to `caption` when omitted.",
    ),
    description: z.string().optional().describe(
        "Long-form explanation or summary of the route.",
    ),
    elaboration: z.json().optional().describe(
        'Optional structured attributes (e.g., { "target": "_blank", "lang": { "fr": { "caption": "..." } } }).',
    ),
}).strict().describe(
    "Navigation route annotation, supports hierarchy and ordered siblings.",
);

export type SpryEntryAnnotation = z.infer<typeof spryEntryAnnSchema>;
export type SpryRouteAnnotation = z.infer<typeof spryRouteAnnSchema>;

export class Annotations implements WalkSpecsSupplier {
    // usually `fromFileUrl(import.meta.resolve("./"))` of module constructing class
    constructor(
        readonly importMetaMainHome: string,
        readonly init?: {
            readonly transformEntryAnn?: (
                enc: SpryEntryAnnotation,
            ) => SpryEntryAnnotation | Promise<SpryEntryAnnotation>;
            readonly transformRouteAnn?: (
                enc: SpryRouteAnnotation,
            ) => SpryRouteAnnotation | Promise<SpryRouteAnnotation>;
        },
    ) {
    }

    walkSpecs() {
        return [{
            identity: "local-sql",
            root: "./src",
            include: ["**/*.sql"],
            baseDir: this.importMetaMainHome,
        }, {
            identity: "stdlib-sql",
            root: "./src/spry", // this is symlink and won't be found in ./src by default
            include: ["**/*.sql"],
            baseDir: this.importMetaMainHome,
        }];
    }

    async *sources() {
        yield* walkFS({ specs: this.walkSpecs() });
    }

    async safeAnnGroup<S extends z.ZodTypeAny, Payload>(
        schema: S,
        prefix: string,
        catalog: Awaited<
            ReturnType<typeof extractAnnotationsFromText<Payload>>
        >,
        transform?: (supplied: z.input<S>) => z.input<S> | Promise<z.input<S>>,
        defaults?: Partial<z.input<S>>,
    ) {
        const prefixedItems = catalog.items
            .filter((it) => it.kind === "tag" && it.key?.startsWith(prefix));
        const entries = prefixedItems.map((it) =>
            [it.key!.slice(prefix.length), it.value ?? it.raw] as const
        );
        const found = entries.length;
        if (found == 0) {
            return { parsed: undefined, error: undefined, found };
        }

        const anns = Object.fromEntries(
            prefixedItems.map((it) =>
                [it.key!.slice(prefix.length), it] as const
            ),
        ) as Partial<Record<keyof z.input<S>, AnnotationItem>>;

        const grouped = {
            ...defaults,
            ...Object.fromEntries(entries),
        } as z.input<S>;
        const result = schema.safeParse(
            transform ? await transform(grouped) : grouped,
        );

        return result.success
            ? { parsed: result.data, error: undefined, found, anns }
            : { parsed: undefined, error: result.error, found, anns };
    }

    async entryAnnFromCatalog(
        we: YieldOf<typeof this.sources>,
        anns: Awaited<ReturnType<typeof extractAnnotationsFromText>>,
    ) {
        return await this.safeAnnGroup(
            spryEntryAnnSchema,
            "spry.",
            anns,
            this.init?.transformEntryAnn,
            {
                "nature": "page",
                "absPath": we.item.path,
                "relPath": we.payload.relPath,
            },
        );
    }

    async routeAnnFromCatalog(
        we: YieldOf<typeof this.sources>,
        anns: Awaited<ReturnType<typeof extractAnnotationsFromText>>,
    ) {
        const pathBasename = basename(we.payload.relPath);
        return await this.safeAnnGroup(
            spryRouteAnnSchema,
            "route.",
            anns,
            this.init?.transformRouteAnn,
            {
                "path": we.payload.relPath,
                "pathBasename": pathBasename,
                "pathBasenameNoExtn": pathBasename.split(".")[0],
                "pathDirname": dirname(we.payload.relPath),
                "pathExtnTerminal": extname(pathBasename),
                "pathExtns":
                    (pathBasename.includes(".")
                        ? pathBasename.split(".").slice(1).map((e) => "." + e)
                        : []).join(""),
            },
        );
    }

    async *catalog() {
        for await (const we of this.sources()) {
            const anns = await extractAnnotationsFromText(
                await Deno.readTextFile(we.item.path),
                detectLanguageByPath(we.item.path)!, // give sane default
                {
                    tags: { multi: true, valueMode: "json" },
                    kv: false,
                    yaml: false,
                    json: false,
                },
            );

            yield {
                walkEntry: we,
                annotations: anns,
                entryAnn: await this.entryAnnFromCatalog(we, anns),
                routeAnn: await this.routeAnnFromCatalog(we, anns),
            };
        }
    }
}

export class Routes {
    constructor(readonly routeAnns: Iterable<SpryRouteAnnotation>) {
    }

    async populate() {
        const forest = await pathTree<SpryRouteAnnotation, string>(
            this.routeAnns,
            {
                nodePath: (n) => n.path,
                pathDelim: "/",
                synthesizeContainers: true,
                folderFirst: false,
                indexBasenames: ["index.sql"],
            },
        );

        const tree = forest.roots;
        const nav = pathTreeNavigation(forest);
        const serializers = {
            ...pathTreeSerializers(forest),
            crumbsJsonSchemaText: () =>
                JSON.stringify(
                    nav.ancestorsJsonSchema({
                        outerIsMap: true,
                        payloadItemSchema: z.toJSONSchema(spryRouteAnnSchema),
                    }),
                    null,
                    2,
                ),
        };

        const breadcrumbs: Record<string, ReturnType<typeof nav.ancestors>> =
            {};
        for (const node of forest.treeByPath.values()) {
            if (node.payloads) {
                for (const p of node.payloads) {
                    breadcrumbs[p.path] = nav.ancestors(p);
                }
            }
        }

        return { forest, tree, breadcrumbs, serializers };
    }
}

export const capExecCtxSchema = z.object({
    project: z.string(),
});
export type CapExecContent = z.infer<typeof capExecCtxSchema>;

export class CapExecs<Context extends CapExecContent>
    implements WalkSpecsSupplier {
    readonly logger = (
        e: {
            level: "debug" | "info" | "warn" | "error";
            msg: string;
            meta?: Record<string, unknown>;
        },
    ) => {
        const tag = e.level.toUpperCase().padEnd(5);
        const line = `${colors.bold(colors.gray(`[${tag}]`))} ${e.msg} ${
            e.meta ? colors.gray(JSON.stringify(e.meta)) : ""
        }`;
        console.log(line);
    };

    constructor(
        readonly importMetaMainHome: string, // usually `fromFileUrl(import.meta.resolve("./"))` of module constructing class
        readonly init?: {
            readonly mergeCtx?: Partial<Context>; // overrides merged into schema defaults
        },
    ) {
    }

    walkSpecs() {
        return [{
            identity: "local-capexec",
            root: "./src",
            baseDir: this.importMetaMainHome,
        }, {
            identity: "stdlib-capexec",
            root: "./src/spry", // this is symlink and won't be found in ./src by default
            baseDir: this.importMetaMainHome,
        }];
    }

    capExecsCtx() {
        const ctxDefaults = capExecCtxSchema.parse({}) as Context; // defaults
        return capExecCtxSchema.parse({
            ...ctxDefaults,
            ...(this.init?.mergeCtx ?? {}),
        }) as Context;
    }

    env(mode: PrepareMode) {
        return {
            CAPEXEC_MODE: mode,
            CAPEXEC_CONTEXT_JSON: JSON.stringify(this.capExecsCtx()),
        };
    }

    async execute(mode: PrepareMode = "build") {
        for await (
            const ev of prepareCapExecsFs<Context>({
                specs: this.walkSpecs(),
                mode,
                run: mode !== "dry-run",
                context: this.capExecsCtx(),
                logger: this.logger,
                adapter: {
                    projectEnv: () => this.env(mode), // inject CAPEXEC_* and context vars
                    // (Optional) override resolvers/materializers here if desired
                    // resolveStage: async (...) => ({ argv: ["sh","-c","..."], cwd: "..." }),
                    // resolveSink: async  (...) => ({ argv: ["deno","run","-A", "script.ts"], cwd: "..." }),
                    // materializeSingle: async (...args) => {...},
                    // materializeMulti: async  (...args) => {...},
                },
            })
        ) {
            if (ev.phase === "prepared") {
                this.logger({
                    level: "info",
                    msg: "prepared",
                    meta: {
                        name: relative(
                            Deno.cwd(),
                            ev.prepared.source.item.path,
                        ),
                    },
                });
            } else {
                this.logger({
                    level: "info",
                    msg: "executed",
                    meta: {
                        name: relative(
                            Deno.cwd(),
                            ev.prepared.source.item.path,
                        ),
                    },
                });
            }
        }
    }
}

export class LocalDev {
    // usually `fromFileUrl(import.meta.resolve("./"))` of module constructing class
    constructor(
        readonly importMetaMainHome: string,
    ) {
    }

    spryPaths() {
        const absPathToSpryLocal = join(
            fromFileUrl(this.importMetaMainHome),
            SRC,
            "spry",
        );
        const spryHome = relative(
            dirname(absPathToSpryLocal),
            import.meta.dirname!,
        );
        const relPathToSpryHome = relative(Deno.cwd(), absPathToSpryLocal);
        return {
            spryHome,
            relPathToSpryHome,
        };
    }

    async init() {
        const sp = this.spryPaths();
        let removedExisting = false;
        try {
            await Deno.remove(sp.relPathToSpryHome);
            removedExisting = true;
        } catch {
            /** ignore */
        }
        await Deno.symlink(sp.spryHome, sp.relPathToSpryHome);
        return {
            spryPaths: sp,
            removedExisting,
            linked: { from: sp.relPathToSpryHome, to: sp.spryHome },
        };
    }
}

export class Orchestrator implements WalkSpecsSupplier {
    // usually `fromFileUrl(import.meta.resolve("./"))` of module constructing class
    constructor(
        readonly importMetaMainHome: string,
    ) {
    }

    lintRegistry() {
        return defineRegistry(
            {
                "invalid-annotation": defineRule({
                    code: ["entry", "route"] as const,
                    data: { annotation: {} },
                    defaultSeverity: "error",
                }),
            } as const,
        );
    }

    lintResults() {
        return new LintResults({
            registry: this.lintRegistry(),
            contentMetaFor: (
                id,
            ) => (id.endsWith(".sql") ? { lang: "sql" } : {}),
            runMeta: { tool: "spry" },
        });
    }

    orchStore<Path extends string>() {
        return new Store<Path>(normalize(join(this.importMetaMainHome)));
    }

    srcStore<Path extends string>() {
        return new Store<Path>(normalize(join(this.importMetaMainHome, SRC)));
    }

    annotationsStore<Path extends string>() {
        return new JsonStore(
            new Store<Path>(
                normalize(join(this.importMetaMainHome, SRC, "annotations")),
            ),
            undefined,
            { pretty: true },
        );
    }

    sqlpageFiles() {
        return new SqlPageFiles(this.importMetaMainHome);
    }

    annotations() {
        return new Annotations(this.importMetaMainHome);
    }

    capExecs() {
        return new CapExecs(this.importMetaMainHome);
    }

    walkSpecs() {
        return [
            ...this.sqlpageFiles().walkSpecs(),
            ...this.annotations().walkSpecs(),
            ...this.capExecs().walkSpecs(),
        ];
    }

    watchRoots() {
        return Array.from(new Set(this.walkSpecs().map((s) => s.root)));
    }

    stores() {
        const mdStore = new MarkdownStore<"orchestrated.auto.md">();
        const orchMD = mdStore.markdown("orchestrated.auto.md");

        const orchStore = this.orchStore();
        const srcStore = this.srcStore();
        const annStore = this.annotationsStore();
        return {
            orchMD,
            annStore,
            mdStore,
            orchStore,
            srcStore,
        };
    }

    async clean(stores: ReturnType<typeof this.stores>) {
        const rmDirRecursive = async (path: string) => {
            try {
                await Deno.remove(path, { recursive: true });
            } catch (error) {
                if (error instanceof Deno.errors.NotFound) { /**ignore */ }
            }
        };

        await rmDirRecursive(
            join(stores.srcStore.destRoot, "orchestrated.auto.md"),
        );
        await rmDirRecursive(stores.annStore.store.destRoot);
    }

    async orchestrate(init?: { clean?: boolean }) {
        const spf = this.sqlpageFiles();
        const stores = this.stores();
        if (init?.clean) await this.clean(stores);

        const lintr = this.lintResults();
        const { orchMD, srcStore, annStore } = stores;

        orchMD.h1("Orchestration Results");
        orchMD.br().p(`Check the file date for when it was last executed.`);

        orchMD.h2("SQLPage Files Candidates");
        orchMD.table(
            ["Root", "Path"],
            (await Array.fromAsync(spf.sources())).map((src) => [
                src.spec.origin.identity ?? "",
                src.payload.relPath,
            ]),
        );

        // first get all the annotations and save their state for downstream use
        const routeAnns: SpryRouteAnnotation[] = [];
        const annotated = new Set<
            { root?: string; relPath: string; count: number }
        >();
        for await (const a of this.annotations().catalog()) {
            if (a.entryAnn.found > 0 && a.entryAnn.parsed) {
                await annStore.write(
                    join("entry", a.entryAnn.parsed.relPath + ".auto.json"),
                    a.entryAnn,
                    // don't store absPath because it will be different across systems
                    // making it harder to store in Git (because it will show diffs)
                    omitPathsReplacer(a.entryAnn, [["parsed", "absPath"]]),
                );
                annotated.add({
                    root: a.walkEntry.spec.origin.identity,
                    relPath: a.entryAnn.parsed.relPath,
                    count: a.entryAnn.found,
                });
            } else if (a.entryAnn.found > 0) {
                lintr.add({
                    rule: "invalid-annotation",
                    code: "entry",
                    content: a.walkEntry.payload.relPath,
                    message: "Invalid entry annotation",
                    data: { annotation: a.entryAnn },
                    severity: "error",
                });
            }

            if (a.routeAnn.found > 0 && a.routeAnn.parsed) {
                await annStore.write(
                    join("route", a.routeAnn.parsed.path + ".auto.json"),
                    a.routeAnn,
                );
                annotated.add({
                    root: a.walkEntry.spec.origin.identity,
                    relPath: a.routeAnn.parsed.path,
                    count: a.routeAnn.found,
                });
                routeAnns.push(a.routeAnn.parsed);
            } else if (a.routeAnn.found > 0) {
                lintr.add({
                    rule: "invalid-annotation",
                    code: "route",
                    content: a.walkEntry.payload.relPath,
                    message: "Invalid route annotation",
                    data: { annotation: a.routeAnn },
                    severity: "error",
                });
            }
        }

        const routes = new Routes(routeAnns);
        const { serializers, breadcrumbs } = await routes.populate();
        orchMD.h2("Routes Tree");
        orchMD.code("ascii", serializers.asciiTreeText());

        orchMD.h2("Breadcrumbs");
        orchMD.table(
            ["Path", "Breadcrumbs"],
            Array.from(Object.entries(breadcrumbs)).map(([path, node]) => [
                path,
                node.map((bc) => bc.hrefs.index ?? bc.hrefs.trailingSlash).join(
                    "\n",
                ),
            ]),
        );

        orchMD.h2("Annotated Sources");
        orchMD.table(
            ["Path", "Count", "Root"],
            Array.from(annotated.values()).map((a) => [
                a.relPath,
                String(a.count),
                a.root ?? "",
            ]),
            ["left", "right", "left"],
        );

        for (const lr of lintr.allFindings()) {
            orchMD.section("Lint Results", (md) => {
                md.p(`[\`${lr.rule}\`] \`${lr.code}\`: ${lr.message}`);
            });
        }
        srcStore.writeText("orchestrated.auto.md", orchMD.write());
    }

    cli(importMetaMainHome: string, init?: { name?: string }) {
        const roots = this.watchRoots();
        const localDev = new LocalDev(importMetaMainHome);
        return new Command()
            .name(init?.name ?? "package.sql.ts")
            .version("0.1.0")
            .description(
                "Generate the SQL which will be supplied to SQLPage target database.",
            )
            .command("init")
            .description("Setup local dev environment")
            .action(async () => {
                const ldi = await localDev.init();
                if (ldi.removedExisting) {
                    console.log("Removed", ldi.linked.from);
                }
                console.log("Linked", ldi.linked.from, "to", ldi.linked.to);
            })
            .command("watch")
            .description(
                // deno-fmt-ignore
                `Rebuild ${roots.join(", ")} on change (edge-triggered; basic).`,
            )
            .action(async () => {
                const debounceMs = 150;
                let timer: number | null = null;

                await this.orchestrate();

                // Basic FS watch (use your own watcher if you need cross-platform globs)
                const watcher = Deno.watchFs(roots);
                for await (const ev of watcher) {
                    if (!["modify", "create", "remove"].includes(ev.kind)) {
                        continue;
                    }
                    if (timer) clearTimeout(timer);
                    timer = setTimeout(async () => {
                        console.log(
                            colors.cyan("⟳ change detected, rebuilding…"),
                        );
                        await this.orchestrate();
                    }, debounceMs) as unknown as number;
                }
            });
    }
}
