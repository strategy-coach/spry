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
import { pathTree } from "../../universal/path-tree.ts";
import { annotatedContent, SpryRouteAnnotation } from "./content.ts";
import { relative } from "node:path";

export function CLI(
  prefs: Omit<Parameters<typeof walkRoots>[0], "ctx"> & {
    sqlpageFilesPath?: (path: string) => string;
    init?: {
      sources: AsyncIterable<WalkRoot> | Iterable<WalkRoot>;
      emitContent: (src: Readonly<Encountered>) => string | Promise<string>;
    };
  },
) {
  const { sqlpageFilesPath = (path) => path } = prefs;
  const walkContext = <Context>(ctx?: Context) => ({
    ...prefs,
    ctx: ctx ? ctx : {},
  });

  function transformRoute(sra: SpryRouteAnnotation) {
    const result = {
      ...sra,
      namespace: sra.namespace == "_" ? "spry" : sra.namespace,
      path: `/${sqlpageFilesPath(sra.path)}`,
    };
    return result;
  }

  async function init(opts?: { paths?: boolean }) {
    if (!prefs.init?.sources) return;

    // -----------------------------
    // Ingest init walkRoots (async/sync)
    // -----------------------------
    const it =
      (prefs.init.sources as AsyncIterable<WalkRoot>)[Symbol.asyncIterator]
        ? (prefs.init.sources as AsyncIterable<WalkRoot>)
        : (async function* () {
          for (const x of prefs.init!.sources as Iterable<WalkRoot>) yield x;
        })();
    await walkRoots(
      { ctx: {}, roots: await Array.fromAsync(it) },
      async (_, enc) => {
        if (opts?.paths) {
          console.log(relative(enc.root.baseDir, enc.path));
        } else {
          console.log(await prefs.init?.emitContent(enc));
        }
      },
    );
  }

  async function ls() {
    const table = new Table({ head: ["", "Nature", "Path", "Ann Error"] });
    await walkRoots(
      walkContext({ table }),
      async (_, enc) => {
        const { entry, isEntryAnnotated } = await annotatedContent(enc, {
          transformRoute,
        });
        table.push([
          isEntryAnnotated ? "📝" : dim("❔"),
          dim(entry?.success ? entry.data.nature : "unknown"),
          sqlpageFilesPath(enc.relPath),
          entry?.error ? z.prettifyError(entry.error) : "",
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
        const { isRouteAnnotated, route } = await annotatedContent(enc, {
          transformRoute,
        });
        if (isRouteAnnotated && route?.data) {
          routes.push(route.data);
        }
      },
    );

    return await pathTree<SpryRouteAnnotation, string>(routes, {
      nodePath: (n) => n.path,
      pathDelim: "/",
      synthesizeContainers: true,
      folderFirst: false,
      indexBasenames: ["index.sql"],
    });
  }

  async function routes(opts?: { table?: boolean; json?: boolean }) {
    const rt = await routesTree();
    const forest = rt.tree();
    const rows = rt.tabular(forest);

    if (opts?.table) {
      const table = new Table({
        head: ["Name", "Breadcrumb Path", "Path", "Caption", "Container Path"],
      });
      for (const r of rows) {
        table.push([
          r.name,
          r.breadcrumbPath ?? "",
          r.path,
          r.payload?.caption,
          r.containerIndexPath ?? "",
        ]);
      }
      console.log(table.toString());
    } else if (opts?.json) {
      const breadcrumbs: Record<string, ReturnType<typeof rt.ancestry>> = {};
      for (const node of rows) {
        if (node.payload) {
          breadcrumbs[node.payload.path] = rt.ancestry(node.payload);
        }
      }
      console.log(
        JSON.stringify({ forest, tabular: rows, breadcrumbs }, null, "  "),
      );
    } else {
      console.log(
        rt.toString(forest, { showPath: true, includeCounts: true }),
      );
    }
  }

  async function crumbs() {
    const rt = await routesTree();
    const forest = rt.tree();

    const rows = rt.tabular(forest);
    const table = new Table({ head: ["Path", "Breadcrumbs"] });
    for (const node of rows) {
      const crumbs = rt.ancestry(node.payload!);
      table.push([
        node.name,
        crumbs.map((bc) => bc.path).join("\n"),
      ]);
    }
    console.log(table.toString());
  }

  async function emitSqlPageFiles() {
    // needed for drizzle-orm with @libsql/client because it doesn't generate SQL without it
    const db = drizzle({ connection: { url: ":memory:" } });
    const { sqlpageFiles: spf } = sqliteModels();
    await walkRoots(
      walkContext(),
      async (_, enc) => {
        const canonicalPath = sqlpageFilesPath(enc.relPath);
        const { content, entry, route, isEntryAnnotated, isRouteAnnotated } =
          await annotatedContent(enc, {
            transformRoute,
          });
        console.log(
          inlinedSQL(
            db.delete(spf).where(eq(spf.path, canonicalPath)).toSQL(),
          ),
        );
        console.log(
          inlinedSQL(
            db.insert(spf).values({
              path: canonicalPath,
              contents: content,
              nature: entry?.success ? entry.data.nature : "page",
              annotations: JSON.stringify(
                {
                  isEntryAnnotated,
                  isRouteAnnotated,
                  entry: entry
                    ? (entry.success ? entry.data : { error: entry.error })
                    : null,
                  route: route
                    ? (route.success ? route.data : { error: route.error })
                    : null,
                },
                null,
                "  ",
              ),
            }).toSQL(),
          ),
        );
      },
    );
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
          "init",
          new Command()
            .description("List the initialization files.")
            .action(async () => await init({ paths: true })),
        )
        .command(
          "routes",
          new Command()
            .description(
              "List SQLPage .sql files that include route annotations.",
            )
            .option("-j, --json", "Emit as JSON instead of tree")
            .option("-t, --table", "Display as table instead of tree.")
            .action(routes),
        )
        .command(
          "breadcrumbs",
          new Command()
            .description(
              "List SQLPage .sql files that include route annotations and their breadcrumbs.",
            )
            .action(crumbs),
        ),
    )
    .command(
      "sql",
      new Command()
        .description("Process files and emit SQL.")
        .command(
          "init",
          new Command()
            .description("Emit initialization SQL (DDL, DML).")
            .action(async () => await init()),
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
    init,
    ls,
    routes,
    emitSqlPageFiles,
    crumbs,
  };
}
