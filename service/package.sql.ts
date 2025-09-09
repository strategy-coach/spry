#!/usr/bin/env -S deno run -A 

import { getTableName } from "npm:drizzle-orm@0.44.5";
import { sqliteModels } from "../service/lib/models.ts";
import * as ctl from "./spryctl.ts";

const { spryNavigation, sqlpageFiles } = sqliteModels();

console.log(`-- ${getTableName(sqlpageFiles)} rows --`);
await ctl.emitSqlPageFiles();

console.log(`-- ${getTableName(spryNavigation)} rows --`);
await ctl.emitRoutesSQL();
