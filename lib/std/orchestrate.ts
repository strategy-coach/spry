#!/usr/bin/env -S deno run -A

import {
    basename,
    dirname,
    extname,
    fromFileUrl,
    relative,
} from "jsr:@std/path@1";
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

// deno-lint-ignore no-explicit-any
type Any = any;

type YieldOf<T extends (...args: Any) => Any> = Awaited<ReturnType<T>> extends
    AsyncGenerator<infer Y, Any, Any> ? Y
    : Awaited<ReturnType<T>> extends AsyncIterableIterator<infer Y> ? Y
    : never;

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

export const orchCapExecCtxSchema = z.object({
    project: z.string().default("e2e-prime"),
});
export type OrchestrationContext = z.infer<typeof orchCapExecCtxSchema>;

export class Orchestrator<Context extends OrchestrationContext> {
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
        readonly importMetaMainHome: string, // usually `fromFileUrl(import.meta.resolve("./"))`
        readonly init?: {
            readonly specs?: FSWalkSpec[];
            readonly mergeCtx?: Partial<Context>; // overrides merged into schema defaults
            readonly transformEntryAnn?: (
                enc: SpryEntryAnnotation,
            ) => SpryEntryAnnotation | Promise<SpryEntryAnnotation>;
            readonly transformRouteAnn?: (
                enc: SpryRouteAnnotation,
            ) => SpryRouteAnnotation | Promise<SpryRouteAnnotation>;
        },
    ) {
    }

    annotationWalkSpecs() {
        return [{
            identity: "local-sql",
            root: ".",
            include: ["**/*.sql"],
            baseDir: this.importMetaMainHome,
        }, {
            identity: "stdlib-sql",
            root: fromFileUrl(import.meta.resolve("./")),
            include: ["**/*.sql"],
            baseDir: this.importMetaMainHome,
        }];
    }

    capExecsWalkSpecs() {
        return [{
            identity: "local-capexec",
            root: ".",
            baseDir: this.importMetaMainHome,
        }, {
            identity: "stdlib-capexec",
            root: fromFileUrl(import.meta.resolve("./")),
            baseDir: this.importMetaMainHome,
        }];
    }

    capExecsCtx() {
        const ctxDefaults = orchCapExecCtxSchema.parse({}) as Context; // defaults
        return orchCapExecCtxSchema.parse({
            ...ctxDefaults,
            ...(this.init?.mergeCtx ?? {}),
        }) as Context;
    }

    walkRoots() {
        return Array.from(
            new Set(
                [...this.annotationWalkSpecs(), ...this.capExecsWalkSpecs()]
                    .map((s) => s.root),
            ),
        );
    }

    env(mode: PrepareMode) {
        return {
            CAPEXEC_MODE: mode,
            CAPEXEC_CONTEXT_JSON: JSON.stringify(this.capExecsCtx()),
        };
    }

    async *annotationSources() {
        yield* walkFS({ specs: this.annotationWalkSpecs() });
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
        we: YieldOf<typeof this.annotationSources>,
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
        we: YieldOf<typeof this.annotationSources>,
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

    async *annotations() {
        for await (const we of this.annotationSources()) {
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
                annotations: anns,
                entryAnn: await this.entryAnnFromCatalog(we, anns),
                routeAnn: await this.routeAnnFromCatalog(we, anns),
            };
        }
    }

    async generateCapExecs(mode: PrepareMode = "build") {
        for await (
            const ev of prepareCapExecsFs<Context>({
                specs: this.capExecsWalkSpecs(),
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

    async cli() {
        const roots = this.walkRoots();
        return await new Command()
            .name("package.sql.ts")
            .version("0.1.0")
            .description(
                "Generate the SQL which will be supplied to SQLPage target database.",
            )
            .command("build")
            .description("Discover and build once.")
            .action(async () => {
                await this.generateCapExecs("build");
            })
            .command("dry-run")
            .description("Run pipelines but do not write outputs.")
            .action(async () => {
                await this.generateCapExecs("dry-run");
            })
            .command("watch")
            .description(
                // deno-fmt-ignore
                `Rebuild ${roots.join(", ")} on change (edge-triggered; basic).`,
            )
            .action(async () => {
                const debounceMs = 150;
                let timer: number | null = null;

                await this.generateCapExecs("build");

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
                        await this.generateCapExecs("build");
                    }, debounceMs) as unknown as number;
                }
            })
            .parse(Deno.args);
    }
}
