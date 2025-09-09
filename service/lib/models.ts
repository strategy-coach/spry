import { sql } from "npm:drizzle-orm@0.44.5";
import {
  foreignKey,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "npm:drizzle-orm@0.44.5/sqlite-core";

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

  const spryNavigation = sqliteTable(
    "spry_navigation",
    {
      // The unique "path" of this node within its namespace
      path: text("path").notNull(),

      // Human-friendly display name
      caption: text("caption").notNull(),

      // Navigation namespace (allows multiple independent trees)
      namespace: text("namespace").notNull(),

      // Parent path for hierarchy, nullable for root nodes
      parentPath: text("parent_path"),

      // Orders children within their parent (lower = higher priority)
      siblingOrder: integer("sibling_order"),

      // Optional override URL for custom links
      url: text("url"),

      // Full title for elaborate descriptions, defaults to caption if NULL
      title: text("title"),

      // Shortened caption for breadcrumbs; defaults to caption if NULL
      abbreviatedCaption: text("abbreviated_caption"),

      // Longer description or summary text
      description: text("description"),

      // Extended elaboration, e.g. JSON attributes like `{ "target": "__blank", "lang": { "fr": { "caption": "hello" } } }`
      elaboration: text("elaboration"),
    },
    (table) => ({
      // Composite uniqueness constraint across namespace, parent, and path
      unqNsPath: uniqueIndex("unq_ns_path").on(
        table.namespace,
        table.parentPath,
        table.path,
      ),

      // Composite foreign key: (namespace, parent_path) → (namespace, path)
      fkParentPath: foreignKey({
        columns: [table.namespace, table.parentPath],
        foreignColumns: [table.namespace, table.path],
        name: "fk_parent_path",
      }),
    }),
  );

  return {
    sqlpageFiles,
    spryNavigation,
  };
}
