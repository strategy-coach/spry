#!/usr/bin/env -S deno run --allow-run --allow-env --allow-net --allow-read --allow-write --node-modules-dir --allow-sys --allow-ffi 

// Walk one or more roots, filter with include/exclude globs, and hand each file to a handler.
// Entire logic lives in the Cliffy action; uses Deno std `walk`.

import { Command } from "jsr:@cliffy/command@1.0.0-rc.8";
import { walk } from "jsr:@std/fs@1/walk";
import {
  basename,
  dirname,
  fromFileUrl,
  globToRegExp,
  isAbsolute,
  join,
  relative,
  resolve,
} from "jsr:@std/path@1";
import { z } from "jsr:@zod/zod@^4.1.5";
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

  return out;
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

type Source = {
  readonly encountered: Readonly<Encountered>;
  readonly entry: z.infer<typeof spryEntry.schema>;
  readonly route: z.infer<typeof spryRoute.schema>;
};

// needed for drizzle-orm with @libsql/client because it doesn't generate SQL without it
const db = drizzle({ connection: { url: ":memory:" } });

async function ingest(encountered: Readonly<Encountered>) {
  const isInRoot = dirname(encountered.relPath) == ".";
  const content = await Deno.readTextFile(encountered.path);
  const anns = spryEntry.parse(content, (obj, ensure) => {
    ensure(obj, "nature", "page");
    ensure(obj, "absPath", encountered.path);
    ensure(obj, "relPath", encountered.relPath);
    return true;
  });
  const route = spryRoute.parse(content, (obj, ensure) => {
    if (Object.entries(obj).length === 0) return false;
    ensure(obj, "namespace", encountered.path);
    if (!isInRoot) {
      ensure(
        obj,
        "parentPath",
        `${dirname(dirname(encountered.relPath))}/index.sql`,
      );
    }
    ensure(obj, "path", encountered.relPath);
    ensure(obj, "caption", basename(encountered.relPath));
    return true;
  });
  if (anns?.success && Object.entries(anns.data).length > 0) {
    console.log(anns.data.relPath, isInRoot);
  }
  if (anns?.error) console.error(z.prettifyError(anns.error));
  if (route?.success && Object.entries(route.data).length > 0) {
    console.log(route.data);
    console.log(
      inlinedSQL(
        // TODO: fix the type-safety issue here
        // deno-lint-ignore no-explicit-any
        db.insert(m.spryNavigation).values(route.data as any).toSQL(),
      ),
    );
  }
  if (route?.error) {
    console.error(
      z.prettifyError(route.error),
      "in @route annotation",
      encountered.relPath,
    );
  }
}

await new Command()
  .name("spryctl")
  .description("Walk roots and process files with include/exclude globs.")
  .example("just SQL", `./spryctl.ts -r . -i "**/*.sql"`)
  .example(
    "specific path with excludes",
    `./spryctl.ts -r . -i "spry/**" -x "deno.*" -x "spryctl.ts" -x "*.db"`,
  )
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
  )
  .action(
    async (opts) => {
      const baseDir = dirname(fromFileUrl(import.meta.url));
      const roots = (opts.root ?? []).map((
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
        const includeGlobs = opts.include ?? [];
        const excludeGlobs = opts.exclude ?? [];
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
    },
  )
  .parse(Deno.args);
