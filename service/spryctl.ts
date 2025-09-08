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
import { annotationsParser } from "../lib/universal/annotations.ts";
import { drizzle } from "npm:drizzle-orm/libsql";
import * as m from "../service/lib/models.ts";

// Given a query with `?` params, return the SQL with params inlined as literals.
// Replaces only placeholders outside single-quoted strings; anything inside '...' is left untouched.
export function inlinedSQL(q: { sql: string; params: unknown[] }): string {
  function literal(v: unknown): string {
    if (v === null || v === undefined) return "null";
    if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
    if (v instanceof Date) return `'${v.toISOString()}'`;
    if (v instanceof Uint8Array) {
      return "X'" + Array.from(v).map((b) =>
        b.toString(16).padStart(2, "0")
      ).join("") + "'";
    }
    return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  }

  const { sql, params } = q;
  let i = 0, p = 0;
  let out = "";
  const n = sql.length;

  while (p < n) {
    const ch = sql[p];

    if (ch === "'") {
      // copy string literal verbatim, honoring doubled '' escapes
      out += ch;
      p++;
      while (p < n) {
        const c = sql[p];
        out += c;
        p++;
        if (c === "'") {
          if (p < n && sql[p] === "'") {
            out += "'";
            p++;
          } // escaped quote
          else break; // end of string
        }
      }
      continue;
    }

    if (ch === "?") {
      out += i < params.length ? literal(params[i++]) : "?";
      p++;
      continue;
    }

    out += ch;
    p++;
  }

  return out + ";";
}

type Encountered = {
  root: string;
  path: string;
  relPath: string;
};

const spryEntry = annotationsParser(
  "spry",
  z.object({
    nature: z.enum(["api", "page"]).default("page"),
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
    encountered,
    isInRoot,
    isEntryAnnotated,
    entry,
    isRouteAnnotated,
    route,
  };
}

async function walkRoots(
  init: {
    root: string[];
    include?: string[] | undefined;
    exclude?: string[] | undefined;
  },
  ingest: (encountered: Readonly<Encountered>) => void | Promise<void>,
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
      await ingest({
        root,
        path: abs,
        relPath,
      });
    }
  }
}

const cmd = (
  descr: string,
  ingest: (encountered: Readonly<Encountered>) => void | Promise<void>,
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
      await walkRoots(options, ingest);
    });

await new Command()
  .name("spryctl")
  .description("Walk roots and process files with include/exclude globs.")
  .example(
    "just SQL",
    `./spryctl.ts ls -r . -i "**/*.sql" -x "sqlpage/migrations/**"`,
  )
  .example(
    "specific path with excludes",
    `./spryctl.ts emit -r . -i "spry/**" -x "deno.*" -x "spryctl.ts" -x "*.db"`,
  )
  .command(
    "ls",
    cmd("List files that would be processed.", async (enc) => {
      const { entry, isEntryAnnotated } = await discover(enc);
      console.log(
        isEntryAnnotated ? "📝" : dim("❔"),
        dim(entry?.success ? entry.data.nature : "unknown"),
        enc.relPath,
      );
      if (entry?.error) console.error(brightRed(z.prettifyError(entry.error)));
    }),
  )
  .command(
    "emit",
    new Command()
      .description("Process files and emit results.")
      .command(
        "routes",
        cmd("Emit navigation routes.", async (enc) => {
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
      ),
  )
  .parse(Deno.args);
