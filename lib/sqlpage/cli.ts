import { Command } from "jsr:@cliffy/command@1.0.0-rc.8";
import { HelpCommand } from "jsr:@cliffy/command@1.0.0-rc.8/help";
import { dirname, join, relative } from "jsr:@std/path@1";
import { CLI, Resource } from "../assembler/mod.ts";
import { SqlPageAssembler } from "./assembler.ts";
import { SqlSupplier } from "./sql.ts";

export class SqlPageCLI extends CLI<Resource, SqlPageAssembler<Resource>> {
  constructor(
    freshAssembler: (
      init: { dryRun: boolean; cleaningRequested: boolean },
    ) => SqlPageAssembler<Resource>,
  ) {
    super(freshAssembler);
  }

  async init(init: { dbName: string; clean: boolean }) {
    const assembler = this.freshAssembler({
      dryRun: true,
      cleaningRequested: false,
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
      const spryStdLinkDest = dirname(spryStd.relPathToHome);
      if (!(await exists(spryStdLinkDest))) {
        await Deno.mkdir(spryStdLinkDest, { recursive: true });
        created.push(relativeToCWD(spryStdLinkDest));
      }
      await Deno.symlink(spryStd.homeFromSymlink, spryStd.relPathToHome);
      linked.push({
        from: spryStd.relPathToHome,
        to: spryStd.homeFromSymlink,
      });
    }

    return { spryStd, sqlPage, created, removed, linked };
  }

  async sql() {
    const assembler = this.freshAssembler({
      dryRun: true,
      cleaningRequested: true,
    });
    const pp = assembler.projectPaths();
    await new SqlSupplier([{
      nature: "Head SQL Statements",
      rootPath: join(pp.spryStd.absPathToLocal, "sql.d", "head"),
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
      rootPath: join(pp.spryStd.absPathToLocal, "sql.d", "tail"),
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
          dryRun: true,
          cleaningRequested: true,
        });
        const task = assembler.cleaner();
        await task.clean(assembler);
      })
      .command("ls", "List files consumed or impacted during the build.")
      .option("-k, --known", "Show only known resources, hide 'unknown'")
      .option("-l, --long", "Longer listing")
      .option("-t, --tree", "Simple tree of annotated routes")
      .option(
        "-r, --routes",
        "Show only resources which have @route annotations",
      )
      .action(async (opts) => await this.ls(opts))
      .command(
        "sql",
        "Collect and emit the SQL files to STDOUT or save to file",
      )
      .action(async () => await this.sql());
  }
}
