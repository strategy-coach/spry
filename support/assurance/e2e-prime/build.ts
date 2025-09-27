import { MaterializationEngine } from "../../../lib/engine-next/materialize.ts";

const engine = MaterializationEngine.instance(
  import.meta.resolve("./"),
  "../../../lib/std",
);
await engine.discover();

console.dir(
  (await Promise.all(
    engine.state.fc.walkedFiles.map(async (f) =>
      `${f.relFsPath}${await f.isExecutable() ? "*" : ""} ${f.webPath}`
    ),
  )).join("\n"),
);
