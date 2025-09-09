#!/usr/bin/env -S deno run -A 

import { getTableName } from "npm:drizzle-orm@0.44.5";
import { sqliteModels } from "../service/lib/models.ts";
import * as ctl from "./spryctl.ts";

const { spryNavigation, sqlpageFiles } = sqliteModels();

console.log(`-- ${getTableName(sqlpageFiles)} rows --`);
await ctl.emitSqlPageFiles();

console.log(`\n-- ${getTableName(spryNavigation)} rows --`);
await ctl.emitRoutesSQL();

console.log(`\n-- execute typical "stored procedures" --`);
console.log(
  await Deno.readTextFile("./spry/console/lib/populate-table-content.sql"),
);
console.log(
  await Deno.readTextFile("./spry/console/lib/populate-spry-table-info.sql"),
);
