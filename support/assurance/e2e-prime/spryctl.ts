#!/usr/bin/env -S deno run -A 

import { fromFileUrl } from "jsr:@std/path@1";
import * as e from "../../../lib/engine/mod.ts";

export class EndToEndTestPrime extends e.Plan {
  constructor() {
    super(e.projectPaths(
      fromFileUrl(import.meta.resolve("./")),
      "../../../lib/std",
    ));
  }
}

if (import.meta.main) {
  const e2e = new EndToEndTestPrime();
  if (Deno.args.length > 0) {
    await new e.CLI(e2e).cli().parse(Deno.args);
  } else {
    await new e.DeploySQL(e2e).toStdOut();
  }
}
