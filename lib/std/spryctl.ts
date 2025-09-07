#!/usr/bin/env -S deno run --allow-run --allow-env --allow-net --allow-read --allow-write

import { debounce } from "https://deno.land/std@0.224.0/async/debounce.ts";
import {
  brightGreen,
  brightRed,
  brightWhite,
  brightYellow,
  cyan,
  dim,
  green,
  red,
} from "https://deno.land/std@0.224.0/fmt/colors.ts";
import {
  fromFileUrl,
  isAbsolute,
  join,
  relative,
} from "https://deno.land/std@0.224.0/path/mod.ts";
import { Command } from "https://deno.land/x/cliffy@v1.0.0-rc.4/command/mod.ts";
import { spawnedResult } from "../universal/spawn.ts";

let globalEventCount = 0;
const fileSizeMB = async (file: string) =>
  (await Deno.stat(file)).size / (1024 * 1024);

/**
 * Executes SQL scripts from a given file on an SQLite database. The file can be
 * a plain SQL file or an executable file. For executables, STDOUT provides the
 * SQL script.
 *
 * @param modifiedFile - The path to the file containing the SQL script.
 * @param stateDbFsPath - The path to the SQLite database file.
 */
async function spawnedSqlite3(
  cmd: string,
  stateDbFsPath: string,
  modifiedFile: string,
) {
  let sqlScriptSrc = relative(".", modifiedFile);
  let sqlScript: string | null = "";

  const stat = Deno.lstatSync(modifiedFile);
  if (!modifiedFile.endsWith(".sql") && stat.mode && (stat.mode & 0o111)) {
    const execFileResult = await spawnedResult([modifiedFile]);
    const error = execFileResult.stderr();
    sqlScript = execFileResult.stdout();
    if (execFileResult.code != 0 || error.length || !sqlScript) {
      // deno-fmt-ignore
      console.log("❌", brightRed(`Error generating SQL from ${sqlScriptSrc} [${execFileResult.code}] {${globalEventCount}}`));
      console.error(brightRed(error));
      return false; // Exit if there was an error or no script was found
    }
    // deno-fmt-ignore
    console.log(dim(`⌛ Generating SQL from ${sqlScriptSrc} {${globalEventCount}}`));
    sqlScriptSrc = `(executed ${sqlScriptSrc} [${execFileResult.code}])`;
  } else {
    // For .sql files, read the contents directly
    sqlScript = await Deno.readTextFile(modifiedFile);
  }

  const spawned = [cmd, stateDbFsPath];
  const sr = await spawnedResult(spawned, undefined, sqlScript);

  if (sr.success) {
    // deno-fmt-ignore
    console.log(`✅`, brightGreen(`cat ${sqlScriptSrc} | ${sr.command.join(" ")}`), green(`[sr: ${sr.code}, ${await fileSizeMB(stateDbFsPath)}mb] {${globalEventCount}}`));
  } else {
    // deno-fmt-ignore
    console.log(`❌`, brightRed(`cat ${sqlScriptSrc} | ${sr.command.join(" ")}`), red(`[sr: ${sr.code}, ${await fileSizeMB(stateDbFsPath)}mb] {${globalEventCount}}`));

    // if you change the name of this file, update watchFiles(...) call and gitignore
    const errorSqlScriptFName = `ERROR-${crypto.randomUUID()}.sql`;
    Deno.writeTextFile(errorSqlScriptFName, sqlScript);
    // deno-fmt-ignore
    console.error( dim(`❌`), brightRed( `Failed to execute ${ relative(".", modifiedFile) } (${sr.code}) [see ${errorSqlScriptFName}] {${globalEventCount}}`));
    if (!modifiedFile.endsWith(".sql")) {
      // deno-fmt-ignore
      console.error( dim(`❗`), brightYellow( `Reminder: ${ relative(".", modifiedFile) } must be executable in order to generate SQL. {${globalEventCount}}`, ), );
    }
  }
  const stdOut = sr.stdout().trim();
  if (stdOut.length) console.log(dim(stdOut));
  const stdErr = sr.stdout().trim();
  if (stdErr.length) console.log(brightRed(stdErr));
  return sr;
}

/**
 * Watches for changes in the specified files and triggers the execution of SQL scripts
 * on the SQLite database whenever a change is detected.
 *
 * @param watch.paths - The list of paths to watch
 * @param watch.recusive - Whether to watch the list of paths recursively
 * @param files - The list of files to watch.
 * @param db - The path to the SQLite database file.
 * @param service
 * @showModifiedUrlsOnChange - Query the database and see what was changed between calls
 */
async function watchFiles(
  watch: { paths: string[]; recursive: boolean },
  files: RegExp[],
  stateDbFsPath: string,
  load: string[] | undefined,
  service: {
    readonly stop?: () => Promise<void>;
    readonly start?: () => Promise<void>;
  },
  externalSqlite3?: string,
) {
  try {
    // deno-fmt-ignore
    console.log( dim( `👀 Watching paths [${watch.paths.join(" ")}] ${ files.map((f) => f.toString()).join(", ") } (${watch.paths.length})`));
    if (load?.length) {
      for (const l of load) {
        // deno-fmt-ignore
        console.log( dim( `🔃 Loading ${ relative(Deno.cwd(), isAbsolute(l) ? l : join(Deno.cwd(), l)) } on change`));
      }
    }

    const surveilrRelPath = (path: string) => {
      const result = relative(Deno.cwd(), path);
      return result.startsWith("../") ? result : `./${result}`;
    };

    const spawnedSurveilr = async (...sources: string[]) => {
      // deno-fmt-ignore
      console.log(dim(`🚀 surveilr shell ${sources.join(" ")} [${await fileSizeMB(stateDbFsPath)}mb]`));

      const sr = await spawnedResult([
        "surveilr",
        "shell",
        "--state-db-fs-path",
        stateDbFsPath,
        ...sources,
      ]);
      if (sr.code == 0) {
        // deno-fmt-ignore
        console.log( dim(`✅`), brightGreen(sr.command.join(" ")), green(`[sr: ${sr.code}, ${await fileSizeMB(stateDbFsPath)}mb] {${globalEventCount}}`));
      } else {
        // deno-fmt-ignore
        console.log( dim(`❌`), brightRed(sr.command.join(" ")), red(`[sr: ${sr.code}, ${await fileSizeMB(stateDbFsPath)}mb] {${globalEventCount}}`));
      }
      const stdOut = sr.stdout().trim();
      if (stdOut.length) console.log(dim(stdOut));
      const stdErr = sr.stdout().trim();
      if (stdErr.length) console.log(brightRed(stdErr));
      return sr;
    };

    const spawnedSqlIngest = async (...sources: string[]) => {
      if (externalSqlite3) {
        if (sources.length != 1) {
          console.error(
            `Expecting only a single source in spawnedSqlIngest for ${spawnedSqlIngest}`,
          );
          return;
        }
        await spawnedSqlite3(externalSqlite3, stateDbFsPath, sources[0]);
      } else {
        await spawnedSurveilr(...sources);
      }
    };

    const reload = debounce(async (event: Deno.FsEvent) => {
      for (const path of event.paths) {
        for (const file of files) {
          if (file.test(path)) {
            // deno-fmt-ignore
            console.log(dim(`👀 Watch event (${event.kind}): ${brightWhite(relative(".", path))} {${globalEventCount}}`));
            await service.stop?.();
            if (load?.length) {
              // instead of the file that's being modified we want to load a
              // different (set) of files (usually package.sql.ts)
              await spawnedSqlIngest(
                ...load.map((l) =>
                  surveilrRelPath(isAbsolute(l) ? l : join(Deno.cwd(), l))
                ),
              );
            } else {
              // no custom loaders passed in, just reload the file that was modified
              await spawnedSqlIngest(surveilrRelPath(path));
            }
            service.start?.();
            globalEventCount++;
            break; // in case file matches multiple patterns
          }
        }
      }
    }, 500);

    const watcher = Deno.watchFs(watch.paths, { recursive: watch.recursive });
    for await (const event of watcher) {
      if (event.kind === "modify" || event.kind === "create") {
        reload(event);
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      console.log(
        brightRed(`Invalid watch path: ${watch.paths.join(":")} (${error})`),
      );
    } else {
      console.log(
        brightRed(`watchFiles issue: ${error} (${files}, ${stateDbFsPath})`),
      );
    }
  }
}

async function webServerDevAction(options: {
  readonly stateDbFsPath: string;
  readonly port: number;
  readonly watch?: string[];
  readonly watchRecurse: boolean;
  readonly load?: string[];
  readonly externalSqlpage?: string;
  readonly externalSqlite3?: string;
  readonly restartWebServerOnChange: true;
}) {
  const {
    stateDbFsPath,
    port,
    load,
    externalSqlpage,
    restartWebServerOnChange,
    externalSqlite3,
  } = options;

  console.log(dim(
    `Using ${
      cyan((await spawnedResult(["surveilr", "--version"])).stdout())
    } RSSD ${cyan(stateDbFsPath)} (${await fileSizeMB(stateDbFsPath)}mb)`,
  ));

  // Determine the command and arguments
  const serverCommand = externalSqlpage
    ? ["sqlpage"]
    : ["surveilr", "web-ui", "--port", String(port)];
  const serverEnv = externalSqlpage
    ? {
      SQLPAGE_PORT: String(port),
      SQLPAGE_DATABASE_URL: `sqlite://${stateDbFsPath}`,
    }
    : undefined;
  const serverFriendlyName = externalSqlpage ? `SQLPage` : `surveilr web-ui`;

  // Start the server process
  if (externalSqlpage) {
    console.log(cyan(`Starting standlone SQLPage server on port ${port}...`));
    console.log(
      brightYellow(`SQLPage server running with database: ${stateDbFsPath}`),
    );
  } else {
    console.log(
      cyan(`Starting surveilr web-ui on port ${port}...`),
    );
  }

  const baseUrl = `http://localhost:${port}`;
  console.log(
    dim(
      `Restart ${serverFriendlyName} on each change: ${restartWebServerOnChange}`,
    ),
  );
  console.log(brightYellow(`${baseUrl}/index.sql`));

  let webServerProcess: Deno.ChildProcess | null;
  const webServerService = {
    // deno-lint-ignore require-await
    start: async () => {
      if (webServerProcess) {
        if (!restartWebServerOnChange) return;
        console.log(
          brightRed(
            `⚠️ Unable start new ${serverFriendlyName}, process is already running.`,
          ),
        );
        return;
      }
      const serverCmd = new Deno.Command(serverCommand[0], {
        args: serverCommand.slice(1),
        env: serverEnv,
        stdout: "inherit",
        stderr: "inherit",
      });
      webServerProcess = serverCmd.spawn();
      console.log(
        dim(
          `👍 Started ${serverFriendlyName} process with PID ${webServerProcess.pid}`,
        ),
      );
    },

    stop: async () => {
      if (!restartWebServerOnChange) return;
      if (webServerProcess) {
        const existingPID = webServerProcess?.pid;
        webServerProcess?.kill("SIGINT");
        const { code } = await webServerProcess.status;
        webServerProcess = null;
        console.log(
          dim(
            `⛔ Stopped ${serverFriendlyName} process with PID ${existingPID}: ${code}`,
          ),
        );
      } else {
        console.log(
          brightRed(
            `Unable to stop ${serverFriendlyName} server, no process started.`,
          ),
        );
      }
    },
  };

  // Watch for changes in SQL and TS files and execute surveilr shell or sqlite3 on change
  const fromCwdToStdLib = relative(
    Deno.cwd(),
    fromFileUrl(import.meta.resolve("./")),
  );
  watchFiles(
    {
      paths: [
        // TODO: join(fromCwdToStdLib, "/models"),
        join(fromCwdToStdLib, "/notebook"),
        join(fromCwdToStdLib, "/web-ui-content"),
        join(fromCwdToStdLib, "/package.sql.ts"),
        ...options.watch ?? ["."],
      ],
      recursive: options.watchRecurse,
    },
    // watch for *.sql.ts, *.sql, and *.ts
    [/\.sql\.ts$/, /^(?!ERROR).*\.sql$/, /.ts$/],
    stateDbFsPath,
    load ?? ["package.sql.ts"],
    webServerService,
    externalSqlite3,
  );

  webServerService.start();
}

const DEV_DEFAULT_PORT = 9000;
const DEV_DEFAULT_DB = Deno.env.get("SURVEILR_STATEDB_FS_PATH") ??
  "resource-surveillance.sqlite.db";

// deno-fmt-ignore so that commands defn is clearer
await new Command()
  .name("surveilrctl")
  .version("1.0.0")
  .description("Resource Surveillance (surveilr) controller")
  .command("dev", "Developer lifecycle and experience")
    .option("-d, --state-db-fs-path <rssd:string>", "target SQLite database [env: SURVEILR_STATEDB_FS_PATH=]", { default: DEV_DEFAULT_DB})
    .option("-p, --port <port:number>", "Port to run web server on", { default: DEV_DEFAULT_PORT })
    .option("-w, --watch <path:string>", "watch path(s)", { collect: true })
    .option("-R, --watch-recurse", "Watch subdirectories too", { default: false })
    .option("-l, --load <path:string>", "Load these whenever watched files modified (instead of watched files themselves), defaults to `package.sql.ts`", { collect: true })
    .option("--external-sqlpage <sqlpage-binary:string>", "Run standalone SQLPage instead of surveilr embedded")
    .option("--external-sqlite3 <sqlite3-binary:string>", "Run standalone sqlite3 instead of surveilr shell", { default: "sqlite3" })
    .option("--restart-web-server-on-change", "Restart the web server on each change, needed for surveir & SQLite", { default: true })
    .action(webServerDevAction)
  .parse(Deno.args ?? ["dev"]);
