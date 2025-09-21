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
import { z } from "jsr:@zod/zod@4";
import Table from "npm:cli-table3@0.6.5";
import { Annotations } from "./annotations.ts";
import { Plan, SQL } from "./orchestrate.ts";
import * as sqldx from "./sqlitedx.ts";
import { ColumnDef, ListerBuilder } from "../universal/ls/mod.ts";
import { SpryEntryAnnotation, SpryRouteAnnotation } from "./anno/mod.ts";

export type SafeCliArgs = {
    dbName?: string;
};

export class CLI {
    constructor(readonly plan: Plan) {
    }

    async init(init: { dbName: string; clean: boolean }) {
        const { spryStd, sqlPage } = this.plan.pp;

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

    lsNatureField<
        Row extends { nature: SpryEntryAnnotation["nature"] },
    >(): Partial<ColumnDef<Row, SpryEntryAnnotation["nature"]>> {
        return {
            header: "Nature",
            format: (v) =>
                v === "action"
                    ? green(v)
                    : v === "sql"
                    ? yellow(v)
                    : v === "cap-exec"
                    ? brightYellow(v)
                    : cyan(v),
        };
    }

    lsPathField<
        Row extends { nature: SpryEntryAnnotation["nature"]; error?: string },
    >(): Partial<ColumnDef<Row, string>> {
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
            }, {
                when: (_v, r) => r.nature === "cap-exec",
                color: brightYellow,
            }],
        };
    }

    lsLintField<Row extends { error: string }>():
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
        const workflow = await this.plan.workflow();
        const list = (await workflow.entryAnnotations()).valid.map((ea) => ({
            nature: ea.entryAnn.nature,
            path: ea.we.entry.path,
            error: ea.ann.error ? z.prettifyError(ea.ann.error) : "",
        }));
        await new ListerBuilder<typeof list[number]>()
            .declareColumns("nature", "path", "error")
            .from(list)
            .field("nature", "nature", this.lsNatureField())
            .field("path", "path", this.lsPathField())
            .field("error", "error", this.lsLintField())
            .sortBy("path").sortDir("asc")
            .build()
            .ls(true);
    }

    async lsAnnotations(_opts: { json?: boolean }) {
        const anns = new Annotations(
            this.plan.pp.projectFsPaths,
            this.plan.pp.webPaths,
        );
        const table = new Table({
            head: ["E", "R", "Path", "Entry Error", "Route Error"],
        });
        for await (const a of anns.catalog()) {
            if (a.entryAnn.found == 0 && a.routeAnn.found == 0) continue;
            table.push([
                a.entryAnn?.error
                    ? ""
                    : (a.entryAnn.found ? String(a.entryAnn.found) : ""),
                a.routeAnn?.error
                    ? ""
                    : (a.routeAnn.found ? String(a.routeAnn.found) : ""),
                relative(Deno.cwd(), a.walkEntry.entry.path),
                a.entryAnn?.error ? z.prettifyError(a.entryAnn.error) : "",
                a.routeAnn?.error ? z.prettifyError(a.routeAnn.error) : "",
            ]);
        }
        console.log(table.toString());
    }

    async lsSqlSources(opts: { target: "head" | "tail" }) {
        switch (opts.target) {
            case "head":
                console.log(
                    await Array.fromAsync(new SQL(this.plan).headSqlSources()),
                );
                break;
            case "tail":
                console.log(
                    await Array.fromAsync(new SQL(this.plan).tailSqlSources()),
                );
                break;
        }
    }

    async lsCapExecs(_opts: { json?: true }) {
        const workflow = await this.plan.workflow();
        const capExecs = await workflow.capExecs();
        const table = new Table({
            head: ["Path", "Phase", "Depends On"],
        });
        for (const ce of capExecs.ceSelected) {
            table.push([
                this.plan.pp.projectFsPaths.relative(ce.we.entry),
                ce.ann.materializePhase,
                ce.ann.dependsOn,
            ]);
        }
        console.log(table.toString());
    }

    async lsRoutes(opts?: { json?: boolean }) {
        const workflow = await this.plan.workflow();
        const { serializers } = await workflow.routeAnnotations();

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

    async lsBreadcrumbs(opts: { json?: boolean }) {
        const workflow = await this.plan.workflow();
        const { breadcrumbs } = await workflow.routeAnnotations();

        if (opts.json) {
            console.dir(breadcrumbs);
            return;
        }

        const table = new Table({ head: ["Path", "Breadcrumbs"] });
        for (const [path, node] of Object.entries(breadcrumbs)) {
            table.push([
                path,
                node.map((bc) => bc.hrefs.index ?? bc.hrefs.trailingSlash)
                    .join("\n"),
            ]);
        }
        console.log(table.toString());
    }

    async dev(opts: { dbName: string; cleanDb: boolean }) {
        await new sqldx.DevExperience()
            .withDb(opts.dbName)
            .withSqlText(async () => {
                if (opts.cleanDb) {
                    await Deno.remove(opts.dbName).catch(() =>
                        console.warn(`Creating: ${opts.dbName}`)
                    ).then(() => console.warn(`Removed ${opts.dbName}`));
                }
                const workflow = await this.plan.workflow(opts);
                await workflow.orchestrate({ cleanAuto: true });
                return await Array.fromAsync(
                    new SQL(this.plan).deploy(),
                );
            }, {
                onInit: true,
                onReload: () => true,
            })
            .watch(...this.plan.pp.devWatchRoots)
            .restartDelayMs(250) // fixed delay after SQLite closes
            .beforeSqlpageRestart(async () => {
                // do any OS/filesystem synchronization checks you need
                // e.g., fs.stat, retry loops, etc.
            })
            .start();
    }

    async SQL(
        opts: {
            target: "head" | "tail" | "sqlpage-files" | "deploy";
            dbName: string;
        },
    ) {
        switch (opts.target) {
            case "head":
                console.log(
                    (await Array.fromAsync(new SQL(this.plan).headSQL())).join(
                        "\n",
                    ),
                );
                break;
            case "tail":
                console.log(
                    (await Array.fromAsync(new SQL(this.plan).tailSQL())).join(
                        "\n",
                    ),
                );
                break;
            case "sqlpage-files":
                console.log(
                    (await Array.fromAsync(new SQL(this.plan).seedInserts()))
                        .join("\n"),
                );
                break;
            case "deploy":
                await new SQL(this.plan).toStdOut();
                break;
            default:
                console.warn(`Unknown target '${opts.target}'`);
        }
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
                await this.plan.clean();
            })
            .command("build")
            .description("Perform orchestration (annotations, routes, capexes)")
            .action(async (opts) => {
                await (await this.plan.workflow(opts)).orchestrate({
                    cleanAuto: true,
                });
            })
            .command("help", new HelpCommand().global())
            .command(
                "ls",
                new Command()
                    .description(
                        "List SQLPage .sql files excluding migrations.",
                    )
                    .action(async () => await this.ls())
                    .command("ann", "List annotations discovered")
                    .option("-j, --json", "Emit as JSON instead of table")
                    .action(async (opts) => await this.lsAnnotations(opts))
                    .command(
                        "cap-execs",
                        "List capturable executable candidates",
                    )
                    .option("-j, --json", "Emit as JSON instead of tree")
                    .action(async (opts) => await this.lsCapExecs(opts))
                    .command(
                        "routes",
                        "List SQLPage .sql files that include route annotations.",
                    )
                    .option("-j, --json", "Emit as JSON instead of tree")
                    .action(async (opts) => await this.lsRoutes(opts))
                    .command(
                        "breadcrumbs",
                        "List SQLPage .sql files that include route annotations and their breadcrumbs.",
                    )
                    .option(
                        "-j, --json",
                        "dump the entire breadcrumbs object as JSON",
                    )
                    .action(async (opts) => await this.lsBreadcrumbs(opts))
                    .command("head")
                    .action(async () =>
                        await this.lsSqlSources({ target: "head" })
                    )
                    .command("tail")
                    .action(async () =>
                        await this.lsSqlSources({ target: "tail" })
                    ),
            )
            .command(
                "sql",
                new Command()
                    .description(
                        "Emit SQL (without reprocessing any files, use 'build' first)",
                    )
                    .globalOption(
                        "--db-name <file>",
                        "name of SQLite database",
                        {
                            default: "sqlpage.db",
                        },
                    )
                    .command("head")
                    .action(async (opts) =>
                        await this.SQL({ target: "head", ...opts })
                    )
                    .command("tail")
                    .action(async (opts) =>
                        await this.SQL({ target: "tail", ...opts })
                    )
                    .command("sqlpage-files")
                    .action(async (opts) =>
                        await this.SQL({ target: "sqlpage-files", ...opts })
                    )
                    .command("deploy")
                    .action(async (opts) =>
                        await this.SQL({ target: "deploy", ...opts })
                    ),
            )
            .action(async (opts) =>
                await this.SQL({ target: "deploy", ...opts })
            )
            .command("dev")
            .description(`Rebuild src on change and restart SQLPage.`)
            .option("--clean-db", "Delete the database each time (dangerous)", {
                default: false,
            })
            .action(async (opts) => await this.dev(opts));
    }
}
