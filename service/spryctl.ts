#!/usr/bin/env -S deno run -A 

// Walk one or more roots, filter with include/exclude globs, and hand each file to a handler.
// Entire logic lives in the Cliffy action; uses Deno std `walk`.

import { brightRed, dim, yellow } from "jsr:@std/fmt@1/colors";
import { z } from "jsr:@zod/zod@^4.1.5";
import { Command } from "jsr:@cliffy/command@1.0.0-rc.8";
import { HelpCommand } from "jsr:@cliffy/command@1.0.0-rc.8/help";
import { drizzle } from "npm:drizzle-orm@0.44.5/libsql";
import { sqliteModels } from "../service/lib/models.ts";
import { eq } from "npm:drizzle-orm@0.44.5";
import Table from "npm:cli-table3@0.6.5";
import { inlinedSQL } from "../lib/universal/sql-text.ts";
import { walkRoots } from "../lib/universal/walk-fs.ts";
import { annotatedContent } from "./lib/content.ts";
import { dirname, fromFileUrl } from "jsr:@std/path@1";

const walkDefaults = <Context>(ctx?: Context) => ({
  ctx: ctx ? ctx : {},
  root: ["."],
  include: ["**/*.sql"],
  exclude: ["sqlpage/migrations/**"],
  baseDir: dirname(fromFileUrl(import.meta.url)),
});

export async function discoverSQL() {
  const table = new Table({ head: ["", "Nature", "Path", "Ann Error"] });
  await walkRoots(
    walkDefaults({ table }),
    async (_, enc) => {
      const { entry, isEntryAnnotated } = await annotatedContent(enc);
      table.push([
        isEntryAnnotated ? "📝" : dim("❔"),
        dim(entry?.success ? entry.data.nature : "unknown"),
        enc.relPath,
        entry?.error ? z.prettifyError(entry.error) : "",
      ]);
    },
  );
  console.log(table.toString());
}

export async function emitSqlPageFiles() {
  // needed for drizzle-orm with @libsql/client because it doesn't generate SQL without it
  const db = drizzle({ connection: { url: ":memory:" } });
  const { sqlpageFiles: spf } = sqliteModels();
  await walkRoots(
    walkDefaults(),
    async (_, enc) => {
      const { content, entry } = await annotatedContent(enc);
      console.log(
        inlinedSQL(
          db.delete(spf).where(eq(spf.path, enc.relPath)).toSQL(),
        ),
      );
      console.log(
        inlinedSQL(
          db.insert(spf).values({
            path: enc.relPath,
            contents: content,
            nature: entry?.success ? entry.data.nature : "page",
          }).toSQL(),
        ),
      );
    },
  );
}

export async function emitRoutesSQL() {
  // needed for drizzle-orm with @libsql/client because it doesn't generate SQL without it
  const db = drizzle({ connection: { url: ":memory:" } });
  const { spryNavigation } = sqliteModels();
  await walkRoots(
    walkDefaults(),
    async (_, enc) => {
      const { isRouteAnnotated, route } = await annotatedContent(enc);
      if (isRouteAnnotated) {
        if (route?.error) {
          console.error(
            brightRed(z.prettifyError(route.error)),
            "in @route annotation",
            yellow(enc.relPath),
          );
        } else {
          console.log(
            inlinedSQL(
              // TODO: fix the type-safety issue here
              // deno-lint-ignore no-explicit-any
              db.insert(spryNavigation).values(route?.data as any)
                .toSQL(),
            ),
          );
        }
      }
    },
  );
}

if (import.meta.main) {
  await new Command()
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
    .example(
      "populate Spry routes (navigation) rows",
      `./spryctl.ts sql routes | sqlite3 sqlpage.db`,
    )
    .action(discoverSQL)
    .command("help", new HelpCommand().global())
    .command(
      "ls",
      new Command()
        .description("List SQLPage .sql files excluding migrations.")
        .action(discoverSQL),
    )
    .command(
      "sql",
      new Command()
        .description("Process files and emit SQL.")
        .command(
          "routes",
          new Command()
            .description("Emit navigation routes SQL.")
            .action(emitRoutesSQL),
        )
        .command(
          "sqlpage-files",
          new Command()
            .description("Emit sqlplage_files content SQL.")
            .action(emitSqlPageFiles),
        ),
    )
    .parse(Deno.args);
}
