import { eventBus, EventMap } from "./event-bus.ts";

Deno.test("eventBus comprehensive tests", async (t) => {
  interface AppEvents extends EventMap {
    ready: void;
    tick: number;
    user: { id: string; name: string };
  }

  await t.step("emit void and number", () => {
    const bus = eventBus<AppEvents>();
    let readyCalled = false;
    let tickVal = 0;
    bus.on.ready(() => {
      readyCalled = true;
    });
    bus.on.tick((n) => {
      tickVal = n;
    });
    bus.emit.ready();
    bus.emit.tick(99);
    if (!readyCalled) throw new Error("ready not called");
    if (tickVal !== 99) throw new Error("tick wrong");
  });

  await t.step("once removes after first call", () => {
    const bus = eventBus<AppEvents>();
    let count = 0;
    bus.once.tick(() => {
      count++;
    });
    bus.emit.tick(1);
    bus.emit.tick(2);
    if (count !== 1) throw new Error("once failed");
  });

  await t.step("off works", () => {
    const bus = eventBus<AppEvents>();
    let called = false;
    const handler = () => {
      called = true;
    };
    bus.on.user(handler);
    bus.off.user(handler);
    bus.emit.user({ id: "x", name: "y" });
    if (called) throw new Error("off failed");
  });

  await t.step("waitFor resolves with payload", async () => {
    const bus = eventBus<AppEvents>();
    setTimeout(() => bus.emit.user({ id: "a", name: "b" }), 10);
    const u = await bus.waitFor("user");
    if (u.id !== "a") throw new Error("waitFor failed");
  });

  await t.step("timeoutWaitFor rejects", async () => {
    const bus = eventBus<AppEvents>();
    try {
      await bus.timeoutWaitFor("tick", 5);
      throw new Error("should timeout");
    } catch (err) {
      if (!(err instanceof DOMException) || err.name !== "TimeoutError") {
        throw err;
      }
    }
  });

  await t.step("listenerCount and hasListener", () => {
    const bus = eventBus<AppEvents>();
    const off = bus.on.tick(() => {});
    if (bus.listenerCount("tick") !== 1) {
      throw new Error("listenerCount failed");
    }
    if (!bus.hasListener("tick")) {
      throw new Error("hasListener failed");
    }
    off();
    if (bus.listenerCount("tick") !== 0) {
      throw new Error("listenerCount cleanup failed");
    }
  });

  await t.step("removeAllListeners works", () => {
    const bus = eventBus<AppEvents>();
    bus.on.ready(() => {});
    bus.on.tick(() => {});
    bus.removeAllListeners();
    if (bus.hasListener("ready") || bus.hasListener("tick")) {
      throw new Error("removeAllListeners failed");
    }
  });
});
