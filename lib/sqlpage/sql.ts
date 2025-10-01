import { relative } from "jsr:@std/path@1";
import { walk, WalkEntry, WalkOptions } from "jsr:@std/fs@1/walk";
import { eq, getTableName, sql } from "npm:drizzle-orm@0.44.5";
import { drizzle } from "npm:drizzle-orm@0.44.5/libsql";
import {
  check,
  SQLiteColumn,
  sqliteTable,
  text,
} from "npm:drizzle-orm@0.44.5/sqlite-core";
import { provenanceText } from "../universal/reflect/provenance.ts";
import { inlinedSQL } from "../universal/sql-text.ts";

// create a basic SQLite model for Drizzle to use :memory: db to generate seed SQL
export function sqliteModels() {
  const checkJSON = (c: SQLiteColumn) =>
    check(
      `${c.name}_check_valid_json`,
      sql`json_valid(${c}) OR ${c} IS NULL`,
    );

  const sqlpageFiles = sqliteTable("sqlpage_files", {
    // web path which SQLPage translates from URL to `contents`
    path: text().primaryKey().notNull(),

    // SQLPage file contents for rendering
    contents: text().notNull(),

    // Last modified timestamp for SQLPage to auto-refresh, defaults to CURRENT_TIMESTAMP
    lastModified: text("last_modified")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  });

  return {
    checkJSON,
    sqlpageFiles,
  };
}

export class SqlSupplier {
  readonly relativeToCWD = (path: string) => relative(Deno.cwd(), path);

  constructor(
    readonly paths: ({
      readonly nature:
        | "Head SQL Statements"
        | "Tail SQL Statements";
      readonly rootPath: string;
      readonly walkOptions?: WalkOptions;
      readonly emitWalkPathProvenance?: boolean;
    } | {
      readonly nature: "sqlpage_files Table Candidates";
      readonly rootPath: string;
      readonly walkOptions?: WalkOptions;
      readonly "sqlpage_files Table path": (we: WalkEntry) => string;
    })[],
  ) {
  }

  get provenanceHint() {
    return provenanceText({
      importMetaURL: import.meta.url,
      framesToSkip: 2,
    });
  }

  async *sqlFilesContent(
    nature: "Head SQL Statements" | "Tail SQL Statements",
    emitFnProvenance: boolean,
  ) {
    const walkers = this.paths.filter((p) => p.nature === nature);
    if (walkers.length) {
      if (emitFnProvenance) {
        yield `-- ${nature} in ${this.provenanceHint} (begin)`;
      }
      for (const w of walkers) {
        const emitProv = w.nature !== "sqlpage_files Table Candidates"
          ? w.emitWalkPathProvenance
          : false;
        try {
          for await (const we of walk(w.rootPath, w.walkOptions)) {
            if (emitProv) {
              yield `-- ${nature} from ${this.relativeToCWD(we.path)} (begin)`;
            }
            yield Deno.readTextFile(we.path);
            if (emitProv) {
              yield `-- ${nature} from ${this.relativeToCWD(we.path)} (end)`;
            }
          }
        } catch (err) {
          if (err instanceof Deno.errors.NotFound) {
            // deno-fmt-ignore
            yield `-- Walker root ${this.relativeToCWD(w.rootPath)} not found (${this.provenanceHint})`;
          } else {
            // deno-fmt-ignore
            yield `-- Error: ${String(err)} in walker ${this.relativeToCWD(w.rootPath)} (${this.provenanceHint})`;
          }
        }
      }
      if (emitFnProvenance) {
        yield `-- ${nature} in ${this.provenanceHint} (end)`;
      }
    } else {
      if (emitFnProvenance) yield `-- No ${nature} in ${this.provenanceHint}`;
    }
  }

  async *sqlPageFilesInserts() {
    const { sqlpageFiles: sqlpageFilesTable } = sqliteModels();
    //type SqlPageFileRow = typeof sqlpageFilesTable.$inferInsert;

    // needed for drizzle-orm with @libsql/client because it doesn't generate SQL without it
    const db = drizzle({ connection: { url: ":memory:" } });
    for (const w of this.paths) {
      if (w.nature !== "sqlpage_files Table Candidates") continue;
      try {
        for await (const we of walk(w.rootPath, w.walkOptions)) {
          const path = w["sqlpage_files Table path"](we);
          yield inlinedSQL(
            db.delete(sqlpageFilesTable).where(
              eq(sqlpageFilesTable.path, path),
            ).toSQL(),
          );
          yield inlinedSQL(
            db.insert(sqlpageFilesTable).values({
              path: path,
              contents: await Deno.readTextFile(we.path),
            }).toSQL(),
          );
        }
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) {
          // deno-fmt-ignore
          yield `-- Walker root ${this.relativeToCWD(w.rootPath)} not found (${this.provenanceHint})`;
        } else {
          // deno-fmt-ignore
          yield `-- Error: ${String(err)} in walker ${this.relativeToCWD(w.rootPath)} (${this.provenanceHint})`;
        }
      }
    }
  }

  async *SQL() {
    const { sqlpageFiles } = sqliteModels();

    yield* this.sqlFilesContent("Head SQL Statements", true);

    yield `-- ${getTableName(sqlpageFiles)} rows (${this.provenanceHint}) --`;
    yield* this.sqlPageFilesInserts();

    yield* this.sqlFilesContent("Tail SQL Statements", true);
  }

  async toStdOut() {
    for await (const sql of this.SQL()) {
      console.log(sql);
    }
  }
}
