import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { eventBus, EventMap } from "./event-bus.ts";

/**
 * These tests are intended as **usage documentation** for `eventBus`.
 * The underlying implementation simply wraps `EventTarget` + `CustomEvent`,
 * so the focus here is on demonstrating how to use the API in realistic ways.
 */
Deno.test("eventBus comprehensive tests", async (t) => {
  interface AppEvents extends EventMap {
    ready: void;
    tick: number;
    user: {
      id: string;
      name: string;
      roles: string[];
      profile: { age: number; email: string };
    };
    order: {
      id: string;
      items: Array<{ sku: string; qty: number }>;
      total: number;
    };
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
    assert(readyCalled, "ready not called");
    assertEquals(tickVal, 99);
  });

  await t.step("once removes after first call", () => {
    const bus = eventBus<AppEvents>();
    let count = 0;
    bus.once.tick(() => {
      count++;
    });
    bus.emit.tick(1);
    bus.emit.tick(2);
    assertEquals(count, 1);
  });

  await t.step("off works", () => {
    const bus = eventBus<AppEvents>();
    let called = false;
    const handler = () => {
      called = true;
    };
    bus.on.user(handler);
    bus.off.user(handler);
    bus.emit.user({
      id: "u1",
      name: "Alice",
      roles: ["admin"],
      profile: { age: 30, email: "alice@example.com" },
    });
    assertEquals(called, false);
  });

  await t.step("waitFor resolves with payload", async () => {
    const bus = eventBus<AppEvents>();
    setTimeout(() =>
      bus.emit.user({
        id: "u2",
        name: "Bob",
        roles: ["editor", "contributor"],
        profile: { age: 25, email: "bob@example.com" },
      }), 10);
    const u = await bus.waitFor("user");
    assertEquals(u.name, "Bob");
    assertEquals(u.roles.length, 2);
  });

  await t.step("timeoutWaitFor rejects", async () => {
    const bus = eventBus<AppEvents>();
    await assertRejects(
      () => bus.timeoutWaitFor("tick", 5),
      DOMException,
      "Timeout", // message is "Timeout", not "TimeoutError"
    );
  });

  await t.step("listenerCount and hasListener", () => {
    const bus = eventBus<AppEvents>();
    const off = bus.on.tick(() => {});
    assertEquals(bus.listenerCount("tick"), 1);
    assert(bus.hasListener("tick"));
    off();
    assertEquals(bus.listenerCount("tick"), 0);
  });

  await t.step("removeAllListeners works", () => {
    const bus = eventBus<AppEvents>();
    bus.on.ready(() => {});
    bus.on.tick(() => {});
    bus.removeAllListeners();
    assertEquals(bus.hasListener("ready"), false);
    assertEquals(bus.hasListener("tick"), false);
  });

  await t.step("emit and listen for complex object payload", () => {
    const bus = eventBus<AppEvents>();
    let orderId = "";
    let itemCount = 0;
    bus.on.order((order) => {
      orderId = order.id;
      itemCount = order.items.reduce((sum, i) => sum + i.qty, 0);
    });
    bus.emit.order({
      id: "ord123",
      items: [
        { sku: "A100", qty: 2 },
        { sku: "B200", qty: 3 },
      ],
      total: 500,
    });
    assertEquals(orderId, "ord123");
    assertEquals(itemCount, 5);
  });

  await t.step("all listener receives all events", () => {
    const bus = eventBus<AppEvents>();
    const seen: Array<[string, unknown]> = [];
    const offAll = bus.all((type, detail) => {
      seen.push([type as string, detail]);
    });

    // NOTE: also add a "normal" listener so toHandler fires
    bus.on.tick(() => {});
    bus.on.user(() => {});

    bus.emit.tick(42);
    bus.emit.user({
      id: "u3",
      name: "Charlie",
      roles: ["viewer"],
      profile: { age: 40, email: "charlie@example.com" },
    });
    offAll();

    assertEquals(seen.length, 2);
    assertEquals(seen[0][0], "tick");
    assertEquals(seen[1][0], "user");
    assertEquals((seen[1][1] as { name: string }).name, "Charlie");
  });

  await t.step("emitParallel and emitSerial for async listeners", async () => {
    const bus = eventBus<AppEvents>();
    const calls: string[] = [];

    // Async listeners
    bus.on.user(async (u) => {
      await new Promise((r) => setTimeout(r, 20));
      calls.push("L1:" + u.name);
    });
    bus.on.user(async (u) => {
      await new Promise((r) => setTimeout(r, 5));
      calls.push("L2:" + u.name);
    });

    await bus.emitParallel("user", {
      id: "u4",
      name: "Dana",
      roles: ["admin"],
      profile: { age: 35, email: "dana@example.com" },
    });

    // Both should have run (parallel)
    assert(calls.includes("L1:Dana"));
    assert(calls.includes("L2:Dana"));

    calls.length = 0;

    await bus.emitSerial("user", {
      id: "u5",
      name: "Eve",
      roles: ["editor"],
      profile: { age: 29, email: "eve@example.com" },
    });

    // Order preserved in serial mode
    assertEquals(calls[0], "L1:Eve");
    assertEquals(calls[1], "L2:Eve");
  });

  await t.step("emitSafe collects errors without throwing", async () => {
    const bus = eventBus<AppEvents>();
    bus.on.user(() => {
      throw new Error("listener1 failed");
    });
    bus.on.user(() => {
      throw new Error("listener2 failed");
    });
    const errors = await bus.emitSafe("user", {
      id: "u6",
      name: "Frank",
      roles: ["tester"],
      profile: { age: 50, email: "frank@example.com" },
    });
    assertEquals(errors.length, 2);
    assertEquals((errors[0] as Error).message, "listener1 failed");
  });

  await t.step("mute/unmute disables and re-enables event delivery", () => {
    const bus = eventBus<AppEvents>();
    let tickVal = 0;
    bus.on.tick((n) => {
      tickVal = n;
    });
    bus.mute("tick");
    bus.emit.tick(111);
    assertEquals(tickVal, 0); // still muted
    bus.unmute("tick");
    bus.emit.tick(222);
    assertEquals(tickVal, 222); // delivered after unmute
  });

  await t.step("suspend/resume disables and re-enables ALL events", () => {
    const bus = eventBus<AppEvents>();
    let readyCalled = false;
    bus.on.ready(() => {
      readyCalled = true;
    });
    bus.suspend();
    bus.emit.ready();
    assertEquals(readyCalled, false); // suspended
    bus.resume();
    bus.emit.ready();
    assertEquals(readyCalled, true); // resumed
  });

  await t.step("debugListeners returns counts per event", () => {
    const bus = eventBus<AppEvents>();
    bus.on.ready(() => {});
    bus.on.tick(() => {});
    bus.on.tick(() => {});
    const debug = bus.debugListeners();
    assertEquals(debug.ready, 1);
    assertEquals(debug.tick, 2);
  });
});
