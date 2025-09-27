import { Engine } from "../../../lib/engine-next/mod.ts";

const engine = Engine.instance(
  "e2e-prime",
  import.meta.resolve("./"),
  "../../../lib/std",
);
await engine.materialize();

// console.dir(
//   (await Promise.all(
//     engine.state.fcDiscovered!.walkedFiles.map(async (f) =>
//       `${f.relFsPath}${await f.isExecutable() ? "*" : ""} ${f.webPath}`
//     ),
//   )).join("\n"),
// );
