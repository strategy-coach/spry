import { sql } from "drizzle-orm";
import {
  foreignKey,
  integer,
  sqliteTable as table,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const sqlpageFiles = table("sqlpage_files", {
  // Path to the file — acts as the primary key
  path: text("path").primaryKey().notNull(),

  // File contents stored as TEXT
  contents: text("contents").notNull(),

  // Last modified timestamp, defaults to CURRENT_TIMESTAMP
  lastModified: text("last_modified")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

export const spryNavigation = table(
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
