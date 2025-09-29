#!/usr/bin/env -S deno run -A 

import {
  Assembler,
  assemblerBusesInit,
  CLI,
  Resource,
} from "../../../lib/assembler/mod.ts";

export class EndToEndTestPrime extends Assembler<Resource> {
  constructor() {
    super(
      "e2e-prime",
      import.meta.resolve("./"),
      "../../../lib/std",
      assemblerBusesInit(),
    );
  }
}

if (import.meta.main) {
  const e2e = new EndToEndTestPrime();
  if (Deno.args.length) {
    await new CLI(e2e).cli().parse(Deno.args);
  } else {
    await e2e.materialize();
  }
}
