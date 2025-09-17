#!/usr/bin/env -S deno run -A 

import { fromFileUrl } from "jsr:@std/path@1";
import * as o from "../../../lib/std/orchestrate.ts";

export class EndToEndTestPrime extends o.Orchestrator {
  constructor() {
    super(fromFileUrl(import.meta.resolve("./")));
  }
}

const e2e = new EndToEndTestPrime();
await e2e.orchestrate({ clean: true });
