import { join, normalize, relative } from "jsr:@std/path@1";
import { eq, getTableName, sql } from "npm:drizzle-orm@0.44.5";
import { drizzle } from "npm:drizzle-orm@0.44.5/libsql";
import {
    check,
    SQLiteColumn,
    sqliteTable,
    text,
} from "npm:drizzle-orm@0.44.5/sqlite-core";
import { omitPathsReplacer } from "../universal/json.ts";
import { MarkdownStore } from "../universal/markdown.ts";
import { provenanceText } from "../universal/reflect/provenance.ts";
import { inlinedSQL } from "../universal/sql-text.ts";
import {
    Annotations,
    Routes,
    SpryEntryAnnotation,
    SpryRouteAnnotation,
} from "./annotations.ts";
import { CapExecs, SpryCapExecEntryAnnotation } from "./cap-exec.ts";
import { SafeCliArgs } from "./cli.ts";
import { Linter } from "./lint.ts";
import { FsPathSupplier, PathSupplier, projectPaths } from "./paths.ts";
import { JsonStore, Store } from "./storage.ts";
import {
    EncountersSupplier,
    WalkEncounter,
    Walkers,
    WalkSpec,
} from "./walk.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

type YieldOf<T extends (...args: Any) => Any> = Awaited<ReturnType<T>> extends
    AsyncGenerator<infer Y, Any, Any> ? Y
    : Awaited<ReturnType<T>> extends AsyncIterableIterator<infer Y> ? Y
    : never;

export function sqliteModels() {
    const checkJSON = (c: SQLiteColumn) =>
        check(
            `${c.name}_check_valid_json`,
            sql`json_valid(${c}) OR ${c} IS NULL`,
        );

    const sqlpageFiles = sqliteTable("sqlpage_files", {
        // web path which SQLPage translates from URL to `contents`
        path: text().primaryKey().notNull(),

        // SQLPage file contents for rendering
        contents: text().notNull(),

        // Last modified timestamp for SQLPage to auto-refresh, defaults to CURRENT_TIMESTAMP
        lastModified: text("last_modified")
            .default(sql`CURRENT_TIMESTAMP`)
            .notNull(),
    });

    return {
        checkJSON,
        sqlpageFiles,
    };
}

export class SqlPageFiles {
    readonly candidates: EncountersSupplier;

    constructor(
        readonly projectModule: FsPathSupplier,
        readonly webPaths: PathSupplier,
    ) {
        this.candidates = Walkers.builder()
            .addRoot(projectModule, {
                exts: [".sql", ".json"],
                includeDirs: false,
                includeFiles: true,
                includeSymlinks: false,
                followSymlinks: true, // important for "src/spry"
                canonicalize: true, // important for "src/spry"
            })
            .build();
    }

    async *sources() {
        yield* this.candidates.encountered();
    }
}

export class Workflow {
    readonly linter: Linter;
    readonly lintr: ReturnType<Linter["lintResults"]>;
    readonly stores: ReturnType<Plan["stores"]>;
    readonly pp: Plan["pp"];
    readonly spf: ReturnType<Plan["sqlpageFiles"]>;
    readonly annotations: ReturnType<Plan["annotations"]>;

    #annsCatalog?: YieldOf<
        ReturnType<Plan["annotations"]>["catalog"]
    >[];

    readonly mdStore = new MarkdownStore<"orchestrated.auto.md">();
    readonly orchMD = this.mdStore.markdown("orchestrated.auto.md");

    protected constructor(
        readonly plan: Plan,
        readonly cliOpts?: SafeCliArgs,
    ) {
        this.pp = plan.pp;
        this.linter = plan.linter();
        this.lintr = this.linter.lintResults();
        this.stores = plan.stores();
        this.spf = plan.sqlpageFiles();
        this.annotations = plan.annotations();
    }

    static async build(plan: Plan, cliOpts?: SafeCliArgs) {
        return await new Workflow(plan, cliOpts).init();
    }

    get annsCatalog() {
        return this.#annsCatalog!; // will become available after call to init()
    }

    protected async init() {
        this.#annsCatalog = await Array.fromAsync(this.annotations.catalog());

        this.orchMD.h1("Orchestration Results");
        this.orchMD.br().p(
            `Check the file date for when it was last executed.`,
        );

        this.orchMD.h2("SQLPage Files Candidates");
        this.orchMD.table(
            ["Root", "Web Path", "Fs Path"],
            (await Array.fromAsync(this.spf.candidates.encountered())).map((
                src,
            ) => [
                src.origin.paths.identity ?? "",
                this.pp.webPaths.absolute(src.entry),
                src.origin.paths.relative(src.entry),
            ]),
        );

        // allow method chaining, usually from constructor
        return this;
    }

    // deno-lint-ignore require-await
    async lintEntryAnn(
        ea: SpryEntryAnnotation,
        we: WalkEncounter<WalkSpec>,
    ) {
        switch (ea.nature) {
            case "cap-exec":
                if (!CapExecs.isExecutable(we.entry.path)) {
                    this.lintr.add({
                        rule: "invalid-cap-exec",
                        code: "not-executable",
                        content: we.origin.paths.relative(we.entry),
                        message:
                            "Capturable executable does not appear to be executable",
                        data: { annotation: ea },
                        severity: "warn",
                    });
                }
                break;
        }
    }

    // deno-lint-ignore require-await
    async entryAnnotations(lint = false) {
        type base = {
            we: Workflow["annsCatalog"][number]["walkEntry"];
            ann: Workflow["annsCatalog"][number]["entryAnn"];
        };
        const entryAnns: (base & {
            entryAnn: SpryEntryAnnotation;
        })[] = [];
        const issues: base[] = [];
        for (const a of this.annsCatalog) {
            if (a.entryAnn.found > 0 && a.entryAnn.parsed) {
                entryAnns.push({
                    we: a.walkEntry,
                    ann: a.entryAnn,
                    entryAnn: a.entryAnn.parsed,
                });
                if (lint) this.lintEntryAnn(a.entryAnn.parsed, a.walkEntry);
            } else if (a.entryAnn.found > 0) {
                if (lint) {
                    this.lintr.add({
                        rule: "invalid-annotation",
                        code: "entry",
                        content: a.walkEntry.origin.paths.relative(
                            a.walkEntry.entry,
                        ),
                        message: "Invalid entry annotation",
                        data: { annotation: a.entryAnn },
                        severity: "error",
                    });
                } else {
                    issues.push({ we: a.walkEntry, ann: a.entryAnn });
                }
            }
        }
        return { valid: entryAnns, issues };
    }

    async capExecEntryAnnotations(lint = false) {
        const entryAnns = await this.entryAnnotations(lint);
        return entryAnns.valid.filter((ea) => ea.entryAnn.nature === "cap-exec")
            .map((ea) => ({
                capExec: ea.we,
                ann: ea.entryAnn as SpryCapExecEntryAnnotation,
                isExecutable: CapExecs.isExecutable(ea.we.entry.path),
            }));
    }

    protected async dropInEntryAnns(
        annotated: Set<{ root?: string; relPath: string; count: number }>,
    ) {
        const { spryDistAutoStores: { json: spryDistAutoJsonStore } } =
            this.stores;
        const entryAnns = await this.entryAnnotations(true);
        for (const a of entryAnns.valid) {
            const webPath = this.pp.webPaths.absolute(a.we.entry);
            await spryDistAutoJsonStore.write(
                join("entry", webPath + ".auto.json"),
                { ...a.entryAnn, webPath, ".source": a.ann.anns },
                // don't store absFsPath because it will be different across systems
                // making it harder to store in Git (because it will show diffs)
                omitPathsReplacer(a.entryAnn, [["absFsPath"]]),
            );
            annotated.add({
                root: a.we.origin.paths.identity,
                relPath: a.entryAnn.relFsPath,
                count: a.ann.found,
            });
        }
    }

    async routeAnnotations(lint = false) {
        type base = {
            we: Workflow["annsCatalog"][number]["walkEntry"];
            ann: Workflow["annsCatalog"][number]["routeAnn"];
        };
        const routeAnnsByPath = new Map<
            string,
            (base & {
                routeAnn: SpryRouteAnnotation;
            })
        >();
        const routeAnns: (base & {
            routeAnn: SpryRouteAnnotation;
        })[] = [];
        const issues: base[] = [];

        for (const a of this.annsCatalog) {
            if (a.routeAnn.found > 0 && a.routeAnn.parsed) {
                const store = {
                    we: a.walkEntry,
                    ann: a.routeAnn,
                    routeAnn: a.routeAnn.parsed,
                };
                routeAnns.push(store);
                routeAnnsByPath.set(store.routeAnn.path, store);
            } else if (a.routeAnn.found > 0) {
                if (lint) {
                    this.lintr.add({
                        rule: "invalid-annotation",
                        code: "route",
                        content: a.walkEntry.origin.paths.relative(
                            a.walkEntry.entry,
                        ),
                        message: "Invalid route annotation",
                        data: { annotation: a.routeAnn },
                        severity: "error",
                    });
                } else {
                    issues.push({ we: a.walkEntry, ann: a.routeAnn });
                }
            }
        }

        const routes = new Routes(routeAnns.map((ra) => ra.routeAnn));
        return {
            valid: routeAnns,
            issues,
            ...(await routes.populate()),
        };
    }

    protected async dropInRouteAnns(
        annotated: Set<{ root?: string; relPath: string; count: number }>,
    ) {
        const routeAnns = await this.routeAnnotations(true);
        const { spryDistAutoStores: { json: spryDistAutoJsonStore } } =
            this.stores;
        for (const a of routeAnns.valid) {
            await spryDistAutoJsonStore.write(
                join("route", a.routeAnn.path + ".auto.json"),
                { ...a.routeAnn, ".source": a.ann.anns },
            );
            annotated.add({
                root: a.we.origin.paths.identity,
                relPath: a.routeAnn.path,
                count: a.ann.found,
            });
        }

        const routes = new Routes(routeAnns.valid.map((ra) => ra.routeAnn));
        const { serializers, breadcrumbs, forest, edges } = await routes
            .populate();

        await spryDistAutoJsonStore.write(
            join("route", "forest.auto.json"),
            forest,
        );
        await spryDistAutoJsonStore.write(
            join("route", "edges.auto.json"),
            edges,
        );

        this.orchMD.h2("Routes Tree");
        this.orchMD.code("ascii", serializers.asciiTreeText());

        this.orchMD.h2("Breadcrumbs");
        for (const [path, node] of Object.entries(breadcrumbs)) {
            await spryDistAutoJsonStore.write(
                join("breadcrumbs", path + ".auto.json"),
                node,
            );
        }
        this.orchMD.table(
            ["Path", "Breadcrumbs"],
            Array.from(Object.entries(breadcrumbs)).map(([path, node]) => [
                path,
                node.map((bc) => bc.hrefs.index ?? bc.hrefs.trailingSlash).join(
                    "\n",
                ),
            ]),
        );

        return routeAnns;
    }

    async dropInAnnotations() {
        const annotated = new Set<
            { root?: string; relPath: string; count: number }
        >();

        await this.dropInEntryAnns(annotated);
        await this.dropInRouteAnns(annotated);

        this.orchMD.h2("Annotated Sources");
        this.orchMD.table(
            ["Path", "Count", "Root"],
            Array.from(annotated.values()).map((a) => [
                a.relPath,
                String(a.count),
                a.root ?? "",
            ]),
            ["left", "right", "left"],
        );
    }

    // deno-lint-ignore require-await
    async finalize() {
        for (const lr of this.lintr.allFindings()) {
            this.orchMD.section("Lint Results", (md) => {
                md.p(
                    `[\`${lr.rule}\`] \`${lr.code}\`: ${lr.message} in ${lr.content}`,
                );
                md.code("json", JSON.stringify(lr.data, null, 2));
            });
        }
        this.stores.spryDistAutoStores.polyglot.writeText(
            "orchestrated.auto.md",
            this.orchMD.write(),
        );
    }

    async capExecs() {
        const result = new CapExecs(this.pp.projectFsPaths, this.lintr, {
            cliOpts: this.cliOpts,
            mergeCtx: { cwd: Deno.cwd(), projectPaths: this.pp },
        });
        await result.catalog();
        return result;
    }

    async orchestrate(init: { cleanAuto?: boolean }) {
        const stores = this.stores;
        if (init?.cleanAuto) await this.plan.clean(stores);

        const capExecs = await this.capExecs();

        await capExecs.materialize("before-sqlpage-files");
        await this.dropInAnnotations();
        await capExecs.materialize("after-sqlpage-files");
        await this.finalize();
    }
}

export class SQL {
    constructor(readonly plan: Plan) {
    }

    get provenanceHint() {
        return provenanceText({
            importMetaURL: import.meta.url,
            framesToSkip: 2,
        });
    }

    async *headSqlSources() {
        const relativeToCWD = (path: string) => relative(Deno.cwd(), path);
        yield relativeToCWD(this.plan.pp.projectSrcFsPaths.absolute(
            join("spry", "lib", "sqlpage-files.ddl.sql"),
        ));
        yield relativeToCWD(this.plan.pp.projectSrcFsPaths.absolute(
            join("spry", "lib", "schema-info.dml.sql"),
        ));
    }

    async *tailSqlSources() {
        /** none so far */
    }

    async *headSQL() {
        yield `-- head SQL defined in ${this.provenanceHint} (begin)`;
        for await (const hss of this.headSqlSources()) {
            yield Deno.readTextFile(hss);
        }
        yield `-- head SQL defined in ${this.provenanceHint} (end)`;
    }

    async *seedInserts() {
        const { sqlpageFiles: sqlpageFilesTable } = sqliteModels();
        const spf = this.plan.sqlpageFiles();
        //type SqlPageFileRow = typeof sqlpageFilesTable.$inferInsert;

        // needed for drizzle-orm with @libsql/client because it doesn't generate SQL without it
        const db = drizzle({ connection: { url: ":memory:" } });
        for await (const f of spf.sources()) {
            const path = this.plan.pp.webPaths.absolute(f.entry);
            yield inlinedSQL(
                db.delete(sqlpageFilesTable).where(
                    eq(sqlpageFilesTable.path, path),
                ).toSQL(),
            );
            yield inlinedSQL(
                db.insert(sqlpageFilesTable).values({
                    path: path,
                    contents: await Deno.readTextFile(f.entry.path),
                }).toSQL(),
            );
        }
    }

    async *tailSQL() {
        yield `-- tail SQL defined in ${this.provenanceHint} (begin)`;
        for await (const tss of this.tailSqlSources()) {
            yield Deno.readTextFile(tss);
        }
        yield `-- tail SQL defined in ${this.provenanceHint} (end)`;
    }

    async *deploy() {
        const { sqlpageFiles } = sqliteModels();

        yield* this.headSQL();

        yield `-- ${getTableName(sqlpageFiles)} rows --`;
        yield* this.seedInserts();

        yield* this.tailSQL();
    }

    async toStdOut() {
        for await (const sql of this.deploy()) {
            console.log(sql);
        }
    }
}

export class Plan {
    constructor(readonly pp: ReturnType<typeof projectPaths>) {
    }

    linter() {
        return new Linter();
    }

    orchStore<Path extends string>() {
        return new Store<Path>(normalize(this.pp.projectFsPaths.root));
    }

    srcStore<Path extends string>() {
        return new Store<Path>(
            normalize(this.pp.projectSrcFsPaths.root),
        );
    }

    spryDropInStores<Path extends string>() {
        const polyglot = new Store<Path>(
            normalize(join(this.pp.projectSrcFsPaths.root, "spry.d")),
        );
        return {
            polyglot,
            json: new JsonStore(polyglot, undefined, { pretty: true }),
        };
    }

    spryDistAutoStores<Path extends string>() {
        const polyglot = new Store<Path>(
            normalize(join(this.pp.projectSrcFsPaths.root, "spry.d", "auto")),
        );
        return {
            polyglot,
            json: new JsonStore(polyglot, undefined, { pretty: true }),
        };
    }

    sqlpageFiles() {
        return new SqlPageFiles(this.pp.projectFsPaths, this.pp.webPaths);
    }

    annotations() {
        return new Annotations(this.pp.projectFsPaths, this.pp.webPaths);
    }

    stores() {
        const orchStore = this.orchStore();
        const srcStore = this.srcStore();
        const spryDropInStores = this.spryDropInStores();
        const spryDistAutoStores = this.spryDistAutoStores();
        return {
            spryDropInStores,
            spryDistAutoStores,
            orchStore,
            srcStore,
        };
    }

    async clean(stores = this.stores()) {
        const rmDirIfEmpty = async (path: string) => {
            try {
                if ((await Array.fromAsync(Deno.readDir(path))).length === 0) {
                    await Deno.remove(path);
                }
            } catch (error) {
                if (error instanceof Deno.errors.NotFound) { /**ignore */ }
            }
        };

        const rmDirRecursive = async (path: string) => {
            try {
                await Deno.remove(path, { recursive: true });
            } catch (error) {
                if (error instanceof Deno.errors.NotFound) { /**ignore */ }
            }
        };

        // we "own" the "spry.d/auto" directory so remove it
        await rmDirRecursive(stores.spryDistAutoStores.polyglot.destRoot);

        // if `auto` was the only directory in `spry.d`, remove that too
        rmDirIfEmpty(stores.spryDropInStores.polyglot.destRoot);
    }

    async workflow(cliOpts?: SafeCliArgs) {
        return await Workflow.build(this, cliOpts);
    }
}
