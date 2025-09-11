#!/usr/bin/env -S deno run -A 

import { getTableName } from "npm:drizzle-orm@0.44.5";
import { sqliteModels } from "../../../lib/std/lib/models.ts";
import { cli } from "./e2ectl.ts";

const { sqlpageFiles } = sqliteModels();

await cli.head();

console.log(`-- ${getTableName(sqlpageFiles)} rows --`);
await cli.emitSqlPageFiles();

await cli.tail();
