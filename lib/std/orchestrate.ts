#!/usr/bin/env -S deno run -A

import { Command } from "jsr:@cliffy/command@1.0.0-rc.8";
import { HelpCommand } from "jsr:@cliffy/command@1.0.0-rc.8/help";
import { dim } from "jsr:@std/fmt@1/colors";
import { walk, WalkEntry, WalkOptions } from "jsr:@std/fs@1/walk";
import { ensureDir } from "jsr:@std/fs@^1/ensure-dir";
import {
    basename,
    dirname,
    extname,
    isAbsolute,
    join,
    normalize,
    relative,
    resolve,
} from "jsr:@std/path@1";
import { z } from "jsr:@zod/zod@4";
import Table from "npm:cli-table3@0.6.5";
import { eq, getTableName, sql } from "npm:drizzle-orm@0.44.5";
import { drizzle } from "npm:drizzle-orm@0.44.5/libsql";
import {
    check,
    SQLiteColumn,
    sqliteTable,
    text,
} from "npm:drizzle-orm@0.44.5/sqlite-core";
import { CapExec } from "../universal/cap-exec.ts";
import {
    type AnnotationItem,
    extractAnnotationsFromText,
} from "../universal/content/code-comments.ts";
import { detectLanguageByPath } from "../universal/content/code.ts";
import { omitPathsReplacer } from "../universal/json.ts";
import { defineRegistry, defineRule, LintResults } from "../universal/lint.ts";
import { MarkdownStore } from "../universal/markdown.ts";
import {
    forestToEdges,
    pathTree,
    pathTreeNavigation,
    pathTreeSerializers,
} from "../universal/path-tree.ts";
import { provenanceText } from "../universal/reflect/provenance.ts";
import { inlinedSQL } from "../universal/sql-text.ts";
import * as sqldx from "./lib/sqlitedx.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

type YieldOf<T extends (...args: Any) => Any> = Awaited<ReturnType<T>> extends
    AsyncGenerator<infer Y, Any, Any> ? Y
    : Awaited<ReturnType<T>> extends AsyncIterableIterator<infer Y> ? Y
    : never;

export function sqliteModels() {
    const checkJSON = (c: SQLiteColumn) =>
        check(
            `${c.name}_check_valid_json`,
            sql`json_valid(${c}) OR ${c} IS NULL`,
        );

    const sqlpageFiles = sqliteTable("sqlpage_files", {
        // web path which SQLPage translates from URL to `contents`
        path: text().primaryKey().notNull(),

        // SQLPage file contents for rendering
        contents: text().notNull(),

        // Last modified timestamp for SQLPage to auto-refresh, defaults to CURRENT_TIMESTAMP
        lastModified: text("last_modified")
            .default(sql`CURRENT_TIMESTAMP`)
            .notNull(),
    });

    return {
        checkJSON,
        sqlpageFiles,
    };
}

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
    const devWatchRoots = [
        relative(
            Deno.cwd(),
            projectSrcFsPaths.root,
        ),
        relative(
            Deno.cwd(),
            import.meta.dirname!,
        ),
    ];
    return {
        projectFsPaths,
        projectSrcFsPaths,
        webPaths,
        spryStd: {
            homeFromSymlink: relative(
                dirname(absPathToSpryLocal),
                import.meta.dirname!,
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

export type WalkSpec = {
    readonly paths: FsPathSupplier;
    readonly options?: WalkOptions;
};

export type WalkEncounter<S extends WalkSpec> = {
    readonly origin: S;
    readonly entry: WalkEntry;
};

export type EncountersSupplier<
    S extends WalkSpec = WalkSpec,
    E extends WalkEncounter<S> = WalkEncounter<S>,
> = {
    readonly encountered: () => AsyncGenerator<E>;
};

export class Walker<
    S extends WalkSpec = WalkSpec,
    E extends WalkEncounter<S> = WalkEncounter<S>,
> implements EncountersSupplier<S, E> {
    constructor(readonly init: S) {}

    transform(entry: WalkEntry) {
        return { origin: this.init, entry } as E;
    }

    async *encountered() {
        for await (
            const we of walk(this.init.paths.root, this.init?.options)
        ) {
            yield this.transform(we) as E;
        }
    }
}

export class Walkers<
    S extends WalkSpec = WalkSpec,
    E extends WalkEncounter<S> = WalkEncounter<S>,
> implements EncountersSupplier<S, E> {
    readonly walkers: Walker<S, E>[];

    constructor(...walkers: Walker<S, E>[]) {
        this.walkers = walkers;
    }

    /** Builder entrypoint */
    static builder<
        TS extends WalkSpec = WalkSpec,
        TE extends WalkEncounter<TS> = WalkEncounter<TS>,
    >() {
        return new (class {
            private walkers: Walker<TS, TE>[] = [];

            addWalker(w: Walker<TS, TE>) {
                this.walkers.push(w);
                return this;
            }

            addSpec(spec: TS) {
                this.walkers.push(new Walker<TS, TE>(spec));
                return this;
            }

            addRoot(
                paths: FsPathSupplier,
                options?: WalkOptions,
            ) {
                const spec = { paths, options } as TS;
                this.walkers.push(new Walker<TS, TE>(spec));
                return this;
            }

            build() {
                return new Walkers<TS, TE>(...this.walkers);
            }
        })();
    }

    // Sequential merge with dedupe (by entry.path)
    async *encountered() {
        const seen = new Set<string>();

        for (const w of this.walkers) {
            for await (const e of w.encountered()) {
                const key = e.entry.path;
                if (seen.has(key)) continue;
                seen.add(key);
                yield e as E;
            }
        }
    }
}

export class SqlPageFiles {
    readonly candidates: EncountersSupplier;

    constructor(
        readonly projectModule: FsPathSupplier,
        readonly webPaths: PathSupplier,
    ) {
        this.candidates = Walkers.builder()
            .addRoot(projectModule, {
                exts: [".sql", ".json"],
                includeDirs: false,
                includeFiles: true,
                includeSymlinks: false,
                followSymlinks: true, // important for "src/spry"
                canonicalize: true, // important for "src/spry"
            })
            .build();
    }

    async *sources() {
        yield* this.candidates.encountered();
    }
}

const spryEntryAnnCommon = {
    absFsPath: z.string(),
    relFsPath: z.string(),
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
        nature: z.literal("cap-exec").describe(
            "A capturable executable",
        ),
        dependsOn: z.enum(["none", "db-after-build"])
            .describe(
                "Expresses dependencies: 'none' means it's idempotent, 'db-before-built' and 'db-after-build' means it needs the database before/after the build",
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
   - 'cap-exec' for Capturable Executables
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
    children: z.array(z.object({ path: z.string().describe("Child path") }))
        .optional().describe(
            "Simple array of paths filled out by path-tree computing and made available via SQL on the server",
        ),
}).strict().describe(
    "Navigation route annotation, supports hierarchy and ordered siblings.",
);

export type SpryEntryAnnotation = z.infer<typeof spryEntryAnnSchema>;

export type SpryCapExecEntryAnnotation = Extract<
    SpryEntryAnnotation,
    { nature: "cap-exec" }
>;

export type SpryRouteAnnotation = z.infer<typeof spryRouteAnnSchema>;

export class Annotations {
    readonly annotatable: EncountersSupplier;

    constructor(
        readonly projectModule: FsPathSupplier,
        readonly webPaths: PathSupplier,
        readonly init?: {
            readonly transformEntryAnn?: (
                enc: SpryEntryAnnotation,
            ) => SpryEntryAnnotation | Promise<SpryEntryAnnotation>;
            readonly transformRouteAnn?: (
                enc: SpryRouteAnnotation,
            ) => SpryRouteAnnotation | Promise<SpryRouteAnnotation>;
        },
    ) {
        this.annotatable = Walkers.builder()
            .addRoot(projectModule, {
                exts: [".sql", ".ts"],
                includeDirs: false,
                includeFiles: true,
                includeSymlinks: false,
                followSymlinks: true, // important for "src/spry"
                canonicalize: true, // important for "src/spry"
            })
            .build();
    }

    async *sources() {
        yield* this.annotatable.encountered();
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
                "absFsPath": we.entry.path,
                "relFsPath": we.origin.paths.relative(we.entry),
            },
        );
    }

    async routeAnnFromCatalog(
        we: YieldOf<typeof this.sources>,
        anns: Awaited<ReturnType<typeof extractAnnotationsFromText>>,
    ) {
        const pathBasename = basename(we.entry.path);
        const webPath = this.webPaths.absolute(we.entry);
        return await this.safeAnnGroup(
            spryRouteAnnSchema,
            "route.",
            anns,
            this.init?.transformRouteAnn,
            {
                "path": webPath,
                "pathBasename": pathBasename,
                "pathBasenameNoExtn": pathBasename.split(".")[0],
                "pathDirname": dirname(webPath),
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
            try {
                const anns = await extractAnnotationsFromText(
                    await Deno.readTextFile(we.entry.path),
                    detectLanguageByPath(we.entry.path)!, // TODO: give sane default
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
            } catch (err) {
                console.error(we.origin.paths.relative(we.entry), err);
            }
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
        const edges = forestToEdges(forest);
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

        return { forest, tree, breadcrumbs, serializers, edges };
    }
}

export type SafeCliArgs = {
    dbName?: string;
};

export class CapExecs {
    readonly candidates: EncountersSupplier;
    readonly contextForEnv: Record<string, unknown>;

    constructor(
        readonly projectModule: FsPathSupplier,
        readonly webPaths: PathSupplier,
        readonly init?: {
            readonly cliOpts?: SafeCliArgs;
            readonly mergeCtx?: Record<string, unknown>; // overrides merged into schema defaults
        },
    ) {
        // any executable files in our path(s) can be capexec candidates
        // TODO: restrict it a bit more, though?
        this.candidates = Walkers.builder()
            .addRoot(projectModule, {
                includeDirs: false,
                includeFiles: true,
                includeSymlinks: false,
                followSymlinks: true, // important for "src/spry"
                canonicalize: true, // important for "src/spry"
            })
            .build();

        this.contextForEnv = {
            cliOpts: init?.cliOpts ?? JSON.stringify(init?.cliOpts),
            ...init?.mergeCtx,
        };
    }

    env() {
        let ceEnv: Record<string, string> = {
            CAPEXEC_CONTEXT_JSON: JSON.stringify(this.contextForEnv),
        };
        if (this.init?.cliOpts?.dbName) {
            const dbName = this.init.cliOpts.dbName;
            ceEnv = {
                ...ceEnv,
                CAPEXEC_TARGET_SQLITEDB: isAbsolute(dbName)
                    ? dbName
                    : resolve(Deno.cwd(), dbName),
            };
        }
        return ceEnv;
    }

    async execute() {
        const ceCandidates: WalkEncounter<WalkSpec>[] = [];
        for await (const cec of this.candidates.encountered()) {
            const cecc = CapExec.capExecCandidacy(cec.entry.path);
            if (cecc.isCapExec) ceCandidates.push(cec);
        }
        const ce = CapExec.create()
            .withCandidates(ceCandidates.map((cec) => cec.entry.path))
            .withEnv(this.env())
            .on("error", (...args) => {
                console.error(...args);
            });
        await ce.runSettled();
    }
}

export class Linter {
    lintRegistry() {
        return defineRegistry(
            {
                "invalid-annotation": defineRule({
                    code: ["entry", "route"] as const,
                    data: { annotation: {} },
                    defaultSeverity: "error",
                }),
                "invalid-cap-exec": defineRule({
                    code: ["not-executable"] as const,
                    data: { annotation: {} },
                    defaultSeverity: "warn",
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
}

export class Workflow {
    readonly linter: Linter;
    readonly lintr: ReturnType<Linter["lintResults"]>;
    readonly stores: ReturnType<Plan["stores"]>;
    readonly pp: Plan["pp"];
    readonly spf: ReturnType<Plan["sqlpageFiles"]>;
    readonly annotations: ReturnType<Plan["annotations"]>;
    readonly capExecs: ReturnType<Plan["capExecs"]>;

    #annsCatalog?: YieldOf<
        ReturnType<Plan["annotations"]>["catalog"]
    >[];

    readonly mdStore = new MarkdownStore<"orchestrated.auto.md">();
    readonly orchMD = this.mdStore.markdown("orchestrated.auto.md");

    protected constructor(
        readonly plan: Plan,
        readonly cliOpts?: SafeCliArgs,
    ) {
        this.pp = plan.pp;
        this.linter = plan.linter();
        this.lintr = this.linter.lintResults();
        this.stores = plan.stores();
        this.spf = plan.sqlpageFiles();
        this.annotations = plan.annotations();
        this.capExecs = plan.capExecs(cliOpts);
    }

    static async build(plan: Plan, cliOpts?: SafeCliArgs) {
        return await new Workflow(plan, cliOpts).init();
    }

    get annsCatalog() {
        return this.#annsCatalog!; // will become available after call to init()
    }

    protected async init() {
        this.#annsCatalog = await Array.fromAsync(this.annotations.catalog());

        this.orchMD.h1("Orchestration Results");
        this.orchMD.br().p(
            `Check the file date for when it was last executed.`,
        );

        this.orchMD.h2("SQLPage Files Candidates");
        this.orchMD.table(
            ["Root", "Web Path", "Fs Path"],
            (await Array.fromAsync(this.spf.candidates.encountered())).map((
                src,
            ) => [
                src.origin.paths.identity ?? "",
                this.pp.webPaths.absolute(src.entry),
                src.origin.paths.relative(src.entry),
            ]),
        );

        // allow method chaining, usually from constructor
        return this;
    }

    // deno-lint-ignore require-await
    async lintEntryAnn(
        ea: SpryEntryAnnotation,
        we: WalkEncounter<WalkSpec>,
    ) {
        switch (ea.nature) {
            case "cap-exec":
                if (!CapExec.isExecutable(we.entry.path)) {
                    this.lintr.add({
                        rule: "invalid-cap-exec",
                        code: "not-executable",
                        content: we.origin.paths.relative(we.entry),
                        message:
                            "Capturable executable does not appear to be executable",
                        data: { annotation: ea },
                        severity: "warn",
                    });
                }
                break;
        }
    }

    // deno-lint-ignore require-await
    async entryAnnotations(lint = false) {
        type base = {
            we: Workflow["annsCatalog"][number]["walkEntry"];
            ann: Workflow["annsCatalog"][number]["entryAnn"];
        };
        const entryAnns: (base & {
            entryAnn: SpryEntryAnnotation;
        })[] = [];
        const issues: base[] = [];
        for (const a of this.annsCatalog) {
            if (a.entryAnn.found > 0 && a.entryAnn.parsed) {
                entryAnns.push({
                    we: a.walkEntry,
                    ann: a.entryAnn,
                    entryAnn: a.entryAnn.parsed,
                });
                if (lint) this.lintEntryAnn(a.entryAnn.parsed, a.walkEntry);
            } else if (a.entryAnn.found > 0) {
                if (lint) {
                    this.lintr.add({
                        rule: "invalid-annotation",
                        code: "entry",
                        content: a.walkEntry.origin.paths.relative(
                            a.walkEntry.entry,
                        ),
                        message: "Invalid entry annotation",
                        data: { annotation: a.entryAnn },
                        severity: "error",
                    });
                } else {
                    issues.push({ we: a.walkEntry, ann: a.entryAnn });
                }
            }
        }
        return { valid: entryAnns, issues };
    }

    async capExecEntryAnnotations(lint = false) {
        const entryAnns = await this.entryAnnotations(lint);
        return entryAnns.valid.filter((ea) => ea.entryAnn.nature === "cap-exec")
            .map((ea) => ({
                capExec: ea.we,
                ann: ea.entryAnn as SpryCapExecEntryAnnotation,
                isExecutable: CapExec.isExecutable(ea.we.entry.path),
            }));
    }

    protected async dropInEntryAnns(
        annotated: Set<{ root?: string; relPath: string; count: number }>,
    ) {
        const { spryDistAutoStores: { json: spryDistAutoJsonStore } } =
            this.stores;
        const entryAnns = await this.entryAnnotations(true);
        for (const a of entryAnns.valid) {
            const webPath = this.pp.webPaths.absolute(a.we.entry);
            await spryDistAutoJsonStore.write(
                join("entry", webPath + ".auto.json"),
                { ...a.entryAnn, webPath, ".source": a.ann.anns },
                // don't store absFsPath because it will be different across systems
                // making it harder to store in Git (because it will show diffs)
                omitPathsReplacer(a.entryAnn, [["absFsPath"]]),
            );
            annotated.add({
                root: a.we.origin.paths.identity,
                relPath: a.entryAnn.relFsPath,
                count: a.ann.found,
            });
        }
    }

    async routeAnnotations(lint = false) {
        type base = {
            we: Workflow["annsCatalog"][number]["walkEntry"];
            ann: Workflow["annsCatalog"][number]["routeAnn"];
        };
        const routeAnnsByPath = new Map<
            string,
            (base & {
                routeAnn: SpryRouteAnnotation;
            })
        >();
        const routeAnns: (base & {
            routeAnn: SpryRouteAnnotation;
        })[] = [];
        const issues: base[] = [];

        for (const a of this.annsCatalog) {
            if (a.routeAnn.found > 0 && a.routeAnn.parsed) {
                const store = {
                    we: a.walkEntry,
                    ann: a.routeAnn,
                    routeAnn: a.routeAnn.parsed,
                };
                routeAnns.push(store);
                routeAnnsByPath.set(store.routeAnn.path, store);
            } else if (a.routeAnn.found > 0) {
                if (lint) {
                    this.lintr.add({
                        rule: "invalid-annotation",
                        code: "route",
                        content: a.walkEntry.origin.paths.relative(
                            a.walkEntry.entry,
                        ),
                        message: "Invalid route annotation",
                        data: { annotation: a.routeAnn },
                        severity: "error",
                    });
                } else {
                    issues.push({ we: a.walkEntry, ann: a.routeAnn });
                }
            }
        }

        const routes = new Routes(routeAnns.map((ra) => ra.routeAnn));
        return {
            valid: routeAnns,
            issues,
            ...(await routes.populate()),
        };
    }

    protected async dropInRouteAnns(
        annotated: Set<{ root?: string; relPath: string; count: number }>,
    ) {
        const routeAnns = await this.routeAnnotations(true);
        const { spryDistAutoStores: { json: spryDistAutoJsonStore } } =
            this.stores;
        for (const a of routeAnns.valid) {
            await spryDistAutoJsonStore.write(
                join("route", a.routeAnn.path + ".auto.json"),
                { ...a.routeAnn, ".source": a.ann.anns },
            );
            annotated.add({
                root: a.we.origin.paths.identity,
                relPath: a.routeAnn.path,
                count: a.ann.found,
            });
        }

        const routes = new Routes(routeAnns.valid.map((ra) => ra.routeAnn));
        const { serializers, breadcrumbs, forest, edges } = await routes
            .populate();

        await spryDistAutoJsonStore.write(
            join("route", "forest.auto.json"),
            forest,
        );
        await spryDistAutoJsonStore.write(
            join("route", "edges.auto.json"),
            edges,
        );

        this.orchMD.h2("Routes Tree");
        this.orchMD.code("ascii", serializers.asciiTreeText());

        this.orchMD.h2("Breadcrumbs");
        for (const [path, node] of Object.entries(breadcrumbs)) {
            await spryDistAutoJsonStore.write(
                join("breadcrumbs", path + ".auto.json"),
                node,
            );
        }
        this.orchMD.table(
            ["Path", "Breadcrumbs"],
            Array.from(Object.entries(breadcrumbs)).map(([path, node]) => [
                path,
                node.map((bc) => bc.hrefs.index ?? bc.hrefs.trailingSlash).join(
                    "\n",
                ),
            ]),
        );

        return routeAnns;
    }

    async dropInAnnotations() {
        const annotated = new Set<
            { root?: string; relPath: string; count: number }
        >();

        await this.dropInEntryAnns(annotated);
        await this.dropInRouteAnns(annotated);

        this.orchMD.h2("Annotated Sources");
        this.orchMD.table(
            ["Path", "Count", "Root"],
            Array.from(annotated.values()).map((a) => [
                a.relPath,
                String(a.count),
                a.root ?? "",
            ]),
            ["left", "right", "left"],
        );
    }

    async captureExecutables() {
        await this.capExecs.execute();
    }

    // deno-lint-ignore require-await
    async finalize() {
        for (const lr of this.lintr.allFindings()) {
            this.orchMD.section("Lint Results", (md) => {
                md.p(
                    `[\`${lr.rule}\`] \`${lr.code}\`: ${lr.message} in ${lr.content}`,
                );
                md.code("json", JSON.stringify(lr.data, null, 2));
            });
        }
        this.stores.spryDistAutoStores.polyglot.writeText(
            "orchestrated.auto.md",
            this.orchMD.write(),
        );
    }

    async orchestrate(init?: { cleanAuto?: boolean }) {
        const stores = this.stores;
        if (init?.cleanAuto) await this.plan.clean(stores);

        await this.dropInAnnotations();
        await this.captureExecutables();
        await this.finalize();
    }
}

export class SQL {
    constructor(readonly plan: Plan) {
    }

    get provenanceHint() {
        return provenanceText({
            importMetaURL: import.meta.url,
            framesToSkip: 2,
        });
    }

    async *headSqlSources() {
        const relativeToCWD = (path: string) => relative(Deno.cwd(), path);
        yield relativeToCWD(this.plan.pp.projectSrcFsPaths.absolute(
            join("spry", "lib", "sqlpage-files.ddl.sql"),
        ));
        yield relativeToCWD(this.plan.pp.projectSrcFsPaths.absolute(
            join("spry", "lib", "schema-info.dml.sql"),
        ));
    }

    async *tailSqlSources() {
        /** none so far */
    }

    async *headSQL() {
        yield `-- head SQL defined in ${this.provenanceHint} (begin)`;
        for await (const hss of this.headSqlSources()) {
            yield Deno.readTextFile(hss);
        }
        yield `-- head SQL defined in ${this.provenanceHint} (end)`;
    }

    async *seedInserts() {
        const { sqlpageFiles: sqlpageFilesTable } = sqliteModels();
        const spf = this.plan.sqlpageFiles();
        //type SqlPageFileRow = typeof sqlpageFilesTable.$inferInsert;

        // needed for drizzle-orm with @libsql/client because it doesn't generate SQL without it
        const db = drizzle({ connection: { url: ":memory:" } });
        for await (const f of spf.sources()) {
            const path = this.plan.pp.webPaths.absolute(f.entry);
            yield inlinedSQL(
                db.delete(sqlpageFilesTable).where(
                    eq(sqlpageFilesTable.path, path),
                ).toSQL(),
            );
            yield inlinedSQL(
                db.insert(sqlpageFilesTable).values({
                    path: path,
                    contents: await Deno.readTextFile(f.entry.path),
                }).toSQL(),
            );
        }
    }

    async *tailSQL() {
        yield `-- tail SQL defined in ${this.provenanceHint} (begin)`;
        for await (const tss of this.tailSqlSources()) {
            yield Deno.readTextFile(tss);
        }
        yield `-- tail SQL defined in ${this.provenanceHint} (end)`;
    }

    async *deploy() {
        const { sqlpageFiles } = sqliteModels();

        yield* this.headSQL();

        yield `-- ${getTableName(sqlpageFiles)} rows --`;
        yield* this.seedInserts();

        yield* this.tailSQL();
    }

    async toStdOut() {
        for await (const sql of this.deploy()) {
            console.log(sql);
        }
    }
}

export class Plan {
    constructor(readonly pp: ReturnType<typeof projectPaths>) {
    }

    linter() {
        return new Linter();
    }

    orchStore<Path extends string>() {
        return new Store<Path>(normalize(this.pp.projectFsPaths.root));
    }

    srcStore<Path extends string>() {
        return new Store<Path>(
            normalize(this.pp.projectSrcFsPaths.root),
        );
    }

    spryDropInStores<Path extends string>() {
        const polyglot = new Store<Path>(
            normalize(join(this.pp.projectSrcFsPaths.root, "spry.d")),
        );
        return {
            polyglot,
            json: new JsonStore(polyglot, undefined, { pretty: true }),
        };
    }

    spryDistAutoStores<Path extends string>() {
        const polyglot = new Store<Path>(
            normalize(join(this.pp.projectSrcFsPaths.root, "spry.d", "auto")),
        );
        return {
            polyglot,
            json: new JsonStore(polyglot, undefined, { pretty: true }),
        };
    }

    sqlpageFiles() {
        return new SqlPageFiles(this.pp.projectFsPaths, this.pp.webPaths);
    }

    annotations() {
        return new Annotations(this.pp.projectFsPaths, this.pp.webPaths);
    }

    capExecs(cliOpts?: SafeCliArgs) {
        return new CapExecs(this.pp.projectFsPaths, this.pp.webPaths, {
            cliOpts,
        });
    }

    stores() {
        const orchStore = this.orchStore();
        const srcStore = this.srcStore();
        const spryDropInStores = this.spryDropInStores();
        const spryDistAutoStores = this.spryDistAutoStores();
        return {
            spryDropInStores,
            spryDistAutoStores,
            orchStore,
            srcStore,
        };
    }

    async clean(stores = this.stores()) {
        const rmDirIfEmpty = async (path: string) => {
            try {
                if ((await Array.fromAsync(Deno.readDir(path))).length === 0) {
                    await Deno.remove(path);
                }
            } catch (error) {
                if (error instanceof Deno.errors.NotFound) { /**ignore */ }
            }
        };

        const rmDirRecursive = async (path: string) => {
            try {
                await Deno.remove(path, { recursive: true });
            } catch (error) {
                if (error instanceof Deno.errors.NotFound) { /**ignore */ }
            }
        };

        // we "own" the "spry.d/auto" directory so remove it
        await rmDirRecursive(stores.spryDistAutoStores.polyglot.destRoot);

        // if `auto` was the only directory in `spry.d`, remove that too
        rmDirIfEmpty(stores.spryDropInStores.polyglot.destRoot);
    }

    async workflow(cliOpts?: SafeCliArgs) {
        return await Workflow.build(this, cliOpts);
    }
}

export class CLI {
    constructor(readonly plan: Plan) {
    }

    async init(init: { dbName: string; clean: boolean }) {
        const { spryStd, sqlPage } = this.plan.pp;

        const exists = async (path: string) =>
            await Deno.stat(path).catch(() => false);
        const relativeToCWD = (path: string) => relative(Deno.cwd(), path);

        const defaultSqlpageConf = {
            allow_exec: true,
            port: 9219,
            database_url: `sqlite://${init?.dbName}?mode=rwc`,
            web_root: "src",
        };

        const removed: string[] = [];
        if (init?.clean) {
            if (await exists(spryStd.relPathToHome)) {
                await Deno.remove(spryStd.relPathToHome);
                removed.push(spryStd.relPathToHome);
            }

            if (await exists(sqlPage.absPathToConfDir)) {
                await Deno.remove(sqlPage.absPathToConfDir, {
                    recursive: true,
                });
                removed.push(relativeToCWD(sqlPage.absPathToConfDir));
            }
        }

        const created: string[] = [];
        const linked: { from: string; to: string }[] = [];

        if (!(await exists(sqlPage.absPathToConfDir))) {
            await Deno.mkdir(sqlPage.absPathToConfDir, { recursive: true });
            created.push(relativeToCWD(sqlPage.absPathToConfDir));
            const sqpConf = join(sqlPage.absPathToConfDir, "sqlpage.json");
            await Deno.writeTextFile(
                sqpConf,
                JSON.stringify(defaultSqlpageConf, null, 2),
            );
            created.push(relativeToCWD(sqpConf));
        }

        if (!(await exists(spryStd.relPathToHome))) {
            await Deno.symlink(spryStd.homeFromSymlink, spryStd.relPathToHome);
            linked.push({
                from: spryStd.relPathToHome,
                to: spryStd.homeFromSymlink,
            });
        }

        return { spryStd, sqlPage, created, removed, linked };
    }

    async ls() {
        const workflow = await this.plan.workflow();
        const entries = await workflow.entryAnnotations();
        const table = new Table({
            head: ["", "Nature", "Path", "Ann Error"],
        });
        for (const ea of entries.issues) {
            table.push([
                ea.ann.found ? "📝" : dim("❔"),
                dim("unknown"),
                ea.we.entry.path,
                ea.ann.error ? z.prettifyError(ea.ann.error) : "?",
            ]);
        }
        for (const ea of entries.valid) {
            table.push([
                ea.ann.found ? "📝" : dim("❔"),
                ea.entryAnn.nature,
                ea.we.entry.path,
                ea.ann.error ? z.prettifyError(ea.ann.error) : "?",
            ]);
        }
        console.log(table.toString());
    }

    async lsAnnotations(_opts: { json?: boolean }) {
        const anns = new Annotations(
            this.plan.pp.projectFsPaths,
            this.plan.pp.webPaths,
        );
        const table = new Table({
            head: ["E", "R", "Path", "Entry Error", "Route Error"],
        });
        for await (const a of anns.catalog()) {
            if (a.entryAnn.found == 0 && a.routeAnn.found == 0) continue;
            table.push([
                a.entryAnn?.error
                    ? ""
                    : (a.entryAnn.found ? String(a.entryAnn.found) : ""),
                a.routeAnn?.error
                    ? ""
                    : (a.routeAnn.found ? String(a.routeAnn.found) : ""),
                relative(Deno.cwd(), a.walkEntry.entry.path),
                a.entryAnn?.error ? z.prettifyError(a.entryAnn.error) : "",
                a.routeAnn?.error ? z.prettifyError(a.routeAnn.error) : "",
            ]);
        }
        console.log(table.toString());
    }

    async lsSqlSources(opts: { target: "head" | "tail" }) {
        switch (opts.target) {
            case "head":
                console.log(
                    await Array.fromAsync(new SQL(this.plan).headSqlSources()),
                );
                break;
            case "tail":
                console.log(
                    await Array.fromAsync(new SQL(this.plan).tailSqlSources()),
                );
                break;
        }
    }

    async lsCapExecs(_opts: { json?: true }) {
        const workflow = await this.plan.workflow();
        const ceEntries = await workflow.capExecEntryAnnotations();
        const table = new Table({
            head: ["Path", "Depends On", "Executable?"],
        });
        for (const ce of ceEntries) {
            table.push([
                this.plan.pp.projectFsPaths.relative(ce.capExec.entry),
                ce.ann.dependsOn,
                ce.isExecutable,
            ]);
        }
        console.log(table.toString());
    }

    async lsRoutes(opts?: { json?: boolean }) {
        const workflow = await this.plan.workflow();
        const { serializers } = await workflow.routeAnnotations();

        if (opts?.json) {
            console.log(serializers.jsonText({ space: 2 }));
        } else {
            console.log(
                serializers.asciiTreeText({
                    showPath: true,
                    includeCounts: true,
                }),
            );
        }
    }

    async lsBreadcrumbs(opts: { json?: boolean }) {
        const workflow = await this.plan.workflow();
        const { breadcrumbs } = await workflow.routeAnnotations();

        if (opts.json) {
            console.dir(breadcrumbs);
            return;
        }

        const table = new Table({ head: ["Path", "Breadcrumbs"] });
        for (const [path, node] of Object.entries(breadcrumbs)) {
            table.push([
                path,
                node.map((bc) => bc.hrefs.index ?? bc.hrefs.trailingSlash)
                    .join("\n"),
            ]);
        }
        console.log(table.toString());
    }

    async dev(opts: { dbName: string; cleanDb: boolean }) {
        await new sqldx.DevExperience()
            .withDb(opts.dbName)
            .withSqlText(async () => {
                if (opts.cleanDb) {
                    await Deno.remove(opts.dbName).catch(() =>
                        console.warn(`Creating: ${opts.dbName}`)
                    ).then(() => console.warn(`Removed ${opts.dbName}`));
                }
                const workflow = await this.plan.workflow(opts);
                await workflow.orchestrate({ cleanAuto: true });
                return await Array.fromAsync(
                    new SQL(this.plan).deploy(),
                );
            }, {
                onInit: true,
                onReload: () => true,
            })
            .watch(...this.plan.pp.devWatchRoots)
            .restartDelayMs(250) // fixed delay after SQLite closes
            .beforeSqlpageRestart(async () => {
                // do any OS/filesystem synchronization checks you need
                // e.g., fs.stat, retry loops, etc.
            })
            .start();
    }

    async SQL(
        opts: {
            target: "head" | "tail" | "sqlpage-files" | "deploy";
            dbName: string;
        },
    ) {
        switch (opts.target) {
            case "head":
                console.log(
                    (await Array.fromAsync(new SQL(this.plan).headSQL())).join(
                        "\n",
                    ),
                );
                break;
            case "tail":
                console.log(
                    (await Array.fromAsync(new SQL(this.plan).tailSQL())).join(
                        "\n",
                    ),
                );
                break;
            case "sqlpage-files":
                console.log(
                    (await Array.fromAsync(new SQL(this.plan).seedInserts()))
                        .join("\n"),
                );
                break;
            case "deploy":
                await new SQL(this.plan).toStdOut();
                break;
            default:
                console.warn(`Unknown target '${opts.target}'`);
        }
    }

    cli(init?: { name?: string }) {
        return new Command()
            .name(init?.name ?? "spryctl.ts")
            .version("0.1.0")
            .description(
                "Orchestrate the content which will be supplied to SQLPage target database.",
            )
            .globalOption("--db-name <file>", "name of SQLite database", {
                default: "sqlpage.db",
            })
            .command("init")
            .description("Setup local dev environment")
            .option("--clean", "Remove existing and recreate", {
                default: false,
            })
            .action(async (opts) => {
                const { created, removed, linked } = await this.init(opts);
                removed.forEach((r) => console.warn(`❌ Removed ${r}`));
                created.forEach((c) => console.info(`📄 Created ${c}`));
                linked.forEach((l) =>
                    console.info("🔗 Linked", l.from, "to", l.to)
                );
            })
            .command("clean")
            .description("Clean auto-generated directories or files")
            .action(async () => {
                await this.plan.clean();
            })
            .command("build")
            .description("Perform orchestration (annotations, routes, capexes)")
            .action(async (opts) => {
                await (await this.plan.workflow(opts)).orchestrate({
                    cleanAuto: true,
                });
            })
            .command("help", new HelpCommand().global())
            .command(
                "ls",
                new Command()
                    .description(
                        "List SQLPage .sql files excluding migrations.",
                    )
                    .action(async () => await this.ls())
                    .command("ann", "List annotations discovered")
                    .option("-j, --json", "Emit as JSON instead of table")
                    .action(async (opts) => await this.lsAnnotations(opts))
                    .command(
                        "cap-execs",
                        "List capturable executable candidates",
                    )
                    .option("-j, --json", "Emit as JSON instead of tree")
                    .action(async (opts) => await this.lsCapExecs(opts))
                    .command(
                        "routes",
                        "List SQLPage .sql files that include route annotations.",
                    )
                    .option("-j, --json", "Emit as JSON instead of tree")
                    .action(async (opts) => await this.lsRoutes(opts))
                    .command(
                        "breadcrumbs",
                        "List SQLPage .sql files that include route annotations and their breadcrumbs.",
                    )
                    .option(
                        "-j, --json",
                        "dump the entire breadcrumbs object as JSON",
                    )
                    .action(async (opts) => await this.lsBreadcrumbs(opts))
                    .command("head")
                    .action(async () =>
                        await this.lsSqlSources({ target: "head" })
                    )
                    .command("tail")
                    .action(async () =>
                        await this.lsSqlSources({ target: "tail" })
                    ),
            )
            .command(
                "sql",
                new Command()
                    .description(
                        "Emit SQL (without reprocessing any files, use 'build' first)",
                    )
                    .globalOption(
                        "--db-name <file>",
                        "name of SQLite database",
                        {
                            default: "sqlpage.db",
                        },
                    )
                    .command("head")
                    .action(async (opts) =>
                        await this.SQL({ target: "head", ...opts })
                    )
                    .command("tail")
                    .action(async (opts) =>
                        await this.SQL({ target: "tail", ...opts })
                    )
                    .command("sqlpage-files")
                    .action(async (opts) =>
                        await this.SQL({ target: "sqlpage-files", ...opts })
                    )
                    .command("deploy")
                    .action(async (opts) =>
                        await this.SQL({ target: "deploy", ...opts })
                    ),
            )
            .action(async (opts) =>
                await this.SQL({ target: "deploy", ...opts })
            )
            .command("dev")
            .description(`Rebuild src on change and restart SQLPage.`)
            .option("--clean-db", "Delete the database each time (dangerous)", {
                default: false,
            })
            .action(async (opts) => await this.dev(opts));
    }
}
