#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run --allow-sys
import { console as c, shell as sh } from "./web-ui-content/mod.ts";
import * as spn from "./notebook/sqlpage.ts";

export async function SQL() {
  return await spn.TypicalSqlPageNotebook.SQL(
    new sh.ShellSqlPages(),
    new c.ConsoleSqlPages(),
  );
}
// this will be used by any callers who want to serve it as a CLI with SDTOUT
if (import.meta.main) {
  console.log((await SQL()).join("\n"));
}
