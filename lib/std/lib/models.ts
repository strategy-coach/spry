import { sql } from "npm:drizzle-orm@0.44.5";
import { sqliteTable, text } from "npm:drizzle-orm@0.44.5/sqlite-core";

export function sqliteModels() {
  const sqlpageFiles = sqliteTable("sqlpage_files", {
    // Path to the file — acts as the primary key
    path: text("path").primaryKey().notNull(),

    // File contents stored as TEXT
    contents: text("contents").notNull(),

    // Last modified timestamp, defaults to CURRENT_TIMESTAMP
    lastModified: text("last_modified")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),

    // 👆 path, contents, and lastModified are used by SQLPage
    // the remainder of the fields below are for Spry

    // the kind of content (page, api, action, sql-sp)
    nature: text().notNull().default("page"),
    annotations: text(), // TODO: JSON
  });

  return {
    sqlpageFiles,
  };
}
