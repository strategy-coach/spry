#!/usr/bin/env -S deno run -A 

import {
  CLI,
  Engine,
  engineBusesInit,
  Resource,
} from "../../../lib/engine-bus/mod.ts";

export class EndToEndTestPrime extends Engine<Resource> {
  constructor() {
    super(
      "e2e-prime",
      import.meta.resolve("./"),
      "../../../lib/std",
      engineBusesInit(),
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
