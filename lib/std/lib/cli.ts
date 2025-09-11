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
import {
  annotatableContent,
  spryResourceNature,
  SpryRouteAnnotation,
} from "./content.ts";
import { relative } from "node:path";

export function CLI(
  prefs: Omit<Parameters<typeof walkRoots>[0], "ctx"> & {
    readonly sqlpageFilesPath?: (path: string) => string;
    readonly sqlpageRoutePath?: (path: string) => string;
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
  const {
    sqlpageFilesPath = (path) => path,
    sqlpageRoutePath = (path) => `/${sqlpageFilesPath(path)}`,
  } = prefs;
  const walkContext = <Context>(ctx?: Context) => ({
    ...prefs,
    ctx: ctx ? ctx : {},
  });

  function transformRoute(sra: SpryRouteAnnotation) {
    const result = {
      ...sra,
      path: sqlpageRoutePath(sra.path),
    };
    return result;
  }

  async function head(opts?: { paths?: boolean }) {
    if (!prefs.head?.sources) return;

    // -----------------------------
    // Ingest init walkRoots (async/sync)
    // -----------------------------
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

    // -----------------------------
    // Ingest init walkRoots (async/sync)
    // -----------------------------
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
    type PathTreeNode = (typeof tree)[number];

    function nodeCrumbs(item: SpryRouteAnnotation): PathTreeNode[] {
      // Compute the *breadcrumb parent path* for a given path (grandparent's canonical)
      // Returns undefined when there is no grandparent.
      function breadcrumbParentPathOf(path: string) {
        const parentPath = forest.parentMap.get(path);
        if (!parentPath) return undefined; // no parent container → no grandparent

        const grandparentPath = forest.parentMap.get(parentPath);
        if (!grandparentPath) return undefined; // no grandparent

        const grandparentNode = forest.treeByPath.get(grandparentPath);
        if (!grandparentNode) return undefined; // defensive

        return forest.canonicalOf(grandparentNode);
      }

      const start = forest.itemToNodeMap.get(item);
      if (!start) return [];

      // Walk up via breadcrumb (grandparent canonical), collecting nodes
      const trail: PathTreeNode[] = [];
      let current: PathTreeNode | undefined = start;

      while (current) {
        trail.push(current);

        const nextPath = breadcrumbParentPathOf(current.path);
        if (!nextPath) break;

        const nextNode = forest.treeByPath.get(nextPath);
        if (!nextNode || nextNode === current) break; // defensive against loops
        current = nextNode;
      }

      return trail.reverse(); // root → … → target
    }

    const breadcrumbs: Record<string, ReturnType<typeof nodeCrumbs>> = {};
    for (const node of forest.treeByPath.values()) {
      if (node.payloads) {
        for (const p of node.payloads) {
          breadcrumbs[p.path] = nodeCrumbs(p);
        }
      }
    }

    return { forest, tree, nodeCrumbs, breadcrumbs };
  }

  async function routes(opts?: { json?: boolean }) {
    const { forest, tree, breadcrumbs } = await routesTree();

    if (opts?.json) {
      console.log(
        JSON.stringify({ roots: forest.roots, breadcrumbs }, null, "  "),
      );
    } else {
      console.log(
        forest.toString(tree, { showPath: true, includeCounts: true }),
      );
    }
  }

  async function crumbs() {
    const { breadcrumbs } = await routesTree();

    const table = new Table({ head: ["Path", "Breadcrumbs"] });
    for (const [path, node] of Object.entries(breadcrumbs)) {
      table.push([
        path,
        node.map((bc) => bc.path).join("\n"),
      ]);
    }
    console.log(table.toString());
  }

  async function emitSqlPageFiles() {
    // needed for drizzle-orm with @libsql/client because it doesn't generate SQL without it
    const db = drizzle({ connection: { url: ":memory:" } });
    const { sqlpageFiles: spf } = sqliteModels();
    const { forest, breadcrumbs } = await routesTree();
    await walkRoots(
      walkContext(),
      async (_, enc) => {
        const canonicalPath = sqlpageFilesPath(enc.relPath);
        const ac = await annotatableContent(enc, { transformRoute });
        console.log(
          inlinedSQL(db.delete(spf).where(eq(spf.path, canonicalPath)).toSQL()),
        );
        console.log(
          inlinedSQL(
            db.insert(spf).values({
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
            }).toSQL(),
          ),
        );
      },
    );

    const routesJsonContentPath = "spry/lib/routes.json";
    console.log(
      inlinedSQL(
        db.delete(spf).where(eq(spf.path, routesJsonContentPath)).toSQL(),
      ),
    );
    console.log(
      inlinedSQL(
        db.insert(spf).values({
          path: routesJsonContentPath,
          contents: JSON.stringify(
            { roots: forest.roots, paths: forest.treeByPath, breadcrumbs },
            (_, value) => {
              if (value instanceof Map) {
                return Array.from(value.entries()).reduce((obj, [key, val]) => {
                  // deno-lint-ignore no-explicit-any
                  ((obj as any)[key]) = val;
                  return obj;
                }, {});
              }
              return value;
            },
            "  ",
          ),
          nature: spryResourceNature,
        }).toSQL(),
      ),
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
            .action(async () => await head()),
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
