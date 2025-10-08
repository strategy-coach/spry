#!/usr/bin/env -S deno run -A
import { Command } from "jsr:@cliffy/command@1.0.0-rc.8";
import { HelpCommand } from "jsr:@cliffy/command@1.0.0-rc.8/help";
import { ensureDir } from "jsr:@std/fs@^1";
import { dirname, join } from "jsr:@std/path@^1";
import { z } from "jsr:@zod/zod@4";
import {
  AnnotatedRoute,
  pathExtensions,
  routeAnnSchema,
  Routes,
} from "../assembler/mod.ts";
import {
  CodeCell,
  DocCodeCellMutator,
  documentedNotebooks,
  mutateDocCodeCells,
  notebooks,
  pipedDocCodeCellMutators,
  safeFrontmatter,
} from "../codebook/mod.ts";

// ----- SQLPage configuration schema (frontmatter-friendly) -----
export const sqlPageConfSchema = z
  .object({
    // Core server & DB
    database_url: z.string().min(1).optional(),
    database_password: z.string().min(1).optional(), // optional, supported in newer versions
    listen_on: z.string().min(1).optional(), // e.g. "0.0.0.0:8080"
    port: z.number().min(1).optional(),
    web_root: z.string().min(1).optional(),

    // Routing / base path
    site_prefix: z.string().min(1).optional(), // e.g. "/sqlpage"

    // HTTPS / host
    https_domain: z.string().min(1).optional(), // e.g. "example.com"
    host: z.string().min(1).optional(), // required by SSO; must match domain exactly

    // Security / limits
    allow_exec: z.boolean().optional(),
    max_uploaded_file_size: z.number().int().positive().optional(),

    // Environment
    environment: z.enum(["production", "development"]).optional(),

    // Frontmatter-friendly nested OIDC
    oidc: z
      .object({
        issuer_url: z.string().min(1),
        client_id: z.string().min(1),
        client_secret: z.string().min(1),
        scopes: z.array(z.string()).optional(),
        redirect_path: z.string().min(1).optional(),
      })
      .optional(),

    // Also accept already-flat OIDC keys (as SQLPage expects in json)
    oidc_issuer_url: z.string().min(1).optional(),
    oidc_client_id: z.string().min(1).optional(),
    oidc_client_secret: z.string().min(1).optional(),
  })
  .catchall(z.unknown());

export type SqlPageConf = z.infer<typeof sqlPageConfSchema>;

// --- default frontmatter schema (unchanged except kept .catchall) ---
const defaultFmSchema = z.object({
  siteName: z.string().optional(),
  "sqlpage-conf": sqlPageConfSchema.optional(),
}).catchall(z.unknown());

export type SqlPageFile = {
  kind: "head_sql" | "tail_sql" | "sqlpage_file_upsert";
  path: string; // relative path (e.g., "sql.d/head/001.sql", "admin/index.sql")
  contents: string; // file contents
  lastModified?: Date; // optional timestamp (not used in DML; engine time is used)
};

export const isRouteSupplier = (o: unknown): o is { route: AnnotatedRoute } =>
  o && typeof o === "object" && "route" in o &&
    typeof o.route === "object"
    ? true
    : false;

export const enrichRoute: DocCodeCellMutator<string> = (
  cell,
  { nb, registerIssue },
) => {
  if (!isRouteSupplier(cell.attrs)) return;
  const route = cell.attrs.route as AnnotatedRoute;
  if (!route.path && cell.info) {
    route.path = cell.info;
  }
  const extensions = pathExtensions(route.path);
  route.pathBasename = extensions.basename;
  route.pathBasenameNoExtn = extensions.basename.split(".")[0];
  route.pathDirname = dirname(route.path);
  route.pathExtnTerminal = extensions.terminal;
  route.pathExtns = extensions.extensions;
  const parsed = z.safeParse(routeAnnSchema, route);
  if (!parsed.success) {
    registerIssue({
      kind: "fence-attrs-json5-parse",
      disposition: "error",
      error: parsed.error,
      message: `Zod error parsing route: ${z.prettifyError(parsed.error)}`,
      provenance: nb.notebook.provenance,
      startLine: cell.startLine,
      endLine: cell.endLine,
    });
  }
};

export class SqlPageCodebook {
  protected readonly docCodeCellMutators: DocCodeCellMutator<string>[] = [];
  protected pipedMutators = pipedDocCodeCellMutators(this.docCodeCellMutators);
  protected constructor() {
    this.setupDocCodeCellMutators();
  }

  withDocCodeCellMutator(dcce: DocCodeCellMutator<string>) {
    this.docCodeCellMutators.push(dcce);
    this.pipedMutators = pipedDocCodeCellMutators(this.docCodeCellMutators);
  }

  setupDocCodeCellMutators() {
    this.withDocCodeCellMutator(enrichRoute);
  }

  async *notebooks(opts: { md: string[] }) {
    const sources = async function* () {
      for await (const md of opts.md) {
        yield {
          provenance: md,
          content: await Deno.readTextFile(md),
        };
      }
    };
    for await (
      const safeNB of safeFrontmatter(defaultFmSchema, notebooks(sources()))
    ) {
      if (safeNB.zodParseResult.success) {
        yield safeNB.notebook;
      } else {
        console.error(safeNB.notebook.provenance);
        console.error(z.prettifyError(safeNB.zodParseResult.error));
      }
    }
  }

  async *sqlPageCodebooks(opts: { md: string[] }) {
    return yield* mutateDocCodeCells(
      this.pipedMutators,
      documentedNotebooks(this.notebooks(opts), { kind: "hr" }),
    );
  }

  async *codeCells(opts: { md: string[] }) {
    for await (const spnb of this.sqlPageCodebooks(opts)) {
      for (const cell of spnb.cells) {
        if (cell.kind === "code") {
          yield cell;
        }
      }

      const { notebook: nb } = spnb;
      if (nb.issues.length) {
        yield {
          kind: "code",
          language: "json",
          source: JSON.stringify(nb.issues, null, 2),
          info: "NOTEBOOK_ISSUES",
          attrs: { issues: nb.issues },
          provenance: nb.provenance,
        } satisfies CodeCell<string>;
      }
    }
  }

  async *sqlPageFileEntries(opts: { md: string[] }) {
    const pageRoutes: AnnotatedRoute[] = [];

    function counter<Identifier>(identifier: Identifier, padValue = 4) {
      let value = -1;
      const incr = () => ++value;
      const next = () => String(incr()).padStart(padValue, "0");
      return { identifier, incr, next };
    }

    const headCount = counter("head");
    const tailCount = counter("tail");

    for await (const cc of this.codeCells(opts)) {
      switch (cc.language) {
        case "json": {
          if (cc.info && cc.info === "NOTEBOOK_ISSUES") {
            yield {
              path: `spry.d/issues/${cc.provenance}.auto.json`,
              kind: "sqlpage_file_upsert",
              contents: cc.source,
            } satisfies SqlPageFile;
          }
          break;
        }
        case "sql": {
          if (!cc.info) {
            console.error(
              `INFO expected on line ${cc.startLine} of ${cc.provenance}`,
            );
            continue;
          }
          const { info: path } = cc;
          if (path === "HEAD" || path === "TAIL") {
            yield {
              path: path === "HEAD"
                ? `sql.d/head/${headCount.next()}.sql`
                : `sql.d/tail/${tailCount.next()}.sql`,
              kind: path === "HEAD" ? "head_sql" : "tail_sql",
              contents: cc.source,
            } satisfies SqlPageFile;
          } else {
            yield {
              path,
              kind: "sqlpage_file_upsert",
              contents: cc.source,
            } satisfies SqlPageFile;
            if (Object.entries(cc.attrs).length) {
              if (isRouteSupplier(cc.attrs)) {
                pageRoutes.push(cc.attrs.route as AnnotatedRoute);
              }
              yield {
                path: `spry.d/auto/resource/${path}.auto.json`,
                kind: "sqlpage_file_upsert",
                contents: JSON.stringify(this.dropUndef(cc.attrs), null, 2),
              } satisfies SqlPageFile;
            }
          }
          break;
        }
      }
    }

    const routes = new Routes(pageRoutes);
    const { forest, breadcrumbs, edges, serializers } = await routes.populate();
    yield {
      path: "spry.d/auto/route/tree.auto.txt",
      contents: serializers.asciiTreeText({
        showPath: true,
        includeCounts: true,
      }),
      kind: "sqlpage_file_upsert",
    } satisfies SqlPageFile;
    yield {
      path: "spry.d/auto/route/forest.auto.json",
      contents: JSON.stringify(forest, null, 2),
      kind: "sqlpage_file_upsert",
    } satisfies SqlPageFile;
    yield {
      path: "spry.d/auto/route/breadcrumbs.auto.json",
      contents: JSON.stringify(breadcrumbs, null, 2),
      kind: "sqlpage_file_upsert",
    } satisfies SqlPageFile;
    yield {
      path: "spry.d/auto/route/edges.auto.json",
      contents: JSON.stringify(edges, null, 2),
      kind: "sqlpage_file_upsert",
    } satisfies SqlPageFile;
  }

  async materializeContent(
    opts: { fs: string; path: string; contents: string },
  ) {
    const { fs, path, contents } = opts;
    const absPath = join(fs, path);
    await ensureDir(dirname(absPath));
    await Deno.writeTextFile(absPath, contents);
    return absPath;
  }

  async *materializeFs(opts: { md: string[]; fs: string }) {
    for await (const spf of this.sqlPageFileEntries(opts)) {
      const absPath = this.materializeContent({
        fs: opts.fs,
        path: spf.path,
        contents: spf.contents,
      });
      yield { ...spf, absPath };
    }
  }

  /**
   * Build DML statements to upsert files into a SQLPage virtual-files table.
   * dialect "sqlite":
   *   INSERT INTO sqlpage_files (path, contents, last_modified) VALUES ('…','…', CURRENT_TIMESTAMP)
   *   ON CONFLICT(path) DO UPDATE
   *     SET contents = excluded.contents,
   *         last_modified = CURRENT_TIMESTAMP
   *     WHERE sqlpage_files.contents <> excluded.contents;
   *
   * Returns one object per file, tagged with kind: "sqlpage_file_insert".
   * On conflict when contents differ, last_modified is set by the SQL engine (CURRENT_TIMESTAMP).
   * If contents are identical, the row is left unchanged.
   */
  async sqlPageFilesUpsertDML(
    dialect: "sqlite",
    opts: { md: string[]; includeSqlPageFilesTable?: boolean },
  ) {
    if (dialect !== "sqlite") {
      throw new Error(`Unsupported dialect: ${dialect}`);
    }
    if (opts.includeSqlPageFilesTable) {
      `CREATE TABLE IF NOT EXISTS "sqlpage_files" ("path" VARCHAR PRIMARY KEY NOT NULL, "contents" TEXT NOT NULL, "last_modified" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP);`;
    }

    const esc = (s: string) => s.replace(/'/g, "''");
    const list = await Array.fromAsync(this.sqlPageFileEntries(opts));

    // Deterministic order: heads → non-head/tail → tails
    return [
      opts.includeSqlPageFilesTable
        ? `CREATE TABLE IF NOT EXISTS "sqlpage_files" ("path" VARCHAR PRIMARY KEY NOT NULL, "contents" TEXT NOT NULL, "last_modified" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP);`
        : "-- sqlpage_files DDL not requested",
      ...list.filter((e) => e.kind === "head_sql").map((spf) => spf.contents),
      ...list.filter((e) => e.kind === "sqlpage_file_upsert").map((f) => {
        const pathLit = `'${esc(f.path)}'`;
        const bodyLit = `'${esc(f.contents)}'`;
        return `INSERT INTO sqlpage_files (path, contents, last_modified) VALUES (${pathLit}, ${bodyLit}, CURRENT_TIMESTAMP) ` +
          `ON CONFLICT(path) DO UPDATE SET contents = excluded.contents, last_modified = CURRENT_TIMESTAMP ` +
          `WHERE sqlpage_files.contents <> excluded.contents;`;
      }), // pages, shells, partials, etc.
      ...list.filter((e) => e.kind === "tail_sql").map((spf) => spf.contents),
    ];
  }

  // Utility: drop undefined recursively
  protected dropUndef<T extends Record<string, unknown>>(obj: T): T {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const nested = this.dropUndef(v as Record<string, unknown>);
        if (Object.keys(nested).length > 0) out[k] = nested;
      } else {
        out[k] = v;
      }
    }
    return out as T;
  }

  // Produces the exact JSON object you can write to sqlpage/sqlpage.json
  sqlPageConf(conf: z.infer<typeof sqlPageConfSchema>) {
    // Start from a shallow clone
    const out: Record<string, unknown> = { ...conf };

    // Flatten nested OIDC if provided
    if (conf.oidc) {
      const { issuer_url, client_id, client_secret, scopes, redirect_path } =
        conf.oidc;
      // Only set flat keys if not already set at top level
      if (issuer_url && out.oidc_issuer_url === undefined) {
        out.oidc_issuer_url = issuer_url;
      }
      if (client_id && out.oidc_client_id === undefined) {
        out.oidc_client_id = client_id;
      }
      if (client_secret && out.oidc_client_secret === undefined) {
        out.oidc_client_secret = client_secret;
      }
      if (scopes !== undefined) out.oidc_scopes = scopes; // SQLPage ignores unknowns; keeping for future
      if (redirect_path !== undefined) out.oidc_redirect_path = redirect_path;
      delete out.oidc;
    }

    // Clean undefineds
    return this.dropUndef(out);
  }

  async run(argv: string[] = Deno.args) {
    await new Command()
      .name("codebook.ts")
      .version("0.1.0")
      .description(
        "SQLPage Markdown Notebook: emit SQL package, write sqlpage.json, or materialize filesystem.",
      )
      // Emit SQL package (sqlite) to stdout; accepts md path
      .option("-m, --md <mdPath:string>", "Use the given Markdown source", {
        required: true,
        collect: true,
      })
      // Emit SQL package (sqlite) to stdout; accepts md path
      .option(
        "-p, --package",
        "Emit SQL package (sqlite) to stdout from the given markdown path.",
      )
      // Materialize files to a target directory
      .option(
        "--fs <srcHome:string>",
        "Materialize SQL files under this directory.",
      )
      // Write sqlpage.json to the given path
      .option(
        "-c, --conf <confPath:string>",
        "Write sqlpage.json to this path (generated from frontmatter sqlpage-conf).",
      )
      .action(async (opts) => {
        // If --fs is present, materialize files under that root
        if (typeof opts.fs === "string" && opts.fs.length > 0) {
          Array.fromAsync(this.materializeFs({ md: opts.md, fs: opts.fs }));
        }

        // If -p/--package is present (i.e., user requested SQL package), emit to stdout
        if (opts.package) {
          for (
            const chunk of await this.sqlPageFilesUpsertDML("sqlite", {
              md: opts.md,
              includeSqlPageFilesTable: true,
            })
          ) {
            console.log(chunk);
          }
        }

        // If --conf is present, write sqlpage.json
        if (opts.conf) {
          for await (const nb of this.notebooks(opts)) {
            if (nb.fm["sqlpage-conf"]) {
              const json = this.sqlPageConf(nb.fm["sqlpage-conf"]);
              await ensureDir(dirname(opts.conf));
              await Deno.writeTextFile(
                opts.conf,
                JSON.stringify(json, null, 2),
              );
              break; // only pick from the first file
            }
          }
        }
      })
      .command("help", new HelpCommand().global())
      .parse(argv);
  }

  static instance() {
    return new SqlPageCodebook();
  }
}

if (import.meta.main) {
  SqlPageCodebook.instance().run();
}
