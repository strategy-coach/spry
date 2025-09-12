import { dirname } from "jsr:@std/path@1";
import { dim } from "jsr:@std/fmt@1/colors";
import { z } from "jsr:@zod/zod@^4.1.5";
import { Command } from "jsr:@cliffy/command@1.0.0-rc.8";
import { HelpCommand } from "jsr:@cliffy/command@1.0.0-rc.8/help";
import { drizzle } from "npm:drizzle-orm@0.44.5/libsql";
import { sqliteModels } from "./models.ts";
import { eq } from "npm:drizzle-orm@0.44.5";
import Table from "npm:cli-table3@0.6.5";
import { inlinedSQL } from "../../universal/sql-text.ts";
import { Encountered, WalkRoot, walkRoots } from "../../universal/walk-fs.ts";
import {
  pathTree,
  pathTreeNavigation,
  pathTreeSerializers,
} from "../../universal/path-tree.ts";
import {
  annotatableContent,
  spryResourceNature,
  SpryRouteAnnotation,
  spryRouteAnnSchema,
} from "./content.ts";
import { relative } from "node:path";

export function CLI(
  prefs: Omit<Parameters<typeof walkRoots>[0], "ctx"> & {
    readonly sqlpageFilesPath?: (path: string) => string;
    readonly sqlpageRoutePath?: (path: string) => string;
    readonly routesAutoJsonPath?: (
      basename: string,
      dirname?: string,
    ) => string;
    readonly head?: {
      sources: AsyncIterable<WalkRoot> | Iterable<WalkRoot>;
      emitContent: (src: Readonly<Encountered>) => string | Promise<string>;
    };
    readonly tail?: {
      sources: AsyncIterable<WalkRoot> | Iterable<WalkRoot>;
      emitContent: (src: Readonly<Encountered>) => string | Promise<string>;
    };
  },
) {
  const { sqlpageFiles: sqlpageFilesTable } = sqliteModels();
  const {
    sqlpageFilesPath = (path) => path,
    sqlpageRoutePath = (path) => `/${sqlpageFilesPath(path)}`,
    routesAutoJsonPath = (basename: string, dirname?: string) =>
      `${dirname ?? "spry/lib/route"}/${
        basename.indexOf(".") >= 0 ? basename : `${basename}.auto.json`
      }`,
  } = prefs;
  const walkContext = <Context>(ctx?: Context) => ({
    ...prefs,
    ctx: ctx ? ctx : {},
  });

  function transformRoute(sra: SpryRouteAnnotation) {
    const result = {
      ...sra,
      path: sqlpageRoutePath(sra.path),
      pathDirname: dirname(sqlpageRoutePath(sra.path)),
    };
    return result;
  }

  async function head(opts?: { paths?: boolean }) {
    if (!prefs.head?.sources) return;

    const it =
      (prefs.head.sources as AsyncIterable<WalkRoot>)[Symbol.asyncIterator]
        ? (prefs.head.sources as AsyncIterable<WalkRoot>)
        : (async function* () {
          for (const x of prefs.head!.sources as Iterable<WalkRoot>) yield x;
        })();
    await walkRoots(
      { ctx: {}, roots: await Array.fromAsync(it) },
      async (_, enc) => {
        if (opts?.paths) {
          console.log(relative(enc.root.baseDir, enc.path));
        } else {
          console.log(await prefs.head?.emitContent(enc));
        }
      },
    );
  }

  async function tail(opts?: { paths?: boolean }) {
    if (!prefs.tail?.sources) return;

    const it =
      (prefs.tail.sources as AsyncIterable<WalkRoot>)[Symbol.asyncIterator]
        ? (prefs.tail.sources as AsyncIterable<WalkRoot>)
        : (async function* () {
          for (const x of prefs.tail!.sources as Iterable<WalkRoot>) yield x;
        })();
    await walkRoots(
      { ctx: {}, roots: await Array.fromAsync(it) },
      async (_, enc) => {
        if (opts?.paths) {
          console.log(relative(enc.root.baseDir, enc.path));
        } else {
          console.log(await prefs.tail?.emitContent(enc));
        }
      },
    );
  }

  async function ls() {
    const table = new Table({ head: ["", "Nature", "Path", "Ann Error"] });
    await walkRoots(
      walkContext({ table }),
      async (_, enc) => {
        const { entryAnn, isEntryAnnotated } = await annotatableContent(enc, {
          transformRoute,
        });
        table.push([
          isEntryAnnotated ? "📝" : dim("❔"),
          dim(entryAnn?.success ? entryAnn.data.nature : "unknown"),
          sqlpageFilesPath(enc.relPath),
          entryAnn?.error ? z.prettifyError(entryAnn.error) : "",
        ]);
      },
    );
    console.log(table.toString());
  }

  async function routesTree() {
    const routes: SpryRouteAnnotation[] = [];
    await walkRoots(
      walkContext({ routes }),
      async (_, enc) => {
        const { isRouteAnnotated, routeAnn } = await annotatableContent(enc, {
          transformRoute,
        });
        if (isRouteAnnotated && routeAnn?.data) {
          routes.push(routeAnn.data);
        }
      },
    );

    const forest = await pathTree<SpryRouteAnnotation, string>(routes, {
      nodePath: (n) => n.path,
      pathDelim: "/",
      synthesizeContainers: true,
      folderFirst: false,
      indexBasenames: ["index.sql"],
    });

    const tree = forest.roots;
    const nav = pathTreeNavigation(forest);
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

    return { forest, tree, breadcrumbs, serializers };
  }

  async function routes(opts?: { json?: boolean }) {
    const { serializers } = await routesTree();

    if (opts?.json) {
      console.log(serializers.jsonText({ space: 2 }));
    } else {
      console.log(
        serializers.asciiTreeText({ showPath: true, includeCounts: true }),
      );
    }
  }

  async function crumbs(opts: { json?: boolean }) {
    const { breadcrumbs } = await routesTree();

    if (opts.json) {
      console.dir(breadcrumbs);
      return;
    }

    const table = new Table({ head: ["Path", "Breadcrumbs"] });
    for (const [path, node] of Object.entries(breadcrumbs)) {
      table.push([
        path,
        node.map((bc) => bc.hrefs.index ?? bc.hrefs.trailingSlash).join("\n"),
      ]);
    }
    console.log(table.toString());
  }

  async function* prepareSqlPageFiles() {
    const walked: typeof sqlpageFilesTable.$inferInsert[] = [];
    await walkRoots(
      walkContext(),
      async (_, enc) => {
        const canonicalPath = sqlpageFilesPath(enc.relPath);
        const ac = await annotatableContent(enc, { transformRoute });
        walked.push({
          path: canonicalPath,
          contents: ac.content,
          nature: ac.entryAnn?.success ? ac.entryAnn.data.nature : "page",
          annotations: JSON.stringify(
            {
              isEntryAnnotated: ac.isEntryAnnotated,
              isRouteAnnotated: ac.isRouteAnnotated,
              entry: ac.entryAnn
                ? (ac.entryAnn.success
                  ? ac.entryAnn.data
                  : { error: ac.entryAnn.error })
                : null,
              route: ac.routeAnn
                ? (ac.routeAnn.success
                  ? ac.routeAnn.data
                  : { error: ac.routeAnn.error })
                : null,
            },
            null,
            "  ",
          ),
        });
      },
    );

    for (const w of walked) {
      yield w;
    }

    const { serializers, breadcrumbs } = await routesTree();

    yield {
      path: routesAutoJsonPath("spry", "spry/lib/route/forests.d"),
      contents: serializers.jsonText({ space: 2 }),
      nature: spryResourceNature,
    };

    yield {
      path: routesAutoJsonPath("forests.schema.json", "spry/lib/governance"),
      contents: serializers.jsonSchemaText({
        payloadItemSchema: z.toJSONSchema(spryRouteAnnSchema),
      }),
      nature: spryResourceNature,
    };

    yield {
      path: routesAutoJsonPath("spry", "spry/lib/route/breadcrumbs.d"),
      contents: JSON.stringify(breadcrumbs, null, 2),
      nature: spryResourceNature,
    };

    yield {
      path: routesAutoJsonPath(
        "breadcrumbs.schema.json",
        "spry/lib/governance",
      ),
      contents: serializers.crumbsJsonSchemaText(),
      nature: spryResourceNature,
    };
  }

  async function emitSqlPageFiles() {
    // needed for drizzle-orm with @libsql/client because it doesn't generate SQL without it
    const db = drizzle({ connection: { url: ":memory:" } });
    for await (const spf of prepareSqlPageFiles()) {
      console.log(
        inlinedSQL(
          db.delete(sqlpageFilesTable).where(
            eq(sqlpageFilesTable.path, spf.path),
          ).toSQL(),
        ),
      );
      console.log(
        inlinedSQL(db.insert(sqlpageFilesTable).values(spf).toSQL()),
      );
    }
  }

  const command = new Command()
    .name("spryctl")
    .description("Walk roots and process files with include/exclude globs.")
    .example(
      "list SQLPage .sql files excluding migrations",
      `./spryctl.ts ls`,
    )
    .example(
      "populate sqlpage_files rows",
      `./spryctl.ts sql sqlpage-files | sqlite3 sqlpage.db`,
    )
    .action(ls)
    .command("help", new HelpCommand().global())
    .command(
      "ls",
      new Command()
        .description("List SQLPage .sql files excluding migrations.")
        .action(ls)
        .command(
          "head",
          new Command()
            .description("List the header (initialization) files.")
            .action(async () => await head({ paths: true })),
        )
        .command(
          "tail",
          new Command()
            .description("List the tail (finalization) files.")
            .action(async () => await tail({ paths: true })),
        )
        .command(
          "routes",
          new Command()
            .description(
              "List SQLPage .sql files that include route annotations.",
            )
            .option("-j, --json", "Emit as JSON instead of tree")
            .action(routes),
        )
        .command(
          "breadcrumbs",
          new Command()
            .description(
              "List SQLPage .sql files that include route annotations and their breadcrumbs.",
            )
            .option("-j, --json", "dump the entire breadcrumbs object as JSON")
            .action(crumbs),
        ),
    )
    .command(
      "sql",
      new Command()
        .description("Process files and emit SQL.")
        .command(
          "head",
          new Command()
            .description("Emit initialization (header) SQL (DDL, DML).")
            .action(async () => await head()),
        )
        .command(
          "tail",
          new Command()
            .description("Emit finalization (tail) SQL (DDL, DML).")
            .action(async () => await tail()),
        )
        .command(
          "sqlpage-files",
          new Command()
            .description("Emit sqlplage_files content SQL.")
            .action(emitSqlPageFiles),
        ),
    );

  return {
    command,
    walkContext,
    head,
    tail,
    ls,
    routes,
    emitSqlPageFiles,
    crumbs,
  };
}
