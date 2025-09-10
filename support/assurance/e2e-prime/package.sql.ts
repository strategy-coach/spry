#!/usr/bin/env -S deno run -A 

import { getTableName } from "npm:drizzle-orm@0.44.5";
import { sqliteModels } from "../../../lib/std/lib/models.ts";
import { cli } from "./e2ectl.ts";

const { sqlpageFiles } = sqliteModels();

console.log(`-- ${getTableName(sqlpageFiles)} rows --`);
await cli.emitSqlPageFiles();

console.log(`\n-- execute typical "stored procedures" --`);
console.log(
  await Deno.readTextFile("./core/console/lib/populate-table-content.sql"),
);
console.log(
  await Deno.readTextFile("./core/console/lib/populate-spry-table-info.sql"),
);
