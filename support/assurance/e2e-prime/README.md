```bash
# package '@libsql/client' used by Drizzle ORM requires installation first
deno install

# e2ectl.ts lets you perform different controller functions
./e2ectl.ts help
./e2ectl.ts ls                 # list all discovered files and if there are any annotation errors
./e2ectl.ts ls init            # list all SQL DDL for "init" operations
./e2ectl.ts ls final           # TODO: list all SQL DDL for "finalization" operations
./e2ectl.ts ls routes          # list all discovered files that have route annotations as a tree
./e2ectl.ts ls routes -t       # list all discovered files that have route annotations as a table
./e2ectl.ts ls routes -j       # list all discovered files that have route annotations as JSON
./e2ectl.ts ls breadcrumbs     # list all discovered files that have route annotations as breadcrumbs
./e2ectl.ts sql init           # generate the SQL DDL for "init" operations
./e2ectl.ts sql final          # TODO: generate the SQL DDL for "finalization" operations
./e2ectl.ts sql sqlpage-files  # generate the INSERT SQL DML for sqlpage_files contents
./e2ectl.ts bash watchexec     # TODO: generate watchexec CLI for bash to watch all roots / files / etc.

# package.sql.ts generates a complete idempotent SQL package
# generates all "init", routes, sqlpage-files, and "final" SQL
./package.sql.ts > sqlpage-package.sql
./package.sql.ts | sqlite3 sqlpage.db
```

WIP

- [ ] Create `lib/route/mod.auto.sql` which is a partial that is included in
      SQLPage for constants
- [ ] Build a FUSE layer for browsing sqlpage_files and any RSSD
- [ ] Find out why `children` are missing
- [ ] Generate Zod schemas for routes.auto.json
- [ ] Generate JSON Schema for all generated JSON (annotations from Zod, routes,
      etc.)
- [ ] Explain working with SQLPage "live reload" (symlink `std` to CWD/`spry`
      and start sqlpage); use watchexec
- [ ] Add `lint` CLI command to check if `page` types have typical includes
      (shell, etc.)
- [ ] [Introduce Middleware into Spry](https://github.com/sqlpage/SQLPage/discussions/584)
- [ ] [Introduce Custom Layout](https://github.com/sqlpage/SQLPage/blob/main/sqlpage/templates/shell.handlebars)
      [(discussion)](https://github.com/sqlpage/SQLPage/discussions/731)
- [ ] [HTMLx integration](https://github.com/sqlpage/SQLPage/discussions/628)
- [ ] [Consider dynamic search pages through codegen](https://github.com/sqlpage/SQLPage/discussions/699)
