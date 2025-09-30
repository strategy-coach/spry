import { z } from "jsr:@zod/zod@4";
import {
  forestToEdges,
  pathTree,
  pathTreeNavigation,
  pathTreeSerializers,
} from "../../universal/path-tree.ts";

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

export type SpryRouteAnnotation = z.infer<typeof spryRouteAnnSchema>;

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

    const breadcrumbs: Record<string, ReturnType<typeof nav.ancestors>> = {};
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
