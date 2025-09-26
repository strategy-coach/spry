import { join, normalize, relative } from "jsr:@std/path@1";
import { eq, getTableName, sql } from "npm:drizzle-orm@0.44.5";
import { drizzle } from "npm:drizzle-orm@0.44.5/libsql";
import {
    check,
    SQLiteColumn,
    sqliteTable,
    text,
} from "npm:drizzle-orm@0.44.5/sqlite-core";
import { MarkdownStore } from "../universal/markdown.ts";
import { provenanceText } from "../universal/reflect/provenance.ts";
import {
    inlinedSQL,
    literal as literalSQL,
    SQL,
} from "../universal/sql-text.ts";
import { Annotations } from "./annotations.ts";
import { Foundries } from "./foundries.ts";
import { SafeCliArgs } from "./cli.ts";
import { Linter } from "./lint.ts";
import { FsPathSupplier, PathSupplier, projectPaths } from "./paths.ts";
import { JsonStore, Store } from "./storage.ts";
import { EncountersSupplier, Walkers } from "./walk.ts";
import { Directives } from "./directives.ts";
import { Routes, SpryRouteAnnotation } from "./anno/mod.ts";

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

export class SqlPageFilesTableInsertables {
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

export const DEFAULT_VARS = {
    spry_home: { descr: "Spry standard library content SQLPage web path" },
    spryd_home: { descr: "Spry Drop-in content SQLPage home web path" },
    spryd_auto_home: {
        descr: "Spry Drop-in auto-generated content SQLPage home web path",
    },
    spryd_entries_home: {
        descr:
            "Spry Drop-in auto-generated entries annotation relaated SQLPage home web path",
    },
    spryd_entries_catalog_json_path: {
        descr:
            "Spry Drop-in auto-generated entries catalog JSON SQLPage web path",
    },
    spryd_entries_catalog_json: {
        descr: "Spry Drop-in auto-generated entries catalog JSON content",
    },
    spryd_routes_home: {
        descr:
            "Spry Drop-in auto-generated routes, forests annotation relaated SQLPage home web path",
    },
} as const satisfies Record<string, { readonly descr: string }>;

export class SqlPageGovernance<
    V extends Record<string, { readonly descr: string }>,
    Name extends keyof V & string = keyof V & string,
> {
    readonly variables = new Map<Name, string>();

    constructor(readonly varsDefn: V) {
    }

    assignSQL(name: Name, sql: string | SQL) {
        this.variables.set(
            name,
            typeof sql === "string" ? sql : sql.toString(),
        );

        // chainable
        return this;
    }

    assignLiteral(name: Name, text: string) {
        return this.assignSQL(name, literalSQL(text));
    }

    async *sqlPageStatements() {
        for (const [name, sql] of this.variables.entries()) {
            yield `\n-- ${this.varsDefn[name].descr}`;
            yield `SET ${name} = ${sql};`;
        }
    }
}

export class Workflow {
    #workflowStep:
        | "INIT"
        | "BEFORE_ANN_CATALOG"
        | "AFTER_ANN_CATALOG"
        | "DESTROY_CLEAN";

    readonly linter: Linter;
    readonly lintr: ReturnType<Linter["lintResults"]>;
    readonly stores: ReturnType<Plan["stores"]>;
    readonly directives: ReturnType<Plan["directives"]>;
    readonly pp: Plan["pp"];
    readonly spf: ReturnType<Plan["sqlpageFiles"]>;
    readonly annotations: ReturnType<Plan["annotations"]>;
    readonly spGovn = new SqlPageGovernance(DEFAULT_VARS);

    #annsCatalog?: YieldOf<
        ReturnType<Plan["annotations"]>["catalog"]
    >[];

    readonly mdStore = new MarkdownStore<"orchestrated.auto.md">();
    readonly orchMD = this.mdStore.markdown("orchestrated.auto.md");

    protected constructor(
        readonly plan: Plan,
        readonly cliOpts?: SafeCliArgs,
    ) {
        this.#workflowStep = "INIT";
        this.pp = plan.pp;
        this.linter = plan.linter();
        this.lintr = this.linter.lintResults();
        this.stores = plan.stores();
        this.directives = plan.directives();
        this.spf = plan.sqlpageFiles();
        this.annotations = plan.annotations();

        this.spGovn.assignLiteral(
            "spry_home",
            this.stores.srcStore.webPath("spry"),
        ).assignLiteral(
            "spryd_home",
            this.stores.srcStore.webPath("spry.d"),
        ).assignLiteral(
            "spryd_auto_home",
            this.stores.spryDropInStores.polyglot.webPath("auto"),
        );
    }

    static async build(plan: Plan, cliOpts?: SafeCliArgs) {
        return await new Workflow(plan, cliOpts).init();
    }

    get workflowStep() {
        return this.#workflowStep;
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

    protected async dropInEntryAnns(
        annotated: Set<{ relPath: string; count: number }>,
    ) {
        function* validEntryAnns(annsCatalog: YieldOf<
            ReturnType<Plan["annotations"]>["catalog"]
        >[]) {
            for (const a of annsCatalog) {
                if (
                    a.entryAnn.parsed == undefined || a.entryAnn.parsed == null
                ) continue;
                yield {
                    ...a.entryAnn.parsed,
                    webPath: a.entryAnn.parsed.webPath,
                    relFsPath: a.entryAnn.parsed.relFsPath,
                    ...(a.routeAnn.found > 0 && a.routeAnn.parsed
                        ? { route: a.routeAnn.parsed }
                        : {}),
                    ".provenance": {
                        entry: {
                            anns: a.entryAnn.anns,
                            found: a.entryAnn.found,
                            error: a.entryAnn.error,
                        },
                        ...(a.routeAnn.found > 0
                            ? {
                                route: {
                                    anns: a.routeAnn.anns,
                                    found: a.routeAnn.found,
                                    error: a.routeAnn.error,
                                },
                            }
                            : {}),
                    },
                };
            }
        }

        // don't store absFsPath because it will be different across systems
        // making it harder to store in Git (because it will show diffs)
        const omitNonIdempotent = (k: unknown, v: unknown) =>
            k === "absFsPath" || k === "origin" ? undefined : v;

        const { spryDistAutoStores: { json: spryDistAutoJsonStore } } =
            this.stores;

        const entryAnns = await Array.fromAsync(
            validEntryAnns(this.annsCatalog),
        );
        for await (const a of entryAnns) {
            if (a.webPath) {
                await spryDistAutoJsonStore.write(
                    join("entry", a.webPath + ".auto.json"),
                    a,
                    omitNonIdempotent,
                );
                annotated.add({
                    relPath: a.relFsPath,
                    count: a[".provenance"].entry.found,
                });
            }
        }

        this.spGovn.assignLiteral(
            "spryd_entries_home",
            this.stores.spryDistAutoStores.polyglot.webPath("entry"),
        );

        const { webPath: entriesJsonPath } = await spryDistAutoJsonStore.write(
            join("entry", "entries.auto.json"),
            entryAnns,
            omitNonIdempotent,
        );
        this.spGovn.assignLiteral(
            "spryd_entries_catalog_json_path",
            entriesJsonPath,
        );
        this.spGovn.assignSQL(
            "spryd_entries_catalog_json",
            `sqlpage.read_file_as_text('${entriesJsonPath}')`,
        );
    }

    async routeAnnotations() {
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
                issues.push({ we: a.walkEntry, ann: a.routeAnn });
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
        const routeAnns = await this.routeAnnotations();
        const { spryDistAutoStores: { json: spryDistAutoJsonStore } } =
            this.stores;
        for (const a of routeAnns.valid) {
            await spryDistAutoJsonStore.write(
                join("route", a.routeAnn.path + ".auto.json"),
                { ...a.routeAnn, ".provenance": a.ann.anns },
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

        await this.stores.spryDistAutoStores.polyglot.writeText(
            "README.md",
            spryDistAutoReadme(this.plan).write(),
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

    async finalize() {
        await this.annotations.lint(this.annsCatalog, this.lintr);
        const lintResults = this.lintr.allFindings();
        for (const lr of lintResults) {
            this.orchMD.section("Lint Results", (md) => {
                md.p(
                    `[\`${lr.rule}\`] \`${lr.code}\`: ${lr.message} in ${lr.content}`,
                );
                md.code("json", JSON.stringify(lr.data, null, 2));
            });
        }

        await this.stores.spryDistAutoStores.json.write(
            "lint-results.auto.json",
            lintResults,
        );

        await this.stores.spryDistAutoStores.polyglot.writeText(
            "orchestrated.auto.md",
            this.orchMD.write(),
        );

        await this.stores.spryDistAutoStores.polyglot.writeText(
            "goverance.auto.sql",
            (await Array.fromAsync(this.spGovn.sqlPageStatements())).join("\n"),
        );
    }

    async materializeDirectives() {
        for await (const d of this.directives.materialize(this.lintr)) {
            console.log("Materialized", d.we.entry.path);
        }
    }

    async foundries() {
        const result = new Foundries(this.plan, this.lintr, {
            cliOpts: this.cliOpts,
            mergeCtx: { cwd: Deno.cwd(), projectPaths: this.pp },
        });
        await result.catalog();
        return result;
    }

    async orchestrate(init: { cleanAuto?: boolean }) {
        const stores = this.stores;
        if (init?.cleanAuto) await this.plan.clean(stores);

        await this.materializeDirectives();
        const execs = await this.foundries();

        await execs.materialize("BEFORE_ANN_CATALOG");
        await this.dropInAnnotations();
        await execs.materialize("AFTER_ANN_CATALOG");
        await this.finalize();
    }
}

export class DeploySQL {
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
            this.pp.spryDropIn.fsHome,
            this.pp.spryDropIn.webHome,
        );
        return {
            polyglot,
            json: new JsonStore(polyglot, undefined, { pretty: true }),
        };
    }

    spryDistAutoStores<Path extends string>() {
        const polyglot = new Store<Path>(
            this.pp.spryDropIn.fsAuto,
            this.pp.spryDropIn.webAuto,
        );
        return {
            polyglot,
            json: new JsonStore(polyglot, undefined, { pretty: true }),
        };
    }

    sqlpageFiles() {
        return new SqlPageFilesTableInsertables(
            this.pp.projectFsPaths,
            this.pp.webPaths,
        );
    }

    directives() {
        return new Directives(this);
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
        await rmDirRecursive(stores.spryDistAutoStores.polyglot.destFsRoot);

        // handle cleanable foundries
        const workflow = await this.workflow();
        const foundries = await workflow.foundries();
        for (
            const ce of foundries.ceSelected.filter((ce) =>
                ce.pfn.materialize.auto && ce.ann.isCleanable &&
                ce.pfn.materialize.path
            )
        ) {
            try {
                // if ce.pfn.materialize.auto is true then .path! must be set
                await Deno.remove(ce.pfn.materialize.path!);
            } catch (error) {
                if (error instanceof Deno.errors.NotFound) continue;
                console.info(
                    "Error cleaning isCleanable auto-materialized foundry",
                    ce.we.entry.path,
                );
                console.info(ce.pfn.materialize.path!);
                console.error(error);
            }
        }

        // if `auto` was the only directory in `spry.d`, remove that too
        await rmDirIfEmpty(stores.spryDropInStores.polyglot.destFsRoot);
    }

    async workflow(cliOpts?: SafeCliArgs) {
        return await Workflow.build(this, cliOpts);
    }
}

const spryDistDocs = new MarkdownStore<"README.md">();

// deno-fmt-ignore
const spryDistAutoReadme = (_plan: Plan) => {
    const md = spryDistDocs.markdown("README.md");
    md.h1("Spry Dropin Annotations and Routes");
    md.pTag`After annotations are parsed and validated, Spry generates the following in \`spry.d/auto\`:`;
    md.li("`breadcrumbs/` directory contains computed \"breadcrumbs\" for each node in `forest.auto.json`.")
    md.li("`entry/` directory contains parsed `@spry.*` annotation for each route / endpoint individually.")
    md.li("[`entry/entries.auto.json`](entry/entries.auto.json) is a single JSON array of all annotated `@spry.*` entries")
    md.li("[`entry/issues.auto.md`](entry/issues.auto.json) is a single JSON array of all errors found in annotated `@spry.*` entries (will be an empty array if no issues found)")
    md.li("[`orchestrated.auto.md`](orchestrated.auto.md) is a human-readable summary of orchestration (`build`) results.")
    md.li("`route/` directory contains route annotations JSON for each route / endpoint individually.")
    md.li("[`route/edges.auto.json`](route/edges.auto.json) contains route edges to conveniently build graph with `forest.auto.json`.")
    md.li("[`route/forest.auto.json`](route/forest.auto.json) contains complete route roots and descendants in a single JSON object.")
    md.p("");
    md.p("TODO:")
    md.li("need to store the JSON Schemas for each of the above as well (the code is written already)")
    return md;
};
