import { basename, dirname, extname } from "jsr:@std/path@1";
import { z } from "jsr:@zod/zod@4";
import {
    type AnnotationItem,
    extractAnnotationsFromText,
} from "../universal/content/code-comments.ts";
import {
    detectLanguageByPath,
    languageExtnIndex,
} from "../universal/content/code.ts";
import {
    SpryEntryAnnotation,
    spryEntryAnnSchema,
    SpryRouteAnnotation,
    spryRouteAnnSchema,
} from "./anno/mod.ts";
import { FsPathSupplier, PathSupplier, projectPaths } from "./paths.ts";
import { EncountersSupplier, Walkers } from "./walk.ts";
import { CapExecs } from "./cap-exec.ts";
import { Linter } from "./lint.ts";
import { Workflow } from "./orchestrate.ts";

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
    ) {
        this.annotatable = Walkers.builder()
            .addRoot(projectModule, {
                exts: [
                    ...new Set([".sql", ".ts", ...languageExtnIndex.keys()]),
                ],
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
        transform?: {
            onNotFound?: () =>
                | z.input<S>
                | Promise<z.input<S>>
                | undefined
                | Promise<undefined>;
            beforeParse?: (
                grouped: z.input<S>,
                groupAnns: Partial<Record<keyof z.input<S>, AnnotationItem>>,
            ) => z.input<S> | Promise<z.input<S>>;
            onError?: (supplied: z.core.input<S>) =>
                | z.input<S>
                | Promise<z.input<S>>
                | undefined
                | Promise<undefined>;
        },
        defaults?: Partial<z.input<S>>,
    ) {
        const prefixedItems = catalog.items
            .filter((it) => it.kind === "tag" && it.key?.startsWith(prefix));
        const entries = prefixedItems.map((it) =>
            [it.key!.slice(prefix.length), it.value ?? it.raw] as const
        );
        const found = entries.length;
        if (found == 0) {
            return {
                parsed: transform?.onNotFound
                    ? await transform.onNotFound()
                    : undefined,
                error: undefined,
                found,
            };
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
            transform?.beforeParse
                ? await transform.beforeParse(grouped, anns)
                : grouped,
        );

        return result.success
            ? { parsed: result.data, error: undefined, found, anns }
            : {
                parsed: transform?.onError
                    ? await transform.onError(grouped)
                    : undefined,
                error: result.error,
                found,
                anns,
            };
    }

    static defaultPageEntryAnn(
        we: YieldOf<Annotations["sources"]>,
        webPaths: PathSupplier,
        isSystem: boolean,
    ) {
        return {
            nature: "page",
            absFsPath: we.entry.path,
            relFsPath: we.origin.paths.relative(we.entry),
            webPath: webPaths.absolute(we.entry),
            isSystemGenerated: isSystem,
        } as SpryEntryAnnotation;
    }

    static async entryAnnFromCatalog(
        we: YieldOf<Annotations["sources"]>,
        anns: Awaited<ReturnType<typeof extractAnnotationsFromText>>,
        webPaths: PathSupplier,
        transform?: {
            onNotFound?: () =>
                | SpryEntryAnnotation
                | Promise<SpryEntryAnnotation>
                | undefined
                | Promise<undefined>;
            onFound?: (
                supplied: SpryEntryAnnotation,
            ) => SpryEntryAnnotation | Promise<SpryEntryAnnotation>;
            onError?: () =>
                | SpryEntryAnnotation
                | Promise<SpryEntryAnnotation>
                | undefined
                | Promise<undefined>;
        },
    ) {
        return await Annotations.safeAnnGroup(
            spryEntryAnnSchema,
            "spry.",
            anns,
            transform,
            Annotations.defaultPageEntryAnn(we, webPaths, false),
        );
    }

    static async routeAnnFromCatalog(
        we: YieldOf<Annotations["sources"]>,
        anns: Awaited<ReturnType<typeof extractAnnotationsFromText>>,
        webpaths: ReturnType<typeof projectPaths>["webPaths"],
        transform?: {
            onNotFound?: () =>
                | SpryRouteAnnotation
                | undefined
                | Promise<SpryRouteAnnotation>
                | Promise<undefined>;
            onFound?: (
                supplied: SpryRouteAnnotation,
            ) => SpryRouteAnnotation | Promise<SpryRouteAnnotation>;
            onError?: () =>
                | SpryRouteAnnotation
                | undefined
                | Promise<SpryRouteAnnotation>
                | Promise<undefined>;
        },
    ) {
        const pathBasename = basename(we.entry.path);
        const webPath = webpaths.absolute(we.entry);
        return await Annotations.safeAnnGroup(
            spryRouteAnnSchema,
            "route.",
            anns,
            transform,
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

                const routeAnn = await Annotations.routeAnnFromCatalog(
                    we,
                    anns,
                    this.webPaths,
                );

                const entryAnn = await Annotations.entryAnnFromCatalog(
                    we,
                    anns,
                    this.webPaths,
                    {
                        // if no entry was found or the entry has an error but we have a route then let's create
                        // a default system entry of type "page"
                        onNotFound: () =>
                            routeAnn.found > 0
                                ? Annotations.defaultPageEntryAnn(
                                    we,
                                    this.webPaths,
                                    true,
                                )
                                : undefined,
                        onError: () =>
                            routeAnn.found > 0
                                ? Annotations.defaultPageEntryAnn(
                                    we,
                                    this.webPaths,
                                    true,
                                )
                                : undefined,
                    },
                );

                yield {
                    walkEntry: we,
                    annotations: anns,
                    entryAnn,
                    routeAnn,
                };
            } catch (err) {
                console.error(we.origin.paths.relative(we.entry), err);
            }
        }
    }

    async lint(
        catalog: Workflow["annsCatalog"],
        lintr: ReturnType<Linter["lintResults"]>,
    ) {
        for await (const a of catalog) {
            const content = a.walkEntry.origin.paths.relative(
                a.walkEntry.entry,
            );

            if (a.entryAnn.found > 0 && a.entryAnn.error) {
                lintr.add({
                    rule: "invalid-annotation",
                    code: "entry",
                    content,
                    message: z.prettifyError(a.entryAnn.error),
                    data: { annotation: a.entryAnn },
                    severity: "error",
                });
            }

            if (a.entryAnn.found > 0 && a.entryAnn.parsed) {
                switch (a.entryAnn.parsed.nature) {
                    case "cap-exec":
                        if (!CapExecs.isExecutable(a.walkEntry.entry.path)) {
                            lintr.add({
                                rule: "invalid-cap-exec",
                                code: "not-executable",
                                content,
                                message:
                                    "Capturable executable does not appear to be executable",
                                data: { annotation: a.entryAnn, error: null },
                                severity: "warn",
                            });
                        }
                        break;
                }
            }

            if (a.routeAnn.found > 0 && a.routeAnn.error) {
                lintr.add({
                    rule: "invalid-annotation",
                    code: "route",
                    content: a.walkEntry.origin.paths.relative(
                        a.walkEntry.entry,
                    ),
                    message: z.prettifyError(a.routeAnn.error),
                    data: { annotation: a.routeAnn },
                    severity: "error",
                });
            }
        }
    }
}
