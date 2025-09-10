#!/usr/bin/env -S deno run -A 

import { dirname, fromFileUrl } from "jsr:@std/path@1";
import { CLI } from "../../../lib/std/lib/cli.ts";

const baseDir = dirname(fromFileUrl(import.meta.url));
export const cli = CLI({
  roots: [{
    root: "../../../lib",
    include: ["std/**/*.sql"],
    baseDir,
  }, {
    root: ".",
    include: ["**/*.sql"],
    baseDir,
  }],
  sqlpageFilesPath: (path) => path.replace(/^std\//, "spry/"),
  init: {
    sources: [{
      root: "../../../lib/std/lib",
      include: ["schema-info.ddl.sql", "sqlpage-files.ddl.sql"],
      baseDir,
    }],
    // deno-fmt-ignore
    emitContent: async (src) =>
      `--- init: ${src.relPath} ---\n${await Deno.readTextFile(src.path)}\n--- init end: ${src.relPath} ---\n`,
  },
});

if (import.meta.main) {
  await cli.command.parse(Deno.args);
}
