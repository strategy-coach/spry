import { z } from "jsr:@zod/zod@4";
import { extractAnnotationsFromText } from "../universal/content/code-comments.ts";
import { LanguageSpec } from "../universal/content/code.ts";

const resourceCommon = {
    isSystemGenerated: z.boolean().describe(
        "Virtual resources are not annotated by a user but created by the system",
    ),
};

export const resourceNature = "resource" as const;
export const resourceSchema = z.discriminatedUnion("nature", [
    z.object({
        nature: z.literal("action").describe(
            "Code that executes an action and redirects back to a page.",
        ),
        ...resourceCommon,
    }).strict(),
    z.object({
        nature: z.literal("api").describe(
            "An API endpoint exposed by the system.",
        ),
        ...resourceCommon,
    }).strict(),
    z.object({
        nature: z.literal("foundry").describe(
            "An executable which generates and materializes output",
        ),
        contributesResources: z.boolean().default(false).optional().describe(
            "Instruct engine that this foundry generates new files which contribute to resources collection",
        ),
        runBeforeAnnCatalog: z.boolean().default(true).optional().describe(
            "Instruct engine to run this before catalogging SQLPage file annotations",
        ),
        runAfterAnnCatalog: z.boolean().default(false).optional().describe(
            "Instruct engine to run this after catalogging SQLPage file annotations",
        ),
        isCleanable: z.boolean().default(false).optional().describe(
            "Instruct engine that when `clean` (delete generated artifacts) is called, call this foundry too (FOUNDRY_DESTROY_CLEAN env var will be set)",
        ),
        dependsOn: z.enum(["none", "db-after-build"]).default("none").optional()
            .describe(
                "Expresses dependencies: 'none' means it's idempotent, 'db-after-build' means it needs the database before/after the build",
            ),
        ...resourceCommon,
    }).strict(),
    z.object({
        nature: z.literal("page").describe(
            "A standard SQLPage server-side generated (SSG) page, this is the default.",
        ),
        ...resourceCommon,
    }).strict(),
    z.object({
        nature: z.literal("partial").describe(
            "Part of a standard SQLPage SSG page which is usually imported into other SQLPage pages using `run_sql`.",
        ),
        ...resourceCommon,
    }).strict(),
    z.object({
        nature: z.literal(resourceNature).describe(
            "A data resource",
        ),
        sqlImpact: z.enum(["unknown", "json"]).describe(
            "Specifies the type of resource.",
        ),
        ...resourceCommon,
    }).strict(),
    z.object({
        nature: z.literal("sql").describe(
            "A SQL stored procedure, requiring `sqlImpact` to specify whether it's DQL, DML, or DDL.",
        ),
        sqlImpact: z.enum(["dql", "dml", "ddl"]).describe(
            "Specifies the type of SQL impact: DQL (read/query), DML (insert/update/delete), or DDL (schema changes).",
        ),
        ...resourceCommon,
    }).strict(),
    z.object({
        nature: z.literal("unknown").describe(
            "When the nature is indeterminate",
        ),
        ...resourceCommon,
    }).strict(),
]).describe(
    `The nature of this file influences how it's treated by the system. 
   Possible values are:
   - 'action' for SQLPage code that executes and redirects back to a page
   - 'api' for SQLPage API endpoints
   - 'foundry' for executables which generate and materialize content
   - 'resource' for JSON or other types of data
   - 'page' for standard SQLPage SSG pages (default)
   - 'partial' for SQLPage SSG partials, usually imported into other pages
   - 'sql' for SQL stored procedures, requiring 'sqlImpact'.`,
);

export type Resource = z.infer<typeof resourceSchema>;

export type TextSupplier = {
    readonly text: () => string | Promise<string>;
};

export const isTextSupplier = (o: unknown): o is TextSupplier =>
    o && typeof o === "object" && "text" in o &&
        typeof o.text === "function"
        ? true
        : false;

export type TextProducer = {
    readonly writeText: (text: string) => string | Promise<string>;
};

export const isTextProducer = (o: unknown): o is TextProducer =>
    o && typeof o === "object" && "writeText" in o &&
        typeof o.writeText === "function"
        ? true
        : false;

export type SrcCodeLangSpecSupplier = {
    srcCodeLanguage: LanguageSpec;
};

export const isSrcCodeLangSpecSupplier = (
    o: unknown,
): o is SrcCodeLangSpecSupplier =>
    o && typeof o === "object" && "srcCodeLanguage" in o &&
        typeof o.srcCodeLanguage === "object"
        ? true
        : false;

export type SrcCodeSupplier =
    & TextSupplier
    & TextProducer
    & SrcCodeLangSpecSupplier;

export const isSrcCodeSupplier = (
    o: unknown,
): o is SrcCodeSupplier =>
    isTextSupplier(o) && isTextProducer(o) && isSrcCodeLangSpecSupplier(o);

// acquires sources and yields or "supplies" them (usually from disk)
export type ResourceSupplier<R extends Resource> = (
    args: { signal?: AbortSignal },
) => AsyncIterable<R> | AsyncGenerator<R, void, unknown>;

// collects resources after they are acquired (usually in memory)
export type ResourcesCollection<R extends Resource> = {
    readonly resources: readonly R[];
    readonly register: (resource: R) => void | Promise<void>;
};

// finds all "spry.*" annotations and returns them a single parsed Zod object
export function zodParsedResourceAnns(
    catalog: Awaited<
        ReturnType<typeof extractAnnotationsFromText<unknown>>
    >,
    defaults?: Partial<Resource>,
) {
    const prefix = "spry.";
    const annotations = catalog.items
        .filter((it) => it.kind === "tag" && it.key?.startsWith(prefix))
        .map((it) =>
            [it.key!.slice(prefix.length), it.value ?? it.raw] as const
        );
    const found = annotations.length;
    if (found == 0) return undefined;

    return resourceSchema.safeParse({
        ...defaults,
        ...Object.fromEntries(annotations),
    });
}
