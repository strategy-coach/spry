#!/usr/bin/env -S deno run -A
import { Command } from "jsr:@cliffy/command@1.0.0-rc.8";
import { HelpCommand } from "jsr:@cliffy/command@1.0.0-rc.8/help";
import { ensureDir } from "jsr:@std/fs@^1";
import { dirname, globToRegExp, isGlob, join } from "jsr:@std/path@^1";
import { z } from "jsr:@zod/zod@4";
import { posix } from "node:path";
import {
  AnnotatedRoute,
  pathExtensions,
  routeAnnSchema,
  Routes,
} from "../assembler/mod.ts";
import {
  DocCodeCellMutator,
  DocumentedCodeCell,
  documentedNotebooks,
  mutateDocCodeCells,
  notebooks,
  pipedDocCodeCellMutators,
  safeFrontmatter,
} from "../codebook/mod.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

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
    oidc: z.object({
      issuer_url: z.string().min(1),
      client_id: z.string().min(1),
      client_secret: z.string().min(1),
      scopes: z.array(z.string()).optional(),
      redirect_path: z.string().min(1).optional(),
    }).optional(),

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

/** Schema for typed InfoDirective from `Cell.info?` property */
export const sqlInfoDirectiveSchema = z.discriminatedUnion("nature", [
  z.object({
    nature: z.enum(["HEAD", "TAIL"]),
    identity: z.string().min(1).optional(), // optional for HEAD/TAIL
  }).strict(),
  z.object({
    nature: z.literal("sqlpage_file"),
    path: z.string().min(1),
  }).strict(),
  z.object({
    nature: z.literal("LAYOUT"),
    glob: z.string().min(1).default("**/*"), // default glob
  }).strict(),
  z.object({
    nature: z.literal("PARTIAL"),
    identity: z.string().min(1), // required for PARTIAL
  }).strict(),
]);

export type SqlInfoDirective = z.infer<typeof sqlInfoDirectiveSchema>;

export const isSqlInfoDirectiveSupplier = (
  o: unknown,
): o is { infoDirective: SqlInfoDirective } =>
  o && typeof o === "object" && "infoDirective" in o &&
    typeof o.infoDirective === "object"
    ? true
    : false;

type DocCodeCellWithDirective<N extends SqlInfoDirective["nature"]> =
  & DocumentedCodeCell<string>
  & { infoDirective: Extract<SqlInfoDirective, { nature: N }> };

function docCodeCellHasNature<N extends SqlInfoDirective["nature"]>(
  cell: DocumentedCodeCell<string> & { infoDirective: SqlInfoDirective },
  nature: N,
): cell is DocCodeCellWithDirective<N> {
  return cell.infoDirective.nature === nature;
}

export class Layouts {
  readonly layouts: (DocumentedCodeCell<string> & {
    infoDirective: Extract<SqlInfoDirective, { nature: "LAYOUT" }>;
  })[] = [];
  protected cached: {
    layout: DocumentedCodeCell<string> & {
      infoDirective: Extract<SqlInfoDirective, { nature: "LAYOUT" }>;
    };
    glob: string;
    g: string;
    re: RegExp;
    wc: number;
    len: number;
  }[] = [];

  register(cell: DocumentedCodeCell<string>) {
    // assume the enrichInfoDirective has already been run
    if (isSqlInfoDirectiveSupplier(cell)) {
      if (docCodeCellHasNature(cell, "LAYOUT")) {
        this.layouts.push(cell);
        this.rebuildCaches();
        return true;
      }
    }
    return false;
  }

  /** Build a matcher once; use findLayout(path) to get the closest matching glob. */
  protected rebuildCaches() {
    function toRegex(glob: string): RegExp {
      if (!isGlob(glob)) {
        // Treat literal as exact match (normalize + escape)
        const exact = posix.normalize(glob).replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        );
        return new RegExp(`^${exact}$`);
      }
      return globToRegExp(glob, {
        extended: true,
        globstar: true,
        caseInsensitive: false,
      });
    }

    function wildcardCount(g: string): number {
      // Penalize '**' heavier so it's considered less specific
      const starStar = (g.match(/\*\*/g) ?? []).length * 2;
      const singles = (g.replace(/\*\*/g, "").match(/[*?]/g) ?? []).length;
      return starStar + singles;
    }

    this.cached = this.layouts.map((layout) => {
      const { glob } = layout.infoDirective;
      const gg = posix.normalize(glob);
      return {
        layout,
        glob,
        g: gg,
        re: toRegex(gg),
        wc: wildcardCount(gg),
        len: gg.length,
      };
    });
  }

  findLayout(path: string) {
    const p = posix.normalize(path);
    const hits = this.cached.filter((c) => c.re.test(p));
    if (!hits.length) return undefined;
    hits.sort((a, b) => (a.wc - b.wc) || (b.len - a.len));
    const cell = hits[0].layout;
    return { cell, wrap: (text: string) => `${cell.source}\n${text}` };
  }
}

export class InfoDirectiveCells {
  readonly layouts = new Layouts();
  readonly heads: (DocumentedCodeCell<string> & {
    infoDirective: Extract<SqlInfoDirective, { nature: "HEAD" }>;
  })[] = [];
  readonly tails: (DocumentedCodeCell<string> & {
    infoDirective: Extract<SqlInfoDirective, { nature: "TAIL" }>;
  })[] = [];
  readonly partials: (DocumentedCodeCell<string> & {
    infoDirective: Extract<SqlInfoDirective, { nature: "PARTIAL" }>;
  })[] = [];

  register(cell: DocumentedCodeCell<string>) {
    if (this.layouts.register(cell)) return true;

    // assume the enrichInfoDirective has already been run
    if (isSqlInfoDirectiveSupplier(cell)) {
      if (docCodeCellHasNature(cell, "HEAD")) {
        this.heads.push(cell);
        return true;
      } else if (docCodeCellHasNature(cell, "TAIL")) {
        this.tails.push(cell);
        return true;
      } else if (docCodeCellHasNature(cell, "PARTIAL")) {
        this.partials.push(cell);
        return true;
      }
    }
    return false;
  }
}

export type SqlPageFile = {
  readonly kind: "head_sql" | "tail_sql" | "sqlpage_file_upsert";
  readonly path: string; // relative path (e.g., "sql.d/head/001.sql", "admin/index.sql")
  readonly contents: string; // file contents
  readonly lastModified?: Date; // optional timestamp (not used in DML; engine time is used)
  readonly cell?: DocumentedCodeCell<string>;
  readonly asErrorContents: (text: string, error: unknown) => string;
  readonly isUnsafeInterpolatable?: boolean;
  readonly isLayoutCandidate?: boolean;
};

export const isRouteSupplier = (o: unknown): o is { route: AnnotatedRoute } =>
  o && typeof o === "object" && "route" in o &&
    typeof o.route === "object"
    ? true
    : false;

/**
 * Transform that parses a Cell.info string into an InfoDirective.
 * - HEAD/TAIL → optional identity
 * - LAYOUT → glob defaults to "**\/*" if missing
 * - PARTIAL → requires identity
 * - unknown → defaults to { nature: "sqlpage_file", path: first token }
 */
export const enrichInfoDirective: DocCodeCellMutator<string> = (
  cell,
  { nb, registerIssue },
) => {
  if (isSqlInfoDirectiveSupplier(cell)) return;
  if (!cell.info) return;

  let info = cell.info;
  info = info?.trim() ?? "";
  if (info.length === 0) return undefined;

  const [first, ...rest] = info.split(/\s+/);
  const remainder = rest.join(" ").trim();

  let candidate: unknown;
  switch (first.toLocaleUpperCase()) {
    case "HEAD":
    case "TAIL":
      candidate = remainder
        ? { nature: first, identity: remainder }
        : { nature: first };
      break;

    case "LAYOUT":
      candidate = { nature: "LAYOUT", glob: remainder || "**/*" };
      break;

    case "PARTIAL":
      candidate = { nature: "PARTIAL", identity: remainder };
      break;

    default:
      candidate = { nature: "sqlpage_file", path: first };
      break;
  }

  const parsed = z.safeParse(sqlInfoDirectiveSchema, candidate);
  if (parsed.success) {
    (cell as Any).infoDirective = parsed.data;
    if (!isSqlInfoDirectiveSupplier(cell)) {
      throw Error("This should never happen");
    }
  } else {
    registerIssue({
      kind: "fence-issue",
      disposition: "error",
      error: parsed.error,
      message: `Zod error parsing info directive '${cell.info}': ${
        z.prettifyError(parsed.error)
      }`,
      provenance: nb.notebook.provenance,
      startLine: cell.startLine,
      endLine: cell.endLine,
    });
  }
};

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

export const enrichFrontmatter: DocCodeCellMutator<string> = (cell, { nb }) => {
  if ("frontmatter" in cell) return;
  (cell as Any).frontmatter = nb.notebook.fm;
};

export class SqlPageCodebook {
  protected readonly docCodeCellMutators: DocCodeCellMutator<string>[] = [];
  protected pipedDocCCMutators = pipedDocCodeCellMutators(
    this.docCodeCellMutators,
  );
  protected constructor() {
    this.setupDocCodeCellMutators();
  }

  withDocCodeCellMutator(dcce: DocCodeCellMutator<string>) {
    this.docCodeCellMutators.push(dcce);
    this.pipedDocCCMutators = pipedDocCodeCellMutators(
      this.docCodeCellMutators,
    );
  }

  setupDocCodeCellMutators() {
    // the order of these mutators matter!
    this.withDocCodeCellMutator(enrichInfoDirective);
    this.withDocCodeCellMutator(enrichRoute);
    this.withDocCodeCellMutator(enrichFrontmatter);
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
      this.pipedDocCCMutators,
      documentedNotebooks(this.notebooks(opts), { kind: "hr" }),
    );
  }

  async *codeCells(
    opts: { md: string[] },
    directives: InfoDirectiveCells,
  ) {
    const spBooks = await Array.fromAsync(this.sqlPageCodebooks(opts));
    const EXTRACTED = ".extractedInCodeCells" as const;
    for await (const spnb of spBooks) {
      for (const cell of spnb.cells) {
        if (cell.kind === "code") {
          if (directives.register(cell)) {
            (cell as Any)[EXTRACTED] = true;
          }
        }
      }
    }

    for await (const spnb of spBooks) {
      for (const cell of spnb.cells) {
        if (cell.kind === "code" && !(EXTRACTED in cell)) {
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
        } satisfies DocumentedCodeCell<string>;
      }
    }
  }

  async *rawSqlPageFileEntries(
    opts: { md: string[] },
    directives: InfoDirectiveCells,
  ) {
    const pageRoutes: AnnotatedRoute[] = [];
    const errorAsSqlComments = (text: string, _error: unknown) =>
      text.replaceAll(/^/gm, "-- ");
    const errorAsJSON = (text: string, error: unknown) =>
      JSON.stringify({ text, error });

    function counter<Identifier>(identifier: Identifier, padValue = 4) {
      let value = -1;
      const incr = () => ++value;
      const next = () => String(incr()).padStart(padValue, "0");
      return { identifier, incr, next };
    }

    const codeCells = await Array.fromAsync(
      this.codeCells(opts, directives),
    );

    const headCount = counter("head");
    for (const head of directives.heads) {
      yield {
        path: `sql.d/head/${headCount.next()}.sql`,
        kind: "head_sql",
        contents: head.source,
        cell: head,
        asErrorContents: errorAsSqlComments,
      } satisfies SqlPageFile;
    }

    for await (const cc of codeCells) {
      switch (cc.language) {
        case "json": {
          if (cc.info && cc.info === "NOTEBOOK_ISSUES") {
            yield {
              path: `spry.d/issues/${cc.provenance}.auto.json`,
              kind: "sqlpage_file_upsert",
              contents: cc.source,
              cell: cc,
              asErrorContents: errorAsJSON,
            } satisfies SqlPageFile;
          }
          break;
        }
        case "sql": {
          if (!cc.info) {
            console.warn(
              `sql fenced block found without INFO on line ${cc.startLine} of ${cc.provenance}`,
            );
            continue;
          }
          const { info: path } = cc;
          yield {
            path,
            kind: "sqlpage_file_upsert",
            contents: cc.source,
            cell: cc,
            asErrorContents: errorAsSqlComments,
            isUnsafeInterpolatable: true,
            isLayoutCandidate: true,
          } satisfies SqlPageFile;
          if (Object.entries(cc.attrs).length) {
            if (isRouteSupplier(cc.attrs)) {
              pageRoutes.push(cc.attrs.route as AnnotatedRoute);
            }
            yield {
              path: `spry.d/auto/resource/${path}.auto.json`,
              kind: "sqlpage_file_upsert",
              contents: JSON.stringify(this.dropUndef(cc.attrs), null, 2),
              cell: cc,
              asErrorContents: errorAsJSON,
            } satisfies SqlPageFile;
          }
          break;
        }
      }
    }

    const layoutCount = counter("layout");
    for (const lo of directives.layouts.layouts) {
      yield {
        path: `spry.d/auto/layout/${layoutCount.next()}.auto.sql`,
        kind: "sqlpage_file_upsert",
        contents: `-- ${JSON.stringify(lo.infoDirective)}\n${lo.source}`,
        cell: lo,
        asErrorContents: errorAsSqlComments,
      } satisfies SqlPageFile;
    }

    const tailCount = counter("tail");
    for (const tail of directives.tails) {
      yield {
        path: `sql.d/tail/${tailCount.next()}.sql`,
        kind: "tail_sql",
        contents: tail.source,
        cell: tail,
        asErrorContents: errorAsSqlComments,
      } satisfies SqlPageFile;
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
      asErrorContents: errorAsSqlComments,
    } satisfies SqlPageFile;
    yield {
      path: "spry.d/auto/route/forest.auto.json",
      contents: JSON.stringify(forest, null, 2),
      kind: "sqlpage_file_upsert",
      asErrorContents: errorAsJSON,
    } satisfies SqlPageFile;
    yield {
      path: "spry.d/auto/route/breadcrumbs.auto.json",
      contents: JSON.stringify(breadcrumbs, null, 2),
      kind: "sqlpage_file_upsert",
      asErrorContents: errorAsJSON,
    } satisfies SqlPageFile;
    yield {
      path: "spry.d/auto/route/edges.auto.json",
      contents: JSON.stringify(edges, null, 2),
      kind: "sqlpage_file_upsert",
      asErrorContents: errorAsJSON,
    } satisfies SqlPageFile;
  }

  async *finalSqlPageFileEntries(opts: { md: string[] }) {
    const directives = new InfoDirectiveCells();
    const baseCtx = {
      sitePrefixed: (sqlClause: string) =>
        `(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX') || ${sqlClause})`,
      partial: (name: string) =>
        directives.partials.find((p) => p.infoDirective.identity == name)
          ?.source ?? `/* partial '${name}' not found in directives */`,
    };

    for await (const spf of this.rawSqlPageFileEntries(opts, directives)) {
      const { path } = spf;

      // ctx is for interpolation so it won't be used locally but in the interpolation (maybe)
      const ctx = { ...spf, ...spf.cell?.attrs, ...baseCtx };
      try {
        const layout = spf.isLayoutCandidate
          ? directives.layouts.findLayout(path)
          : undefined;

        if (spf.isUnsafeInterpolatable) {
          const source = layout ? layout.wrap(spf.contents) : spf.contents;

          // Escape backticks and backslashes so we can embed `source` inside a template literal
          const safe = source.replace(/\\/g, "\\\\").replace(/`/g, "\\`");

          // Direct eval runs in the current scope (locals in this block) and we .call(this)
          // so `${this.*}` inside the template works too.
          // NOTE: This is intentionally unsafe. Do not feed untrusted content.
          const mutated = eval(
            `(function() { return \`${safe}\`; }).call(this)`,
          );

          if (mutated !== spf.contents) {
            (spf as Any).contents = String(mutated);
            (spf as Any).isInterpolated = true;
          }
        } else if (layout) {
          (spf as Any).contents = layout.wrap(spf.contents);
        }

        if (layout) (spf as Any).layout = layout;
        yield spf;
      } catch (error) {
        (spf as Any).isSqlPageFileError = error;
        yield {
          ...spf,
          contents: spf.asErrorContents(
            `finalSqlPageFileEntries error: ${String(error)}\n*****\n${
              JSON.stringify({ ctx, spf }, null, 2)
            }`,
            error,
          ),
        };
      }
    }
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
    for await (const spf of this.finalSqlPageFileEntries(opts)) {
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
    const list = await Array.fromAsync(this.finalSqlPageFileEntries(opts));

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
