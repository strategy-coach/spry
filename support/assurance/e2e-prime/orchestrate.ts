#!/usr/bin/env -S deno run -A 

import { fromFileUrl } from "jsr:@std/path@1";
import * as o from "../../../lib/std/orchestrate.ts";

export class EndToEndTestPrime extends o.Orchestrator {
  constructor() {
    super(fromFileUrl(import.meta.resolve("./")));
  }
}

if (import.meta.main) {
  const e2e = new EndToEndTestPrime();
  if (Deno.args.length > 0) {
    await e2e.cli(import.meta.resolve("./")).parse(Deno.args);
  } else {
    await e2e.orchestrate({ clean: true });
  }
}
