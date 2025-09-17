#!/usr/bin/env -S deno run -A 

import { fromFileUrl } from "jsr:@std/path@1";
import * as o from "../../../lib/std/orchestrate.ts";

export class EndToEndTestPrime extends o.Orchestrator<o.OrchestrationContext> {
  constructor() {
    super(fromFileUrl(import.meta.resolve("./")));
  }
}

const e2e = new EndToEndTestPrime();
for await (const ai of e2e.annotations()) {
  console.log(
    ai.entryAnn.found,
    ai.routeAnn.found,
  );
}
