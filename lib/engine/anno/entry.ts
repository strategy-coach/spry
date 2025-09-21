import { z } from "jsr:@zod/zod@4";

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
        runBeforeAnnCatalog: z.boolean().default(true).optional().describe(
            "Instruct engine to run this before catalogging SQLPage file annotations",
        ),
        runAfterAnnCatalog: z.boolean().default(false).optional().describe(
            "Instruct engine to run this after catalogging SQLPage file annotations",
        ),
        isCleanable: z.boolean().default(false).optional().describe(
            "Instruct engine that when `clean` (delete generated artifacts) is called, call this cap ex too (CAPEXEC_DESTROY_CLEAN env var will be set)",
        ),
        dependsOn: z.enum(["none", "db-after-build"]).default("none").optional()
            .describe(
                "Expresses dependencies: 'none' means it's idempotent, 'db-after-build' means it needs the database before/after the build",
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

export type SpryEntryAnnotation = z.infer<typeof spryEntryAnnSchema>;
