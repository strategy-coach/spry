// lib/universal/event-bus_test.ts
// Deno 2.4+ / TS 5.x strict
//
// These tests double as living documentation for the tiny, type-safe wrapper
// over EventTarget/CustomEvent. They exercise the public API in realistic
// scenarios using one synthetic "AppEvents" map and subtests that focus on
// specific behaviors.

import { assert, assertEquals } from "jsr:@std/assert@1.0.8";

// Import the factory under test
import { eventBus } from "./event-bus.ts";

// A single, complex event map for the whole suite.
// NOTE: We don't export a base `EventMap`—consumers provide their own interface.
type AppEvents = {
  // no-payload event
  ready: void;

  // primitive payload
  tick: number;

  // object payload
  user: { id: string; name: string };

  // discriminated union payload
  data:
    | { kind: "a"; value: number }
    | { kind: "b"; value: string };

  // string payload
  notify: string;

  // boolean payload
  flag: boolean;
};

Deno.test("eventBus<AppEvents>() — type-safe EventTarget wrapper (documentation-style)", async (t) => {
  const bus = eventBus<AppEvents>();

  // ---------------------------------------------------------------------------
  // Compile-time type-safety proofs (these lines should *not* compile).
  // Keep them commented with @ts-expect-error so editors/CI will flag regressions.
  // ---------------------------------------------------------------------------

  // @ts-expect-error no param allowed for void event
  bus.on("ready", (_x) => {
    //console.log(x);
  });

  // @ts-expect-error payload required for tick
  bus.emit("tick");

  // @ts-expect-error payload not allowed for ready
  bus.emit("ready", 123);

  // @ts-expect-error wrong payload type
  bus.on("tick", (_s: string) => {});

  // @ts-expect-error wrong event key
  bus.on("unknown", () => {});

  // ---------------------------------------------------------------------------
  await t.step("subscribe/emit (void payload)", () => {
    let seen = 0;
    const off = bus.on("ready", () => {
      seen++;
    });
    assertEquals(seen, 0);

    const dispatched = bus.emit("ready");
    assert(dispatched);
    assertEquals(seen, 1);

    off();
    bus.emit("ready");
    assertEquals(seen, 1);
  });

  await t.step("subscribe/emit (primitive payload)", () => {
    let sum = 0;
    const off = bus.on("tick", (n) => {
      sum += n;
    });

    bus.emit("tick", 2);
    bus.emit("tick", 3);
    assertEquals(sum, 5);

    off();
    bus.emit("tick", 10);
    assertEquals(sum, 5);
  });

  await t.step("subscribe/emit (object and union payloads)", () => {
    const users: string[] = [];
    const dataKinds: string[] = [];

    const offUser = bus.on("user", (u) => {
      users.push(`${u.id}:${u.name}`);
    });
    const offData = bus.on("data", (d) => {
      dataKinds.push(`${d.kind}`);
    });

    bus.emit("user", { id: "u1", name: "Alice" });
    bus.emit("user", { id: "u2", name: "Bob" });
    bus.emit("data", { kind: "a", value: 42 });
    bus.emit("data", { kind: "b", value: "ok" });

    assertEquals(users, ["u1:Alice", "u2:Bob"]);
    assertEquals(dataKinds, ["a", "b"]);

    offUser();
    offData();
  });

  await t.step("once()", () => {
    let count = 0;
    bus.once("notify", () => {
      count++;
    });

    bus.emit("notify", "first");
    bus.emit("notify", "second"); // ignored
    assertEquals(count, 1);
  });

  await t.step(
    "listenerCount(), hasListener(), removeAllListeners()",
    () => {
      const f1 = () => {};
      const f2 = () => {};
      const off1 = bus.on("notify", f1);
      const off2 = bus.on("notify", f2);

      assertEquals(bus.listenerCount("notify"), 2);
      assert(bus.hasListener("notify"));

      off1();
      assertEquals(bus.listenerCount("notify"), 1);
      off2();
      assertEquals(bus.listenerCount("notify"), 0);
      assertEquals(bus.hasListener("notify"), false);

      // Re-add and nuke
      bus.on("notify", f1);
      bus.on("notify", f2);
      assertEquals(bus.listenerCount("notify"), 2);

      bus.removeAllListeners("notify");
      assertEquals(bus.listenerCount("notify"), 0);

      // Global remove
      bus.on("ready", () => {});
      bus.on("tick", () => {});
      bus.removeAllListeners();
      assertEquals(bus.listenerCount("ready"), 0);
      assertEquals(bus.listenerCount("tick"), 0);
    },
  );

  await t.step("waitFor()", async () => {
    const p = bus.waitFor("user");
    // Fire it asynchronously to mimic real-world usage.
    queueMicrotask(() => bus.emit("user", { id: "u3", name: "Carla" }));
    const u = await p;
    assertEquals(u.id, "u3");
    assertEquals(u.name, "Carla");
  });

  await t.step("waitFor() with AbortSignal", async () => {
    const ac = new AbortController();
    const promise = bus.waitFor("notify", { signal: ac.signal });

    // Abort before any event arrives
    ac.abort();

    let aborted = false;
    try {
      await promise;
    } catch (e) {
      aborted = e instanceof DOMException && e.name === "AbortError";
    }
    assert(aborted);
  });

  await t.step("timeoutWaitFor()", async () => {
    let timedOut = false;
    try {
      await bus.timeoutWaitFor("notify", 10); // 10 ms
    } catch (e) {
      timedOut = e instanceof DOMException && e.name === "TimeoutError";
    }
    assert(timedOut);

    // Prove it resolves if event arrives in time
    const p = bus.timeoutWaitFor("notify", 100);
    setTimeout(() => bus.emit("notify", "hello"), 10);
    const s = await p;
    assertEquals(s, "hello");
  });

  await t.step("all() catch-all listener", () => {
    const seen: Array<[keyof AppEvents, unknown]> = [];
    const off = bus.all((type, detail) => {
      seen.push([type, detail]);
    });

    bus.emit("ready");
    bus.emit("flag", true);
    bus.emit("tick", 9);

    off();

    // ready has undefined detail; others have payload
    assertEquals(seen.length, 3);
    assertEquals(seen[0][0], "ready");
    assertEquals(seen[0][1], undefined);
    assertEquals(seen[1][0], "flag");
    assertEquals(seen[1][1], true);
    assertEquals(seen[2][0], "tick");
    assertEquals(seen[2][1], 9);
  });

  await t.step("emitParallel(), emitSerial(), emitSafe()", async () => {
    const order: string[] = [];
    const off1 = bus.on("notify", (s) => {
      order.push(`a:${s}`);
    });
    const off2 = bus.on("notify", async (s) => {
      // introduce an async hop
      await Promise.resolve();
      order.push(`b:${s}`);
    });

    await bus.emitParallel("notify", "p");
    // Order not guaranteed in parallel, so just verify both present
    assert(order.includes("a:p") && order.includes("b:p"));

    order.length = 0;
    await bus.emitSerial("notify", "s");
    assertEquals(order, ["a:s", "b:s"]); // serial preserves registration order

    // emitSafe collects errors instead of throwing
    const off3 = bus.on("notify", () => {
      throw new Error("boom");
    });
    const errors = await bus.emitSafe("notify", "safe");
    assertEquals(errors.length, 1);
    assert(errors[0] instanceof Error);

    off1();
    off2();
    off3();
  });

  await t.step("mute()/unmute() and suspend()/resume()", () => {
    let n = 0;
    const off = bus.on("tick", () => {
      n++;
    });

    bus.mute("tick");
    bus.emit("tick", 1);
    assertEquals(n, 0);

    bus.unmute("tick");
    bus.emit("tick", 1);
    assertEquals(n, 1);

    bus.suspend();
    bus.emit("tick", 1);
    assertEquals(n, 1);

    bus.resume();
    bus.emit("tick", 1);
    assertEquals(n, 2);

    off();
  });

  await t.step("eventNames(), rawListeners(), debugListeners()", () => {
    const f1 = () => {};
    const f2 = () => {};
    const d1 = bus.on("ready", f1);
    const d2 = bus.on("ready", f2);
    const d3 = bus.on("notify", () => {});

    const names = bus.eventNames();
    // The set of keys with listeners; order is Map iteration order
    assert(names.includes("ready"));
    assert(names.includes("notify"));

    const raw = bus.rawListeners("ready");
    assertEquals(raw.length, 2);

    const debug = bus.debugListeners();
    assertEquals(debug.ready, 2);
    assertEquals(debug.notify, 1);

    d1();
    d2();
    d3();
  });

  await t.step(
    "off() is idempotent and duplicate on() is a no-op",
    () => {
      let c = 0;
      const fn = () => {
        c++;
      };

      const dispose = bus.on("ready", fn);
      // duplicate registration returns a disposer for the same binding, but does not add another
      const dispose2 = bus.on("ready", fn);

      bus.emit("ready");
      assertEquals(c, 1);

      dispose2(); // remove existing binding
      bus.emit("ready");
      assertEquals(c, 1); // still 1, since no listeners remain

      // idempotent: removing again does nothing harmful
      dispose();
    },
  );

  await t.step("concurrent waitFor on same event resolves all", async () => {
    const p1 = bus.waitFor("notify");
    const p2 = bus.waitFor("notify");
    queueMicrotask(() => bus.emit("notify", "multi"));
    const [a, b] = await Promise.all([p1, p2]);
    assertEquals(a, "multi");
    assertEquals(b, "multi");
  });

  await t.step(
    "once() with async handler runs exactly once under re-entrancy",
    async () => {
      let count = 0;
      bus.once("notify", async (s) => {
        count++;
        // Re-entrant emission while the once-handler is still running
        bus.emit("notify", s + ":again");
        await Promise.resolve();
      });
      bus.emit("notify", "start");
      // Give microtasks a chance to flush
      await Promise.resolve();
      assertEquals(count, 1);
    },
  );

  await t.step(
    "emitSafe captures async errors and continues others",
    async () => {
      const seen: string[] = [];
      const offOk = bus.on("notify", async (s) => {
        await Promise.resolve();
        seen.push("ok:" + s);
      });
      const offBoom = bus.on("notify", async () => {
        await Promise.resolve();
        throw new Error("async-boom");
      });

      const errs = await bus.emitSafe("notify", "x");
      assertEquals(seen, ["ok:x"]);
      assertEquals(errs.length, 1);
      assert(errs[0] instanceof Error);

      offOk();
      offBoom();
    },
  );

  await t.step(
    "emitSerial preserves registration order across async gaps",
    async () => {
      const order: string[] = [];
      const off1 = bus.on("notify", async (s) => {
        order.push("1:" + s);
        await new Promise((r) => setTimeout(r, 5));
      });
      const off2 = bus.on("notify", async (s) => {
        order.push("2:" + s);
        await Promise.resolve();
      });

      await bus.emitSerial("notify", "serial");
      assertEquals(order, ["1:serial", "2:serial"]);

      off1();
      off2();
    },
  );

  await t.step(
    "emitParallel triggers all; order not guaranteed but both present",
    async () => {
      const seen: string[] = [];
      const off1 = bus.on("notify", async (s) => {
        await new Promise((r) => setTimeout(r, 1));
        seen.push("A:" + s);
      });
      const off2 = bus.on("notify", async (s) => {
        await Promise.resolve();
        seen.push("B:" + s);
      });

      await bus.emitParallel("notify", "p");
      assert(seen.includes("A:p") && seen.includes("B:p"));

      off1();
      off2();
    },
  );

  await t.step(
    "all() receives events emitted via parallel/serial/safe including void detail",
    async () => {
      const got: Array<[keyof AppEvents, unknown]> = [];
      const offAll = bus.all((type, detail) => {
        got.push([type, detail]);
      });

      await bus.emitParallel("notify", "via-parallel");
      await bus.emitSerial("notify", "via-serial");
      await bus.emitSafe("notify", "via-safe");
      bus.emit("ready"); // void payload -> undefined

      offAll();

      // We don't assert order, only presence and values
      const values = new Map(got.map(([k, v]) => [k + ":" + String(v), true]));
      assert(values.has("notify:via-parallel"));
      assert(values.has("notify:via-serial"));
      assert(values.has("notify:via-safe"));
      assert(values.has("ready:undefined"));
    },
  );

  await t.step(
    "timeoutWaitFor race: event arrives right before deadline",
    async () => {
      const p = bus.timeoutWaitFor("notify", 25);
      setTimeout(() => bus.emit("notify", "just-in-time"), 10);
      const s = await p;
      assertEquals(s, "just-in-time");
    },
  );

  await t.step(
    "suspend()/resume() pauses emissions; waiters still work after resume",
    async () => {
      bus.suspend();
      let seen = 0;
      const off = bus.on("tick", () => {
        seen++;
      });

      bus.emit("tick", 1); // ignored
      assertEquals(seen, 0);

      // pending waiter won't resolve until after resume & emit
      const waiter = bus.waitFor("tick");
      bus.resume();
      bus.emit("tick", 2);
      const v = await waiter;
      assertEquals(v, 2);
      assertEquals(seen, 1);

      off();
    },
  );

  await t.step(
    "rapid add/remove during async emission doesn't break",
    async () => {
      const seen: string[] = [];
      const fn1 = async (s: string) => {
        seen.push("1:" + s);
        await Promise.resolve();
      };
      const fn2 = async (s: string) => {
        seen.push("2:" + s);
        await Promise.resolve();
      };
      const d1 = bus.on("notify", fn1);
      const d2 = bus.on("notify", fn2);

      // Start serial emission; remove one handler mid-flight
      const p = bus.emitSerial("notify", "z");
      d1(); // remove fn1 while serial emission could still be processing
      await p;

      // fn1 ran (first) and fn2 ran (second); removal affected future emits only
      assertEquals(seen, ["1:z", "2:z"]);

      d2();
    },
  );

  // Final cleanliness check: nothing left registered
  bus.removeAllListeners();
  assertEquals(bus.eventNames().length, 0);
});
