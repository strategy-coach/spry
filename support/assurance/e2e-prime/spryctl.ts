#!/usr/bin/env -S deno run -A 

import { fromFileUrl } from "jsr:@std/path@1";
import * as o from "../../../lib/std/orchestrate.ts";

export class EndToEndTestPrime extends o.Plan {
  constructor() {
    super(o.projectPaths(
      fromFileUrl(import.meta.resolve("./")),
      "../../../lib/std",
    ));
  }
}

if (import.meta.main) {
  const e2e = new EndToEndTestPrime();
  if (Deno.args.length > 0) {
    await new o.CLI(e2e).cli().parse(Deno.args);
  } else {
    await new o.SQL(e2e).toStdOut();
  }
}
