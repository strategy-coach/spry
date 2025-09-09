import { dirname } from "jsr:@std/path@1";
import { z } from "jsr:@zod/zod@^4.1.5";
import { annotationsParser } from "../../lib/universal/annotations.ts";

const spryEntry = annotationsParser(
  "spry",
  z.object({
    nature: z.enum(["action", "api", "page", "sql-sp"]).default("page")
      .describe(
        `The nature of this file, influencing how it's treated by the system, defaults to 'page'. 
         Possible values are 'action' for code that executes and redirects back to page, 'api' for
         API endpoints, 'page' for standard web pages, and 'sql-sp' for SQL stored procedures.`,
      ),
    // Additional fields can be added here as needed
    absPath: z.string(),
    relPath: z.string(),
  }).strict(),
);

const spryRoute = annotationsParser(
  "route",
  z.object({
    path: z.string(),
    caption: z.string(),
    namespace: z.string(),
    parentPath: z.string().optional(),
    siblingOrder: z.number().optional(),
    url: z.string().optional(),
    abbreviatedCaption: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    elaboration: z.json().optional(),
  }).strict(),
);

export async function annotatedContent(
  encountered: Readonly<{
    /** Absolute filesystem path of the current root being walked. */
    root: string;
    /** Absolute path of the matched file. (Directories are not emitted.) */
    path: string;
    /** Path of the matched file relative to `root`. */
    relPath: string;
  }>,
) {
  const isInRoot = dirname(encountered.relPath) == ".";
  const content = await Deno.readTextFile(encountered.path);
  let isEntryAnnotated = false;
  const entry = spryEntry.parse(content, (obj, ensure) => {
    isEntryAnnotated = Object.hasOwn(obj, "nature");
    ensure(obj, "nature", "page");
    ensure(obj, "absPath", encountered.path);
    ensure(obj, "relPath", encountered.relPath);
    return true;
  });
  let isRouteAnnotated = false;
  const route = spryRoute.parse(content, (obj, ensure) => {
    if (Object.entries(obj).length === 0) return false;
    isRouteAnnotated = true;
    ensure(obj, "namespace", "spry");
    if (!isInRoot) {
      let parentPath = dirname(dirname(encountered.relPath));
      if (parentPath === ".") parentPath = "spry";
      ensure(
        obj,
        "parentPath",
        `/${parentPath}/index.sql`,
      );
    }
    ensure(obj, "path", `/${encountered.relPath}`);
    return true;
  });
  return {
    content,
    encountered,
    isInRoot,
    isEntryAnnotated,
    entry,
    isRouteAnnotated,
    route,
  };
}
