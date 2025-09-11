import { dirname } from "jsr:@std/path@1";
import { z } from "jsr:@zod/zod@^4.1.5";
import { annotationsParser } from "../../universal/annotations.ts";

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
  caption: z.string().describe(
    "Human-friendly general-purpose name for display.",
  ),
  namespace: z.string().describe(
    "Logical grouping; allows multiple independent navigation trees.",
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
  "Navigation route annotation matching the `spry_route` view: unique within (namespace, parentPath, path), supports hierarchy and ordered siblings.",
);

export type SpryEntryAnnotation = z.infer<typeof spryEntryAnnSchema>;
export type SpryRouteAnnotation = z.infer<typeof spryRouteAnnSchema>;

export const spryEntryAnnParser = annotationsParser("spry", spryEntryAnnSchema);
export const spryRouteAnnParser = annotationsParser(
  "route",
  spryRouteAnnSchema,
);

export async function annotatableContent<
  Encountered extends Readonly<{
    path: string;
    relPath: string;
  }>,
>(
  encountered: Encountered,
  options?: {
    transformEntry?: (
      enc: SpryEntryAnnotation,
    ) => SpryEntryAnnotation | Promise<SpryEntryAnnotation>;
    transformRoute?: (
      enc: SpryRouteAnnotation,
    ) => SpryRouteAnnotation | Promise<SpryRouteAnnotation>;
  },
) {
  const isInRoot = dirname(encountered.relPath) == ".";
  const content = await Deno.readTextFile(encountered.path);

  let isEntryAnnotated = false;
  const entryAnn = spryEntryAnnParser.parse(content, (obj, ensure) => {
    isEntryAnnotated = Object.hasOwn(obj, "nature");
    ensure(obj, "nature", "page");
    ensure(obj, "absPath", encountered.path);
    ensure(obj, "relPath", encountered.relPath);
    return true;
  });
  if (options?.transformEntry && entryAnn?.success) {
    entryAnn.data = await options.transformEntry(entryAnn.data);
  }

  let isRouteAnnotated = false;
  const routeAnn = spryRouteAnnParser.parse(content, (obj, ensure) => {
    if (Object.entries(obj).length === 0) return false;
    isRouteAnnotated = true;
    ensure(obj, "namespace", "_");
    ensure(obj, "path", encountered.relPath);
    return true;
  });
  if (options?.transformRoute && isRouteAnnotated && routeAnn?.success) {
    routeAnn.data = await options.transformRoute(routeAnn.data);
  }

  return {
    content,
    encountered,
    isInRoot,
    isEntryAnnotated,
    entryAnn,
    isRouteAnnotated,
    routeAnn,
  };
}
