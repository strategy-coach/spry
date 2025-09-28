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
import { Engine, ResourceEvents } from "./engine.ts";
import { Resource } from "./resource.ts";
import { isFsFileResource } from "./fs.ts";

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

    lsWorkflowStepField<
        Row extends { step: { discovery: boolean; materialize: boolean } },
    >():
        | Partial<ColumnDef<Row, Row["step"]>>
        | undefined {
        return {
            header: "Step",
            defaultColor: gray,
            format: (v) =>
                `${v.discovery ? "🔍" : " "}${v.materialize ? "📦" : " "}`,
        };
    }

    lsImpactField<
        Row extends {
            impact: {
                foundry: boolean;
                autoMaterialize: boolean;
                directives: number;
            };
        },
    >():
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
                } ${v.directives ? "D" : " "}`,
        };
    }

    lsNatureField<Row extends { nature: Resource["nature"] }>(): Partial<
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

    lsNaturePathField<
        Row extends { nature: Resource["nature"]; issue?: string },
    >(): Partial<ColumnDef<Row, string>> {
        const lscpf = this.lsColorPathField();
        return {
            ...lscpf,
            rules: [...(lscpf.rules ? lscpf.rules : []), {
                when: (_v, r) => r.nature === "foundry",
                color: brightYellow,
            }],
        };
    }

    lsLintField<Row extends { issue: string }>():
        | Partial<ColumnDef<Row, string>>
        | undefined {
        return {
            header: "Lint Message",
            defaultColor: gray,
            format: (v) => v.length > 0 ? `⛔ ${v}` : "✓",
            rules: [{ when: (v) => v.trim().length > 0, color: red }],
        };
    }

    async ls() {
        const dResources: ResourceEvents<Resource>["resource"][] = [];
        const mResources: ResourceEvents<Resource>["resource"][] = [];
        const directives = new Map<
            string,
            ResourceEvents<Resource>["materializedInclude"]
        >();
        const foundries = new Map<
            string,
            ResourceEvents<Resource>["materializedFoundry"]
        >();

        this.engine.resourceBus.on.resource((ev) => {
            switch (ev.engineState.workflow.step) {
                case "discovery":
                    dResources.push(ev);
                    break;
                case "materialization":
                    mResources.push(ev);
                    break;
                default:
                    console.warn(`not sure what to do with`, { ev });
            }
        });

        this.engine.resourceBus.on.materializedInclude((ev) => {
            if (ev.contentState === "modified") {
                if (isFsFileResource(ev.resource)) {
                    directives.set(ev.resource.absFsPath, ev);
                } else {
                    console.warn(`not sure what to do with this event`, { ev });
                }
            }
        });

        this.engine.resourceBus.on.materializedFoundry((ev) => {
            foundries.set(ev.cmd, ev);
        });

        await this.engine.materialize({ dryRun: true });

        const paths = new Set<string>();
        for (const dr of dResources) {
            if (isFsFileResource(dr.resource)) paths.add(dr.resource.absFsPath);
        }
        for (const mr of mResources) {
            if (isFsFileResource(mr.resource)) paths.add(mr.resource.absFsPath);
        }

        type Row = {
            step: { discovery: boolean; materialize: boolean };
            impact: {
                foundry: boolean;
                autoMaterialize: boolean;
                directives: number;
            };
            nature: Resource["nature"];
            annotations: [number, number];
            path: string;
            issue: string;
        };
        const list = Array.from(
            paths.values().map((path) => {
                const inD = dResources.find((r) =>
                    isFsFileResource(r.resource) && r.resource.absFsPath == path
                        ? true
                        : false
                );
                const inM = mResources.find((r) =>
                    isFsFileResource(r.resource) && r.resource.absFsPath == path
                        ? true
                        : false
                );
                return {
                    step: {
                        discovery: inD ? true : false,
                        materialize: inM ? true : false,
                    },
                    impact: {
                        foundry: foundries.has(path),
                        autoMaterialize: foundries.get(path)?.matAbsFsPath
                            ? true
                            : false,
                        directives: directives.has(path) ? 1 : 0,
                    },
                    nature: inD?.resource.nature && inM?.resource.nature &&
                            (inD?.resource.nature == inM?.resource.nature)
                        ? inD.resource.nature
                        : `${inD?.resource.nature}:${inD?.resource.nature}` as Resource[
                            "nature"
                        ],
                    path,
                    annotations: [
                        inD?.annsCatalog?.items.length ?? 0,
                        inM?.annsCatalog?.items.length ?? 0,
                    ],
                    issue: "",
                } satisfies Row;
            }),
        );

        await new ListerBuilder<typeof list[number]>()
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
            .option("-l, --long", "Longer listing", {
                default: false,
            })
            .action(async () => {
                await this.ls();
            });
    }
}
