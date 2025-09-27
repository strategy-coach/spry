import { MaterializationEngine } from "../../../lib/engine-next/mod.ts";

const engine = MaterializationEngine.instance(
  import.meta.resolve("./"),
  "../../../lib/std",
);
await engine.materialize();

console.dir(
  (await Promise.all(
    engine.state.fcDiscovered!.walkedFiles.map(async (f) =>
      `${f.relFsPath}${await f.isExecutable() ? "*" : ""} ${f.webPath}`
    ),
  )).join("\n"),
);
