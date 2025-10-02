import { Command } from "jsr:@cliffy/command@1.0.0-rc.8";
import { HelpCommand } from "jsr:@cliffy/command@1.0.0-rc.8/help";
import { dirname, join, relative } from "jsr:@std/path@1";
import { CLI, Resource, SideAffects } from "../assembler/mod.ts";
import { SqlPageAssembler } from "./assembler.ts";
import { SqlSupplier } from "./sql.ts";

export class SqlPageCLI extends CLI<Resource, SqlPageAssembler<Resource>> {
  constructor(
    freshAssembler: (
      init: { sideAffectsAllowed: SideAffects; cleaningRequested?: boolean },
    ) => SqlPageAssembler<Resource>,
  ) {
    super(freshAssembler);
  }

  async init(init: { dbName: string; clean: boolean }) {
    const assembler = this.freshAssembler({
      sideAffectsAllowed: { materialize: false },
    });
    const { spryStd, sqlPage } = assembler.projectPaths();

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
      if (await exists(spryStd.fsHomeRelToProject)) {
        await Deno.remove(spryStd.fsHomeRelToProject);
        removed.push(spryStd.fsHomeRelToProject);
      }

      if (await exists(sqlPage.fsConfDirHome)) {
        await Deno.remove(sqlPage.fsConfDirHome, {
          recursive: true,
        });
        removed.push(relativeToCWD(sqlPage.fsConfDirHome));
      }
    }

    const created: string[] = [];
    const linked: { from: string; to: string }[] = [];

    if (!(await exists(sqlPage.fsConfDirHome))) {
      await Deno.mkdir(sqlPage.fsConfDirHome, { recursive: true });
      created.push(relativeToCWD(sqlPage.fsConfDirHome));
      const sqpConf = join(sqlPage.fsConfDirHome, "sqlpage.json");
      await Deno.writeTextFile(
        sqpConf,
        JSON.stringify(defaultSqlpageConf, null, 2),
      );
      created.push(relativeToCWD(sqpConf));
    }

    if (!(await exists(spryStd.fsHomeRelToProject))) {
      const spryStdLinkDest = dirname(spryStd.fsHomeRelToProject);
      if (!(await exists(spryStdLinkDest))) {
        await Deno.mkdir(spryStdLinkDest, { recursive: true });
        created.push(relativeToCWD(spryStdLinkDest));
      }
      await Deno.symlink(spryStd.fsHomeFromSymlink, spryStd.fsHomeRelToProject);
      linked.push({
        from: spryStd.fsHomeRelToProject,
        to: spryStd.fsHomeFromSymlink,
      });
    }

    return { spryStd, sqlPage, created, removed, linked };
  }

  /**
   * Assemble and yield all SQL statements from `spry/sql.d/head`,
   * `src/sql.d/head`, then the `sqlpage_files` table INSERT DML,
   * followed by `src/sql.d/tail` and finally `spry/sql.d/tail`.
   */
  async sql() {
    const assembler = this.freshAssembler({
      sideAffectsAllowed: { materialize: false },
    });
    const pp = assembler.projectPaths();
    await new SqlSupplier([{
      nature: "Head SQL Statements",
      rootPath: join(pp.spryStd.sqlDropIn.fsHeadHome),
      walkOptions: { includeDirs: false, canonicalize: true },
      emitWalkPathProvenance: true,
    }, {
      nature: "Head SQL Statements",
      rootPath: join(pp.projectSqlDropIn.fsHeadHome),
      walkOptions: { includeDirs: false, canonicalize: true },
      emitWalkPathProvenance: true,
    }, {
      nature: "sqlpage_files Table Candidates",
      rootPath: pp.projectSrcHome,
      "sqlpage_files Table path": (we) => {
        if (
          relative(pp.projectHome, we.path).startsWith(
            assembler.stdlibSymlinkDest,
          )
        ) {
          return relative(
            Deno.cwd(), // assume that CWD is the project home
            join("spry", relative(assembler.stdlibSymlinkDest, we.path)),
          );
        }
        return relative(pp.projectSrcHome, we.path);
      },
      walkOptions: {
        exts: [".sql", ".json"],
        includeDirs: false,
        includeFiles: true,
        includeSymlinks: false,
        followSymlinks: true, // important for "src/spry"
        canonicalize: true, // important for "src/spry"
      },
    }, {
      nature: "Tail SQL Statements",
      rootPath: join(pp.projectSqlDropIn.fsTailHome),
      walkOptions: { includeDirs: false, canonicalize: true },
      emitWalkPathProvenance: true,
    }, {
      nature: "Tail SQL Statements",
      rootPath: join(pp.spryStd.sqlDropIn.fsTailHome),
      walkOptions: { includeDirs: false, canonicalize: true },
      emitWalkPathProvenance: true,
    }]).toStdOut();
  }

  cli(init?: { name?: string }) {
    return new Command()
      .name(init?.name ?? "spryctl.ts")
      .version("0.1.0")
      .description(
        "Orchestrate the content which will be supplied to SQLPage target database.",
      )
      .command("help", new HelpCommand().global())
      .command("init")
      .description("Setup local dev environment")
      .option("--db-name <file>", "name of SQLite database", {
        default: "sqlpage.db",
      })
      .option("--clean", "Remove existing and recreate", {
        default: false,
      })
      .action(async (opts) => {
        const { created, removed, linked } = await this.init(opts);
        removed.forEach((r) => console.warn(`❌ Removed ${r}`));
        created.forEach((c) => console.info(`📄 Created ${c}`));
        linked.forEach((l) => console.info("🔗 Linked", l.from, "to", l.to));
      })
      .command("clean")
      .description("Clean auto-generated directories or files")
      .action(async () => {
        const assembler = this.freshAssembler({
          sideAffectsAllowed: { materialize: false },
          cleaningRequested: true,
        });
        const task = assembler.cleaner();
        await task.clean(assembler);
      })
      .command("ls", "List files consumed or impacted during the build.")
      .option("-k, --known", "Show only known resources, hide 'unknown'")
      .option("-l, --long", "Longer listing")
      .option("-t, --tree", "Simple tree of annotated routes")
      .option("-g, --auto", "Filter auto-generated files")
      .option(
        "-r, --routes",
        "Show only resources which have @route annotations",
      )
      .action(async (opts) => await this.ls(opts))
      .command("foundry", "Observe foundry details")
      .option(
        "-e, --env",
        "Show the environment variables that foundries can use",
      )
      .action(async (opts) => await this.foundry(opts))
      .command(
        "sql",
        "Collect and emit the SQL files to STDOUT or save to file",
      )
      .action(async () => await this.sql());
  }
}
