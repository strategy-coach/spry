import { Engine, engineBusesInit } from "../../../lib/engine-bus/mod.ts";

const buses = engineBusesInit();

buses.resources.on.materializedInclude((ev) => {
  if (ev.contentState === "modified") {
    console.log(
      "include",
      ev.engineState.workflow.step,
      ev.resource.nature,
      ev.contentState,
      ev.replacerResult.changed,
      ev.written,
    );
  }
});

buses.resources.on.materializedFoundry((ev) => {
  console.log(
    "foundry",
    ev.engineState.workflow.step,
    ev.resource.nature,
    ev.matAbsFsPath,
  );
});

// buses.resources.on.resource((ev) => {
//   console.log(
//     ev.engineState.workflow.step,
//     ev.resource.nature,
//     ev.resource.isSystemGenerated,
//   );
// });

// buses.resources.all((type, detail) => {
//   console.dir({ type, detail });
// });

const engine = Engine.instance(
  "e2e-prime",
  import.meta.resolve("./"),
  "../../../lib/std",
  buses,
);
await engine.materialize();
