import { Command } from "jsr:@cliffy/command@1.0.0-rc.8";
import { HelpCommand } from "jsr:@cliffy/command@1.0.0-rc.8/help";
import {
    bold,
    brightYellow,
    cyan,
    gray,
    green,
    red,
    yellow,
} from "jsr:@std/fmt@1/colors";
import { join, relative } from "jsr:@std/path@1";
import { ColumnDef, ListerBuilder } from "../universal/ls/mod.ts";
import { Engine } from "./engine.ts";
import { Resource } from "./resource.ts";
import { isFsFileResource } from "./fs.ts";
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
    issue: string;
};

export class CLI {
    constructor(readonly engine: Engine<Resource>) {
    }

    async init(init: { dbName: string; clean: boolean }) {
        const { spryStd, sqlPage } = this.engine.paths;

        const exists = async (path: string) =>
            await Deno.stat(path).catch(() => false);
        const relativeToCWD = (path: string) => relative(Deno.cwd(), path);

        const defaultSqlpageConf = {
            allow_exec: true,
            port: 9219,
            database_url: `sqlite://${init?.dbName}?mode=rwc`,
            web_root: "src",
        };

        const removed: string[] = [];
        if (init?.clean) {
            if (await exists(spryStd.relPathToHome)) {
                await Deno.remove(spryStd.relPathToHome);
                removed.push(spryStd.relPathToHome);
            }

            if (await exists(sqlPage.absPathToConfDir)) {
                await Deno.remove(sqlPage.absPathToConfDir, {
                    recursive: true,
                });
                removed.push(relativeToCWD(sqlPage.absPathToConfDir));
            }
        }

        const created: string[] = [];
        const linked: { from: string; to: string }[] = [];

        if (!(await exists(sqlPage.absPathToConfDir))) {
            await Deno.mkdir(sqlPage.absPathToConfDir, { recursive: true });
            created.push(relativeToCWD(sqlPage.absPathToConfDir));
            const sqpConf = join(sqlPage.absPathToConfDir, "sqlpage.json");
            await Deno.writeTextFile(
                sqpConf,
                JSON.stringify(defaultSqlpageConf, null, 2),
            );
            created.push(relativeToCWD(sqpConf));
        }

        if (!(await exists(spryStd.relPathToHome))) {
            await Deno.symlink(spryStd.homeFromSymlink, spryStd.relPathToHome);
            linked.push({
                from: spryStd.relPathToHome,
                to: spryStd.homeFromSymlink,
            });
        }

        return { spryStd, sqlPage, created, removed, linked };
    }

    lsWorkflowStepField<Row extends LsCommandRow>():
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

    summaryHooks(engine: Engine<Resource>) {
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
                    issue: "",
                }),
                    rows.get(path)!);

        // resource events → mark step, annotations, reconcile nature
        engine.resourceBus.on.resource((ev) => {
            if (!isFsFileResource(ev.resource)) return;
            const path = ev.resource.absFsPath;
            const n = ev.resource.nature;
            const r = get(path, n);
            const idx = ev.engineState.workflow.step === "discovery"
                ? 0
                : ev.engineState.workflow.step === "materialization"
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
        engine.resourceBus.on.materializedInclude((ev) => {
            if (
                ev.contentState !== "modified" || !isFsFileResource(ev.resource)
            ) {
                return;
            }
            get(ev.resource.absFsPath).impact.directives++;
        });

        // foundry events → flags (you keyed by ev.cmd)
        engine.resourceBus.on.materializedFoundry((ev) => {
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
        dbName: string;
        all?: true | undefined;
        long?: true | undefined;
        routesTree?: true | undefined;
    }) {
        const summary = this.summaryHooks(this.engine);
        await this.engine.materialize({ dryRun: true });
        const list = opts?.all
            ? summary.toList()
            : summary.toList().filter((r) =>
                r.nature === "unknown" ? false : true
            );
        await new ListerBuilder<LsCommandRow>()
            .declareColumns("step", "impact", "nature", "path", "issue")
            .from(list)
            .field("step", "step", this.lsWorkflowStepField())
            .field("nature", "nature", this.lsNatureField())
            .field("path", "path", this.lsNaturePathField())
            .field("impact", "impact", this.lsImpactField())
            .field("issue", "issue", this.lsLintField())
            .sortBy("path").sortDir("asc")
            .build()
            .ls(true);
    }

    async lsRoutes(opts?: { json?: boolean }) {
        this.engine.resourceBus.on.engineStateChange(async (ev) => {
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
        await this.engine.materialize({ dryRun: true });
    }

    cli(init?: { name?: string }) {
        return new Command()
            .name(init?.name ?? "spryctl.ts")
            .version("0.1.0")
            .description(
                "Orchestrate the content which will be supplied to SQLPage target database.",
            )
            .globalOption("--db-name <file>", "name of SQLite database", {
                default: "sqlpage.db",
            })
            .command("init")
            .description("Setup local dev environment")
            .option("--clean", "Remove existing and recreate", {
                default: false,
            })
            .action(async (opts) => {
                const { created, removed, linked } = await this.init(opts);
                removed.forEach((r) => console.warn(`❌ Removed ${r}`));
                created.forEach((c) => console.info(`📄 Created ${c}`));
                linked.forEach((l) =>
                    console.info("🔗 Linked", l.from, "to", l.to)
                );
            })
            .command("clean")
            .description("Clean auto-generated directories or files")
            .action(async () => {
                // TODO
            })
            .command("build")
            .description(
                "Perform orchestration (annotations, routes, foundries)",
            )
            .action(async (_opts) => {
                // await (await this.plan.workflow(opts)).orchestrate({
                //     cleanAuto: true,
                // });
            })
            .command("help", new HelpCommand().global())
            .command("ls", "List files consumed or impacted during the build.")
            .option("-k, --known", "Show only known resources, hide 'unknown'")
            .option("-l, --long", "Longer listing")
            .option("-t, --routes-tree", "Simple tree of annotated routes")
            .action(async (opts) => {
                if (opts.routesTree) {
                    await this.lsRoutes();
                } else {
                    await this.ls(opts);
                }
            });
    }
}
