#!/usr/bin/env -S deno run -A 

import { assemblerBusesInit, Resource } from "../../../lib/assembler/mod.ts";
import { SqlPageAssembler, SqlPageCLI } from "../../../lib/sqlpage/mod.ts";

export class EndToEndTestPrime extends SqlPageAssembler<Resource> {
  constructor(init: { dryRun: boolean; cleaningRequested: boolean }) {
    super(
      "e2e-prime",
      import.meta.resolve("./"),
      assemblerBusesInit(),
      "../../../lib/std",
      init,
    );
  }
}

if (import.meta.main) {
  if (Deno.args.length) {
    await new SqlPageCLI((init) => new EndToEndTestPrime(init)).cli().parse(
      Deno.args,
    );
  } else {
    await new EndToEndTestPrime({ dryRun: false, cleaningRequested: false })
      .materialize();
  }
}
