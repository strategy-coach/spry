import { sql } from "npm:drizzle-orm@0.44.5";
import {
  check,
  SQLiteColumn,
  sqliteTable,
  text,
} from "npm:drizzle-orm@0.44.5/sqlite-core";

export function sqliteModels() {
  const checkJSON = (c: SQLiteColumn) =>
    check(`${c.name}_check_valid_json`, sql`json_valid(${c}) OR ${c} IS NULL`);

  const sqlpageFiles = sqliteTable("sqlpage_files", {
    // Path which SQLPage translates from URL to `contents`
    path: text().primaryKey().notNull(),

    // SQLPage file contents for rendering
    contents: text().notNull(),

    // Last modified timestamp for SQLPage to auto-refresh, defaults to CURRENT_TIMESTAMP
    lastModified: text("last_modified")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),

    // 👆 path, contents, and lastModified are used by SQLPage
    // 👇 the remainder of the fields below are for Spry

    // the kind of content (page, api, action, sql-sp), denormalized from @spry.nature annotation
    nature: text().notNull().default("page"),

    // if any @spry or @route annotations, they are stored here
    annotations: text(),

    // custom data for use by the app
    elaboration: text(),
  }, (table) => [
    checkJSON(table.annotations),
    checkJSON(table.elaboration),
  ]);

  return {
    sqlpageFiles,
  };
}
