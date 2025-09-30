import {
    bold,
    brightYellow,
    cyan,
    gray,
    green,
    red,
    yellow,
} from "jsr:@std/fmt@1/colors";
import { basename, relative } from "jsr:@std/path@1";
import { ColumnDef, ListerBuilder, TreeLister } from "../universal/ls/mod.ts";
import { Assembler } from "./assembler.ts";
import { isFsFileResource } from "./fs.ts";
import { Resource } from "./resource.ts";
import { AnnotatedRoute, isRouteSupplier, Routes } from "./route.ts";

export type LsCommandRow = {
    step: { discovery: boolean; materialize: boolean };
    impact: {
        foundry: boolean;
        autoMaterialize: boolean;
        directives: number;
        isRoutable: boolean;
    };
    nature: Resource["nature"] | `${Resource["nature"]}:${Resource["nature"]}`;
    path: string;
    name: string;
    issue: string;
};

/**
 * Ensure all ancestor directories exist as rows.
 * - items: your existing rows (any shape)
 * - pathOf: how to extract a path string from a row
 * - makeRow: how to create a row for a missing directory, given its path
 * - isFile (optional): how to decide if a path is a file; defaults to "last segment contains a dot"
 */
export function upsertMissingAncestors<T>(
    items: T[],
    pathOf: (item: T) => string,
    makeRow: (dirPath: string) => T,
    isFile: (path: string) => boolean = (p) => {
        const segs = p.split("/").filter(Boolean);
        return segs.length > 0 && segs[segs.length - 1].includes(".");
    },
): T[] {
    const seen = new Set(items.map(pathOf));
    const out = [...items];

    for (const item of items) {
        const p = pathOf(item);
        const segs = p.split("/").filter(Boolean);
        const max = isFile(p) ? segs.length - 1 : segs.length;

        for (let i = 1; i <= max; i++) {
            const dirPath = segs.slice(0, i).join("/");
            if (!seen.has(dirPath)) {
                out.push(makeRow(dirPath));
                seen.add(dirPath);
            }
        }
    }
    return out;
}

export class CLI<R extends Resource, A extends Assembler<R>> {
    constructor(
        readonly freshAssembler: (
            init: { dryRun: boolean; cleaningRequested: boolean },
        ) => A,
    ) {
    }

    lsWorkflowStepsField<Row extends LsCommandRow>():
        | Partial<ColumnDef<Row, Row["step"]>>
        | undefined {
        return {
            header: "Step",
            defaultColor: gray,
            format: (v) =>
                `${v.discovery ? "🔍" : " "}${v.materialize ? "📦" : " "}`,
        };
    }

    lsImpactField<Row extends LsCommandRow>():
        | Partial<ColumnDef<Row, Row["impact"]>>
        | undefined {
        return {
            header: "Impact",
            defaultColor: gray,
            format: (v) =>
                `${
                    brightYellow(
                        v.foundry && v.autoMaterialize
                            ? "FA"
                            : (v.foundry ? "F " : "  "),
                    )
                } ${v.directives ? "D" : " "} ${v.isRoutable ? "R" : " "}`,
        };
    }

    lsNatureField<Row extends LsCommandRow>(): Partial<
        ColumnDef<Row, Row["nature"]>
    > {
        return {
            header: "Nature",
            format: (v) =>
                v === "action"
                    ? green(v)
                    : v === "sql"
                    ? yellow(v)
                    : v === "foundry"
                    ? brightYellow(v)
                    : cyan(v),
        };
    }

    // deno-lint-ignore no-explicit-any
    lsColorPathField(): Partial<ColumnDef<any, string>> {
        return {
            header: "Path",
            format: (supplied) => {
                const p = relative(Deno.cwd(), supplied);
                const i = p.lastIndexOf("/");
                return i < 0
                    ? bold(p)
                    : gray(p.slice(0, i + 1)) + bold(p.slice(i + 1));
            },
            rules: [{
                when: (_v, r) => (r.error?.trim().length ?? 0) > 0,
                color: red,
            }],
        };
    }

    // deno-lint-ignore no-explicit-any
    lsColorNameField(): Partial<ColumnDef<any, string>> {
        return {
            header: "Name",
            rules: [{
                when: (_v, r) => (r.error?.trim().length ?? 0) > 0,
                color: red,
            }, {
                when: (_v, r) => (r.nature === "foundry"),
                color: brightYellow,
            }],
        };
    }

    lsNaturePathField<Row extends LsCommandRow>(): Partial<
        ColumnDef<Row, string>
    > {
        const lscpf = this.lsColorPathField();
        return {
            ...lscpf,
            rules: [...(lscpf.rules ? lscpf.rules : []), {
                when: (_v, r) => r.nature === "foundry",
                color: brightYellow,
            }],
        };
    }

    lsLintField<Row extends LsCommandRow>():
        | Partial<ColumnDef<Row, string>>
        | undefined {
        return {
            header: "Lint Message",
            defaultColor: gray,
            format: (v) => v.length > 0 ? `⛔ ${v}` : "✓",
            rules: [{ when: (v) => v.trim().length > 0, color: red }],
        };
    }

    summaryHooks(assembler: A) {
        const rows = new Map<string, LsCommandRow>();
        const get = (path: string, n?: Resource["nature"]) =>
            rows.get(path) ??
                (rows.set(path, {
                    step: { discovery: false, materialize: false },
                    impact: {
                        foundry: false,
                        autoMaterialize: false,
                        directives: 0,
                        isRoutable: false,
                    },
                    nature: (n ?? "unknown") as LsCommandRow["nature"],
                    path,
                    name: basename(path),
                    issue: "",
                }),
                    rows.get(path)!);

        // resource events → mark step, annotations, reconcile nature
        assembler.resourceBus.on("resource:encountered", (ev) => {
            if (!isFsFileResource(ev.resource)) return;
            const path = ev.resource.absFsPath;
            const n = ev.resource.nature;
            const r = get(path, n);
            const idx = ev.assemblerState.workflow.step === "discovery"
                ? 0
                : ev.assemblerState.workflow.step === "materialization"
                ? 1
                : -1;
            if (idx < 0) return;
            idx === 0 ? (r.step.discovery = true) : (r.step.materialize = true);
            r.nature = r.nature && r.nature !== n
                ? `${r.nature}:${n}` as LsCommandRow["nature"]
                : n;
            if (isRouteSupplier(ev.resource)) r.impact.isRoutable = true;
        });

        // "include" events → count directives (only modified fs files)
        assembler.resourceBus.on("directive:include:materialized", (ev) => {
            if (
                ev.contentState !== "modified" || !isFsFileResource(ev.resource)
            ) {
                return;
            }
            get(ev.resource.absFsPath).impact.directives++;
        });

        // foundry events → flags (you keyed by ev.cmd)
        assembler.resourceBus.on("foundry:materialized", (ev) => {
            const r = get(ev.cmd);
            r.impact.foundry = true;
            r.impact.autoMaterialize = !!ev.matAbsFsPath;
        });

        return {
            toList: (() => {
                return [...rows.values()].sort((a, b) =>
                    a.path.localeCompare(b.path)
                );
            }),
        };
    }

    async ls(opts: {
        known?: true | undefined;
        long?: true | undefined;
        tree?: true | undefined;
        routes?: true | undefined;
    }) {
        const assembler = this.freshAssembler({
            dryRun: true,
            cleaningRequested: false,
        });
        const summary = this.summaryHooks(assembler);
        await assembler.materialize();
        let list = summary.toList();
        if (opts?.known) {
            list = list.filter((r) => r.nature === "unknown" ? false : true);
        }
        if (opts?.routes) {
            list = list.filter((r) => r.impact.isRoutable);
        }

        if (opts.tree) {
            list = upsertMissingAncestors<LsCommandRow>(
                list.map((r) => ({
                    ...r,
                    path: relative(Deno.cwd(), r.path),
                })),
                (r) => r.path,
                (path) => ({
                    path,
                    name: basename(path),
                    impact: {
                        autoMaterialize: false,
                        directives: 0,
                        foundry: false,
                        isRoutable: false,
                    },
                    issue: "",
                    // deno-lint-ignore no-explicit-any
                    nature: "" as any,
                    step: { discovery: true, materialize: true },
                }),
            );

            const base = new ListerBuilder<LsCommandRow>()
                .declareColumns(
                    "name",
                    "step",
                    "impact",
                    "nature",
                    "path",
                    "issue",
                )
                .from(list)
                .field("name", "name", this.lsColorNameField())
                .field("step", "step", this.lsWorkflowStepsField())
                .field("nature", "nature", this.lsNatureField())
                .field("impact", "impact", this.lsImpactField())
                // IMPORTANT: make the tree column first so glyphs appear next to it
                .select("name", "nature", "impact", "step");
            const tree = TreeLister
                .wrap(base)
                .from(list)
                .byPath({ pathKey: "path", separator: "/" })
                .treeOn("name");
            await tree.ls(true);
        } else {
            await new ListerBuilder<LsCommandRow>()
                .declareColumns("step", "impact", "nature", "path", "issue")
                .from(list)
                .field("path", "path", this.lsNaturePathField())
                .field("step", "step", this.lsWorkflowStepsField())
                .field("nature", "nature", this.lsNatureField())
                .field("impact", "impact", this.lsImpactField())
                .field("issue", "issue", this.lsLintField())
                .sortBy("path").sortDir("asc")
                .build()
                .ls(true);
        }
    }

    async lsRoutes(opts?: { json?: boolean }) {
        const assembler = this.freshAssembler({
            dryRun: true,
            cleaningRequested: false,
        });
        assembler.resourceBus.on("assembler:state:mutated", async (ev) => {
            if (ev.current.step === "final") {
                const routes = new Routes(
                    ev.current.materialized.resources.filter(isRouteSupplier)
                        .map((rs) =>
                            isRouteSupplier(rs)
                                ? rs.route.annotated
                                : {} as AnnotatedRoute
                        ),
                );
                const { serializers } = await routes.populate();
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
        });
        await assembler.materialize();
    }
}
