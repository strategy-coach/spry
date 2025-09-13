```bash
# package '@libsql/client' used by Drizzle ORM requires installation first
deno install

# e2ectl.ts lets you perform different controller functions
./e2ectl.ts help

# setup
spry init                      # TODO: generate `e2ectl.ts` in CWD, setup symlinks, egenerate `on_connect.sql`,
                               #       setup SQLite extensions, etc.

# informational
./e2ectl.ts ls                 # list all candidate sqlpage_files content files and if there are any annotation errors
./e2ectl.ts ls --tree          # TODO: list all candidate sqlpage_files content files as a tree
./e2ectl.ts ls head            # list all SQL DDL for "init" operations that go before sqlpage_files inserts
./e2ectl.ts ls tail            # list all SQL DDL for "finalization" operations that go after sqlpage_files inserts
./e2ectl.ts ls routes          # list all discovered files that have route annotations as a tree
./e2ectl.ts ls routes -t       # list all discovered files that have route annotations as a table
./e2ectl.ts ls routes -j       # list all discovered files that have route annotations as JSON
./e2ectl.ts ls breadcrumbs     # list all discovered files that have route annotations as breadcrumbs

# emit SQL
./e2ectl.ts sql head           # generate the SQL (usually DDL or DML, not SQL) that go before sqlpage_files inserts
./e2ectl.ts sql tail           # generate the SQL (usually DDL or DML, not SQL) that go after sqlpage_files inserts
./e2ectl.ts sql sqlpage-files  # generate the INSERT SQL DML for sqlpage_files contents

# developer experience
./e2ectl.ts dx watchexec       # TODO: generate watchexec CLI for bash to watch all roots / files / etc.

# deployment
# generates all "head", sqlpage-files, *.auto.json, and "tail" SQL to STDOUT
./package.sql.ts > sqlpage-package.sql
./package.sql.ts | sqlite3 sqlpage.db
```

WIP

- [ ] Support mix of SQLite and PostgreSQL in the same `app` (annotations, file extensions, file names, etc.)
- [ ] Use `on_connect.sql` to initialize the `app` (add annotations for truly dynamic)
- [ ] Add experiment to generate and insert a new page in `sqlpage_files` and then redirect to it
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
