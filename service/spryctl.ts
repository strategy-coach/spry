#!/usr/bin/env -S deno run -A 

// Walk one or more roots, filter with include/exclude globs, and hand each file to a handler.
// Entire logic lives in the Cliffy action; uses Deno std `walk`.

import { walk } from "jsr:@std/fs@1/walk";
import {
  dirname,
  fromFileUrl,
  globToRegExp,
  isAbsolute,
  join,
  relative,
  resolve,
} from "jsr:@std/path@1";
import { brightRed, dim, yellow } from "jsr:@std/fmt@1/colors";
import { z } from "jsr:@zod/zod@^4.1.5";
import { Command } from "jsr:@cliffy/command@1.0.0-rc.8";
import { HelpCommand } from "jsr:@cliffy/command@1.0.0-rc.8/help";
import { annotationsParser } from "../lib/universal/annotations.ts";
import { drizzle } from "npm:drizzle-orm/libsql";
import * as m from "../service/lib/models.ts";
import { eq } from "npm:drizzle-orm";
import Table from "npm:cli-table3@0.6.5";
import { inlinedSQL } from "../lib/universal/sql-text.ts";

type Encountered = {
  root: string;
  path: string;
  relPath: string;
};

const spryEntry = annotationsParser(
  "spry",
  z.object({
    nature: z.enum(["action", "api", "page", "sql-sp"]).default("page")
      .describe(
        `The nature of this file, influencing how it's treated by the system, defaults to 'page'. 
         Possible values are 'action' for code that executes and redirects back to page, 'api' for
         API endpoints, 'page' for standard web pages, and 'sql-sp' for SQL stored procedures.`,
      ),
    // Additional fields can be added here as needed
    absPath: z.string(),
    relPath: z.string(),
  }).strict(),
);

const spryRoute = annotationsParser(
  "route",
  z.object({
    path: z.string(),
    caption: z.string(),
    namespace: z.string(),
    parentPath: z.string().optional(),
    siblingOrder: z.number().optional(),
    url: z.string().optional(),
    abbreviatedCaption: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    elaboration: z.json().optional(),
  }).strict(),
);

async function discover(encountered: Readonly<Encountered>) {
  const isInRoot = dirname(encountered.relPath) == ".";
  const content = await Deno.readTextFile(encountered.path);
  let isEntryAnnotated = false;
  const entry = spryEntry.parse(content, (obj, ensure) => {
    isEntryAnnotated = Object.hasOwn(obj, "nature");
    ensure(obj, "nature", "page");
    ensure(obj, "absPath", encountered.path);
    ensure(obj, "relPath", encountered.relPath);
    return true;
  });
  let isRouteAnnotated = false;
  const route = spryRoute.parse(content, (obj, ensure) => {
    if (Object.entries(obj).length === 0) return false;
    isRouteAnnotated = true;
    ensure(obj, "namespace", "spry");
    if (!isInRoot) {
      let parentPath = dirname(dirname(encountered.relPath));
      if (parentPath === ".") parentPath = "spry";
      ensure(
        obj,
        "parentPath",
        `/${parentPath}/index.sql`,
      );
    }
    ensure(obj, "path", `/${encountered.relPath}`);
    return true;
  });
  return {
    content,
    encountered,
    isInRoot,
    isEntryAnnotated,
    entry,
    isRouteAnnotated,
    route,
  };
}

async function walkRoots<Context>(
  init: {
    ctx: Context;
    root: string[];
    include?: string[] | undefined;
    exclude?: string[] | undefined;
  },
  ingest: (
    ctx: Context,
    encountered: Readonly<Encountered>,
  ) => void | Promise<void>,
) {
  const baseDir = dirname(fromFileUrl(import.meta.url));
  const roots = (init.root ?? []).map((
    r,
  ) => (isAbsolute(r) ? r : resolve(baseDir, r)));
  if (roots.length === 0) {
    console.error("error: at least one --root is required");
    Deno.exit(2);
  }

  // Validate roots
  for (const r of roots) {
    try {
      const st = await Deno.stat(r);
      if (!st.isDirectory) throw new Error("not a directory");
    } catch {
      console.error(`error: invalid root: ${r}`);
      Deno.exit(2);
    }
  }

  const seen = new Set<string>();
  for (const root of roots) {
    // Pre-compile include/exclude patterns against ABSOLUTE paths.
    const includeGlobs = init.include ?? [];
    const excludeGlobs = init.exclude ?? [];
    const includeRes = includeGlobs.map((g) =>
      globToRegExp(isAbsolute(g) ? g : join(root, g), {
        extended: true,
        globstar: true,
      })
    );
    const excludeRes = excludeGlobs.map((g) =>
      globToRegExp(isAbsolute(g) ? g : join(root, g), {
        extended: true,
        globstar: true,
      })
    );
    const includeAll = includeRes.length === 0;

    for await (
      const entry of walk(root, {
        includeDirs: false,
        followSymlinks: false,
      })
    ) {
      const abs = entry.path;
      if (seen.has(abs)) continue; // skip dupes if roots overlap

      const passesInclude = includeAll ||
        includeRes.some((re) => re.test(abs));
      if (!passesInclude) continue;

      const hitsExclude = excludeRes.some((re) => re.test(abs));
      if (hitsExclude) continue;

      seen.add(abs);
      const relPath = relative(root, abs);
      await ingest(init.ctx, {
        root,
        path: abs,
        relPath,
      });
    }
  }
}

const cmd = <Context>(
  descr: string,
  ingest: (
    ctx: Context,
    encountered: Readonly<Encountered>,
  ) => void | Promise<void>,
  before?: () => Context | Promise<Context>,
  after?: (ctx?: Context) => void | Promise<void>,
) =>
  new Command()
    .description(descr)
    .option("-r, --root <dir:string>", "Root directory (repeatable).", {
      collect: true,
      required: true,
    })
    .option(
      "-i, --include <glob:string>",
      "Include glob(s). Repeatable. Defaults to all files.",
      { collect: true },
    )
    .option(
      "-x, --exclude <glob:string>",
      "Exclude glob(s). Repeatable. Defaults to none.",
      { collect: true },
    ).action(async (options) => {
      const ctx: Context = before ? (await before()) : {} as Context;
      await walkRoots<Context>({ ...options, ctx }, ingest);
      if (after) await after(ctx);
    });

await new Command()
  .name("spryctl")
  .description("Walk roots and process files with include/exclude globs.")
  .example(
    "just SQL",
    `./spryctl.ts ls -r . -i "**/*.sql" -x "sqlpage/migrations/**"`,
  )
  .example(
    "populate sqlpage_files table",
    `./spryctl.ts emit sqlpage-files -r . -i "**/*.sql" -x "sqlpage/migrations/**" | sqlite3 sqlpage.db`,
  )
  .example(
    "specific path with excludes",
    `./spryctl.ts emit -r . -i "spry/**" -x "deno.*" -x "spryctl.ts" -x "*.db"`,
  )
  .command("help", new HelpCommand().global())
  .command(
    "ls",
    cmd(
      "List files that would be processed.",
      async (ctx, enc) => {
        const { entry, isEntryAnnotated } = await discover(enc);
        ctx.table.push([
          isEntryAnnotated ? "📝" : dim("❔"),
          dim(entry?.success ? entry.data.nature : "unknown"),
          enc.relPath,
          entry?.error ? z.prettifyError(entry.error) : "",
        ]);
      },
      () => ({
        table: new Table({ head: ["", "Nature", "Path", "Ann Error"] }),
      }),
      (ctx) => console.log(ctx?.table.toString()),
    ),
  )
  .command(
    "emit",
    new Command()
      .description("Process files and emit results.")
      .command(
        "routes",
        cmd("Emit navigation routes.", async (_, enc) => {
          // needed for drizzle-orm with @libsql/client because it doesn't generate SQL without it
          const db = drizzle({ connection: { url: ":memory:" } });
          const { isRouteAnnotated, route } = await discover(enc);
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
                  db.insert(m.spryNavigation).values(route?.data as any)
                    .toSQL(),
                ),
              );
            }
          }
        }),
      ).command(
        "sqlpage-files",
        cmd("Emit navigation routes.", async (_, enc) => {
          // needed for drizzle-orm with @libsql/client because it doesn't generate SQL without it
          const db = drizzle({ connection: { url: ":memory:" } });
          const { content } = await discover(enc);
          const spf = m.sqlpageFiles;
          console.log(
            inlinedSQL(db.delete(spf).where(eq(spf.path, enc.relPath)).toSQL()),
          );
          console.log(
            inlinedSQL(
              db.insert(m.sqlpageFiles).values({
                path: enc.relPath,
                contents: content,
              }).toSQL(),
            ),
          );
        }),
      ),
  )
  .parse(Deno.args);
