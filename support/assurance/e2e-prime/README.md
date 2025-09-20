```bash
# package '@libsql/client' used by Drizzle ORM requires installation first
deno install

# setup symlink to Spry stdlib
./spryctl.ts init               # only required once, creates `sqlpage/sqlpage.json` and `src/spry` symlink

# spryctl.ts lets you perform different functions
./spryctl.ts help
./spryctl.ts dev                # launch SQLpage binary and reload SQLite content on file changes

# informational
./spryctl.ts ls                 # TODO: list all candidate sqlpage_files content files and if there are any annotation errors
./spryctl.ts ls ann             # TODO: list all candidate sqlpage_files that have been annotated with `@spry.*`
./spryctl.ts ls cap-execs       # list all capturable executables
./spryctl.ts ls --tree          # TODO: list all candidate sqlpage_files content files as a tree
./spryctl.ts ls head            # list names of files which will generate SQL DDL/DML for "init" operations that go before sqlpage_files inserts
./spryctl.ts ls tail            # list names of files which will generate SQL DDL/DML for "finalization" operations that go after sqlpage_files inserts
./spryctl.ts ls routes          # list all discovered files that have route annotations as a tree
./spryctl.ts ls routes -t       # list all discovered files that have route annotations as a table
./spryctl.ts ls routes -j       # list all discovered files that have route annotations as JSON
./spryctl.ts ls breadcrumbs     # list all discovered files that have route annotations as breadcrumbs

# emit SQL
./spryctl.ts sql head           # generate the SQL (usually DDL or DML, not SQL) that go before sqlpage_files inserts
./spryctl.ts sql tail           # generate the SQL (usually DDL or DML, not SQL) that go after sqlpage_files inserts
./spryctl.ts sql sqlpage-files  # generate the INSERT SQL DML for sqlpage_files contents
./spryctl.ts sql deploy         # generate the full deployment package (all the above)

# deployment
# generates all "head", sqlpage-files, *.auto.json, and "tail" SQL to STDOUT
./spryctl.ts > sqlpage-package.sql
./spryctl.ts | sqlite3 sqlpage.db
```

### TODO: explain how `spry.d` fits in

- Purpose: `spry.d` acts as a drop-in _distribution_ directory for modular,
  extendable annotation, route, breadcrumbs, and other generated files.
- Contents: Inside `spry.d`, you can have SQL, JSON, or other files that Spry
  generates and it becomes available to SQLPage.
- Role: These files are not just “extras” — they’re actually required at runtime
  by SQLPage as part of its normal distribution.

So instead of one giant config or schema, SQLPage can simply read everything in
`spry.d` and use those pieces together. This makes the setup clean, modular, and
easy to extend — exactly in line with the `.d` convention elsewhere on Linux.

When SQLPage starts up it sees `spry.d/` as just another directory where it can
pick up web contents.

- ⚠️ `spry.d` is not meant for _non_-spry content because it's deleted
  recursively and recreated each time the build occurs. It's basically a
  _distribution_ directory. It's not safe for project-level files, it's for
  `spry` only.
- 👉 If you want to do something similar for your project you can create
  `project.d` similarly and manage it on your own.

### Why this is useful for SQLPage

1. Modularity – You can drop in new SQL or JSON snippets without touching core
   SQLPage code.
2. Extendability – Developers can add functionality just by generating files in
   `spry.d`.
3. Runtime requirements – Since SQLPage needs these generated files to function
   properly, `spry.d` ensures they’re always available and loaded consistently.
4. Convention – Following the familiar `.d` pattern makes it easier for Linux
   users/admins to understand what’s going on.

✅ In short: `spry.d` is SQLPage’s drop-in _distribution_ directory. Whatever
goes in there (SQL, JSON, or other generated artifacts from Spry) becomes part
of the runtime environment for SQLPage under the web path `/spry.d/**`. It’s the
same modular, extendable configuration approach you see with `conf.d`, just
applied to SQLPage’s distribution.

---

WIP

- [ ] Convert `auto.json` or any other file generators to their `*.json.ts`
      counterparts to remove dependencies. for example,
      `spry/lib/forest.d/spry.auto.json` would come from
      `spry/lib/forest.d/spry.json.ts` in "capturable executable" style
      (emitting STDOUT, for example) but excluded from `package.sql.ts` when
      built. for example, `spry/templates/abc.handlebars.ts` would generate
      `spry/templates/abc.handlebars` during build `orchestrate.ts build` and
      then get picked up by package.json. Same for `*.sql.ts`, etc.
- [ ] Support mix of SQLite and PostgreSQL in the same `app` (annotations, file
      extensions, file names, etc.)
- [ ] Use `on_connect.sql` to initialize the `app` (add annotations for truly
      dynamic)
- [ ] Add experiment to generate and insert a new page in `sqlpage_files` and
      then redirect to it
- [ ] Consider how to integrate RUNME.md (as replacement for package.sql.ts?)
- [ ] Create `lib/route/mod.auto.sql` which is a partial that is included in
      SQLPage for constants
- [ ] Build a FUSE layer for browsing sqlpage_files and any RSSD
- [ ] Explain working with SQLPage "live reload" (symlink `std` to CWD/`spry`
      and start sqlpage); use watchexec
- [ ] Add `lint` CLI command to check if `page` types have typical includes
      (shell, etc.)
- [ ] [Introduce Middleware into Spry](https://github.com/sqlpage/SQLPage/discussions/584)
- [ ] [Introduce Custom Layout](https://github.com/sqlpage/SQLPage/blob/main/sqlpage/templates/shell.handlebars)
      [(discussion)](https://github.com/sqlpage/SQLPage/discussions/731)
- [ ] [HTMLx integration](https://github.com/sqlpage/SQLPage/discussions/628)
- [ ] [Consider dynamic search pages through codegen](https://github.com/sqlpage/SQLPage/discussions/699)
