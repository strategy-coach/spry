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
  head: {
    sources: [{
      root: "../../../lib/std/lib",
      include: ["sqlpage-files.ddl.sql"],
      baseDir,
    }],
    // deno-fmt-ignore
    emitContent: async (src) =>
      `--- head: ${src.relPath} ---\n${await Deno.readTextFile(src.path)}\n--- head end: ${src.relPath} ---\n`,
  },
  tail: {
    sources: [{
      root: "../../../lib/std/lib",
      include: ["schema-info.dml.sql"],
      baseDir,
    }],
    // deno-fmt-ignore
    emitContent: async (src) =>
      `--- tail: ${src.relPath} ---\n${await Deno.readTextFile(src.path)}\n--- tail end: ${src.relPath} ---\n`,
  },
});

if (import.meta.main) {
  await cli.command.parse(Deno.args);
}
