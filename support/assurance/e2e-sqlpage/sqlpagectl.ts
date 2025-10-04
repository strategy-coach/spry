#!/usr/bin/env -S deno run -A 

import {
  assemblerBusesInit,
  Resource,
  SideAffects,
} from "../../../lib/assembler/mod.ts";
import { SqlPageAssembler, SqlPageCLI } from "../../../lib/sqlpage/mod.ts";

// rename SqlPageStarter class to your project name
// change line 12 from `e2e-sqlpage` to your own project ID

export class SqlPageStarter extends SqlPageAssembler<Resource> {
  constructor(
    init: { sideAffectsAllowed: SideAffects; cleaningRequested?: boolean },
  ) {
    super(
      "e2e-sqlpage",
      import.meta.resolve("./"),
      assemblerBusesInit(),
      "../../../lib/sqlpage/std",
      init,
    );
  }
}

if (import.meta.main) {
  if (Deno.args.length) {
    await new SqlPageCLI((init) => new SqlPageStarter(init)).cli()
      .parse(Deno.args);
  } else {
    await new SqlPageStarter({ sideAffectsAllowed: { materialize: true } })
      .materialize();
  }
}
