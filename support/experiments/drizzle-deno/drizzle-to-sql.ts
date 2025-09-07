// This script is a **minimal demonstration** of how to use Drizzle ORM
// in an **SQL-first** and **typesafe** way, similar to tools like SQL Aide.
//
// The key idea here is that Drizzle can act as a **SQL generator** rather than
// immediately executing queries against a SQLite database. By defining tables,
// indexes, relationships, and constraints in TypeScript, you get full type
// safety while still working directly with SQL under the hood.
//
// This script shows how to:
//   • Define tables and relationships using Drizzle's SQLite core API
//   • Generate SQL queries safely using Drizzle's `QueryBuilder`
//   • Produce database migration SQL from schema differences using `drizzle-kit`
//   • Use Drizzle to prepare `.toSQL()` statements without actually executing them
//
// This is especially useful when you want to:
//   • Design your schema and generate migrations before connecting to a live DB
//   • Inspect SQL queries for logging, debugging, or code review purposes
//   • Use Drizzle as a **type-safe SQL generator** and defer execution until later
//
// Note: As of 08-23-2025, there’s a temporary workaround needed before using
// `drizzle-kit/api` with Deno 2.4+:
//    1. Run once: `deno install` (this will cache what's in `deno.json`)
//    2. Then run: `deno run -A --node-modules-dir ./drizzle-to-sql.ts`
//
// See these discussions for more details:
//    • https://github.com/drizzle-team/drizzle-orm/discussions/3162
//    • https://github.com/drizzle-team/drizzle-orm/discussions/1901
//
// TL;DR: This script focuses on **learning Drizzle's typesafe query
// generation** and **migration tooling** without requiring a persistent database.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import {
  AnySQLiteColumn,
  QueryBuilder,
  sqliteTable as table,
} from "npm:drizzle-orm/sqlite-core";
import { drizzle } from "npm:drizzle-orm/libsql";
import * as d from "npm:drizzle-orm/sqlite-core";
const {
  generateSQLiteDrizzleJson: generateDrizzleJson,
  generateSQLiteMigration: generateMigration,
} = require(
  "drizzle-kit/api",
) as typeof import("npm:drizzle-kit/api");
import { eq } from "npm:drizzle-orm";

function generateUniqueString(length: number = 12): string {
  const characters =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let uniqueString = "";

  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * characters.length);
    uniqueString += characters[randomIndex];
  }

  return uniqueString;
}

export const users = table(
  "users",
  {
    id: d.int().primaryKey({ autoIncrement: true }),
    firstName: d.text("first_name"),
    lastName: d.text("last_name"),
    email: d.text().notNull(),
    invitee: d.int().references((): AnySQLiteColumn => users.id),
    role: d.text().$type<"guest" | "user" | "admin">().default("guest"),
  },
  (table) => [
    d.uniqueIndex("email_idx").on(table.email),
  ],
);

export const posts = table(
  "posts",
  {
    id: d.int().primaryKey({ autoIncrement: true }),
    slug: d.text().$default(() => generateUniqueString(16)),
    title: d.text(),
    ownerId: d.int("owner_id").references(() => users.id),
  },
  (table) => [
    d.uniqueIndex("slug_idx").on(table.slug),
    d.index("title_idx").on(table.title),
  ],
);

export const comments = table("comments", {
  id: d.int().primaryKey({ autoIncrement: true }),
  text: d.text({ length: 256 }),
  postId: d.int("post_id").references(() => posts.id),
  ownerId: d.int("owner_id").references(() => users.id),
});

const qb = new QueryBuilder();
console.log(qb.select().from(users).where(eq(users.id, 1)).toSQL());

const currentSchema = { users, posts, comments };

// Generate migration SQL from an empty schema to your current schema
const previousSchema = {};

const migrationStatements = await generateMigration(
  await generateDrizzleJson(previousSchema),
  await generateDrizzleJson(currentSchema),
);

console.log(migrationStatements.join("\n"));

// type NewUser = typeof users.$inferInsert;
// const newUser: NewUser = { email: "me@gmail.com" };

const db = drizzle({ connection: { url: ":memory:" } });
console.log(
  db.insert(users).values({ email: "me@gmail.com" }).returning()
    .toSQL(),
);
console.log(
  db.insert(posts).values({ title: "My Title" }).returning()
    .toSQL(),
);
