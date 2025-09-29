import { dirname } from "jsr:@std/path@1";
import { z } from "jsr:@zod/zod@4";
import {
    extractAnnotationsFromText,
} from "../universal/content/code-comments.ts";
import {
    forestToEdges,
    pathTree,
    pathTreeNavigation,
    pathTreeSerializers,
} from "../universal/path-tree.ts";
import { FsFileResource } from "./fs.ts";
import { Resource } from "./resource.ts";

export const routeAnnSchema = z.object({
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
    pathExtns: z.array(z.string()).optional().describe(
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

export type AnnotatedRoute = z.infer<typeof routeAnnSchema>;

export type RouteSupplier = {
    readonly route: Route;
};

export const isRouteSupplier = (o: unknown): o is RouteSupplier =>
    o && typeof o === "object" && "route" in o &&
        typeof o.route === "object"
        ? true
        : false;

export class Route {
    constructor(
        readonly annotated: AnnotatedRoute,
        readonly provenance: Awaited<
            ReturnType<typeof extractAnnotationsFromText<unknown>>
        >,
    ) {
    }

    mutateAsRouteSupplier(resource: Resource) {
        if (resource.nature === "unknown") {
            // deno-lint-ignore no-explicit-any
            (resource as any).nature = "page";
        }
        // deno-lint-ignore no-explicit-any
        (resource as any).route = this;
        return resource as Resource & RouteSupplier;
    }

    // finds all "route.*" annotations and returns them a single parsed Zod object
    static zodParsedAnnsCatalog(
        catalog: Awaited<
            ReturnType<typeof extractAnnotationsFromText<unknown>>
        >,
        defaults?: Partial<AnnotatedRoute>,
    ) {
        const prefix = "route.";
        const annotations = catalog.items
            .filter((it) => it.kind === "tag" && it.key?.startsWith(prefix))
            .map((it) =>
                [it.key!.slice(prefix.length), it.value ?? it.raw] as const
            );
        const found = annotations.length;
        if (found == 0) return undefined;

        return routeAnnSchema.safeParse({
            ...defaults,
            ...Object.fromEntries(annotations),
        });
    }

    static fromFsFileResource(
        resource: FsFileResource,
        catalog: Awaited<
            ReturnType<typeof extractAnnotationsFromText<unknown>>
        >,
    ) {
        const { extensions } = resource;
        const pathBasename = extensions.basename;
        const webPath = resource.webPath ?? resource.relFsPath;
        return Route.zodParsedAnnsCatalog(catalog, {
            path: webPath,
            pathBasename: pathBasename,
            pathBasenameNoExtn: pathBasename.split(".")[0],
            pathDirname: dirname(webPath),
            pathExtnTerminal: extensions.terminal,
            pathExtns: extensions.extensions,
        });
    }

    // finds all "route.*" annotations and returns them a Route object
    static fromAnnsCatalog(
        catalog: Awaited<
            ReturnType<typeof extractAnnotationsFromText<unknown>>
        >,
        defaults?: Partial<AnnotatedRoute>,
    ) {
        const zpac = Route.zodParsedAnnsCatalog(catalog, defaults);
        return zpac?.success ? new Route(zpac.data, catalog) : undefined;
    }
}

export class Routes {
    constructor(readonly routeAnns: Iterable<AnnotatedRoute>) {
    }

    async populate() {
        const forest = await pathTree<AnnotatedRoute, string>(
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
                        payloadItemSchema: z.toJSONSchema(routeAnnSchema),
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
