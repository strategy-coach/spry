import { basename, dirname, extname } from "jsr:@std/path@1";
import { z } from "jsr:@zod/zod@4";
import {
    type AnnotationItem,
    extractAnnotationsFromText,
} from "../universal/content/code-comments.ts";
import { detectLanguageByPath } from "../universal/content/code.ts";
import {
    SpryEntryAnnotation,
    spryEntryAnnSchema,
    SpryRouteAnnotation,
    spryRouteAnnSchema,
} from "./anno/mod.ts";
import { FsPathSupplier, PathSupplier, projectPaths } from "./paths.ts";
import { EncountersSupplier, Walkers } from "./walk.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

type YieldOf<T extends (...args: Any) => Any> = Awaited<ReturnType<T>> extends
    AsyncGenerator<infer Y, Any, Any> ? Y
    : Awaited<ReturnType<T>> extends AsyncIterableIterator<infer Y> ? Y
    : never;

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

    static async safeAnnGroup<S extends z.ZodTypeAny, Payload>(
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

    static async entryAnnFromCatalog(
        we: YieldOf<Annotations["sources"]>,
        anns: Awaited<ReturnType<typeof extractAnnotationsFromText>>,
        transformEntryAnn?: (
            enc: SpryEntryAnnotation,
        ) => SpryEntryAnnotation | Promise<SpryEntryAnnotation>,
    ) {
        return await Annotations.safeAnnGroup(
            spryEntryAnnSchema,
            "spry.",
            anns,
            transformEntryAnn,
            {
                "nature": "page",
                "absFsPath": we.entry.path,
                "relFsPath": we.origin.paths.relative(we.entry),
            },
        );
    }

    static async routeAnnFromCatalog(
        we: YieldOf<Annotations["sources"]>,
        anns: Awaited<ReturnType<typeof extractAnnotationsFromText>>,
        webpaths: ReturnType<typeof projectPaths>["webPaths"],
        transformRouteAnn?: (
            enc: SpryRouteAnnotation,
        ) => SpryRouteAnnotation | Promise<SpryRouteAnnotation>,
    ) {
        const pathBasename = basename(we.entry.path);
        const webPath = webpaths.absolute(we.entry);
        return await Annotations.safeAnnGroup(
            spryRouteAnnSchema,
            "route.",
            anns,
            transformRouteAnn,
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
                    entryAnn: await Annotations.entryAnnFromCatalog(
                        we,
                        anns,
                        this.init?.transformEntryAnn,
                    ),
                    routeAnn: await Annotations.routeAnnFromCatalog(
                        we,
                        anns,
                        this.webPaths,
                        this.init?.transformRouteAnn,
                    ),
                };
            } catch (err) {
                console.error(we.origin.paths.relative(we.entry), err);
            }
        }
    }
}
