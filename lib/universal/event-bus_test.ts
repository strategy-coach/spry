// event-bus_test.ts
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  type TypedEventListener,
  type TypedEventListenerObject,
  TypedEventTarget,
} from "./event-bus.ts";

interface DemoEventMap {
  hello: Event;
  tick: CustomEvent<number>;
  payload: CustomEvent<{ id: string; ok: boolean }>;
}

Deno.test("basic usage: add listener and dispatch a simple Event", () => {
  const bus = new TypedEventTarget<DemoEventMap>();

  let called = false;
  bus.addEventListener("hello", () => {
    called = true;
  });

  const ok = bus.dispatchTypedEvent("hello", new Event("hello"));

  assert(ok);
  assert(called);
});

Deno.test("custom payloads: receive a typed CustomEvent<number>", () => {
  const bus = new TypedEventTarget<DemoEventMap>();
  let detailSeen = -1;

  const onTick: TypedEventListener<DemoEventMap, "tick"> = (evt) => {
    detailSeen = evt.detail;
  };

  bus.addEventListener("tick", onTick);
  bus.dispatchTypedEvent(
    "tick",
    new CustomEvent<number>("tick", { detail: 42 }),
  );

  assertEquals(detailSeen, 42);
});

Deno.test("listener object: use handleEvent for OO-style handlers", () => {
  const bus = new TypedEventTarget<DemoEventMap>();
  let seen: { id: string; ok: boolean } | undefined;

  const handler: TypedEventListenerObject<DemoEventMap, "payload"> = {
    handleEvent(evt) {
      seen = evt.detail;
    },
  };

  bus.addEventListener("payload", handler);
  bus.dispatchTypedEvent(
    "payload",
    new CustomEvent("payload", { detail: { id: "x1", ok: true } }),
  );

  assertEquals(seen, { id: "x1", ok: true });
});

Deno.test("once option: listener runs exactly once", () => {
  const bus = new TypedEventTarget<DemoEventMap>();
  let count = 0;

  bus.addEventListener(
    "hello",
    () => {
      count++;
    },
    { once: true },
  );

  bus.dispatchTypedEvent("hello", new Event("hello"));
  bus.dispatchTypedEvent("hello", new Event("hello"));

  assertEquals(count, 1);
});

Deno.test("removeEventListener: properly detaches callback", () => {
  const bus = new TypedEventTarget<DemoEventMap>();
  let hits = 0;

  const fn: TypedEventListener<DemoEventMap, "hello"> = () => {
    hits++;
  };

  bus.addEventListener("hello", fn);
  bus.dispatchTypedEvent("hello", new Event("hello"));
  assertEquals(hits, 1);

  bus.removeEventListener("hello", fn);
  bus.dispatchTypedEvent("hello", new Event("hello"));
  assertEquals(hits, 1); // unchanged
});

Deno.test("async listener: supported return type, dispatch remains sync", async () => {
  const bus = new TypedEventTarget<DemoEventMap>();
  let observed = 0;

  bus.addEventListener("tick", async (evt) => {
    await new Promise((r) => setTimeout(r, 0));
    observed = evt.detail;
  });

  const ok = bus.dispatchTypedEvent(
    "tick",
    new CustomEvent("tick", { detail: 7 }),
  );
  assert(ok);
  assertEquals(observed, 0);

  await new Promise((r) => setTimeout(r, 0));
  assertEquals(observed, 7);
});

Deno.test("deprecated dispatchEvent: still works but prefer dispatchTypedEvent", () => {
  const bus = new TypedEventTarget<DemoEventMap>();
  let called = false;

  bus.addEventListener("hello", () => {
    called = true;
  });

  const result = bus.dispatchEvent(new Event("hello"));
  assert(result);
  assert(called);
});

Deno.test("type inference: prevents wrong event/detail at compile-time (illustrative)", () => {
  const bus = new TypedEventTarget<DemoEventMap>();

  // Illustrative compile-time guards (keep commented):
  // bus.addEventListener("unknown", () => {});
  // bus.addEventListener("tick", (e: CustomEvent<string>) => {});
  // bus.dispatchTypedEvent("payload", new CustomEvent("payload", { detail: 123 }));

  bus.addEventListener("tick", (e) => {
    assertEquals(typeof e.detail, "number");
  });

  bus.dispatchTypedEvent("tick", new CustomEvent("tick", { detail: 1 }));
});

Deno.test("multiple listeners: all are invoked for a single dispatch", () => {
  const bus = new TypedEventTarget<DemoEventMap>();
  let a = 0;
  let b = 0;

  bus.addEventListener("hello", () => {
    a++;
  });
  bus.addEventListener("hello", () => {
    b++;
  });

  bus.dispatchTypedEvent("hello", new Event("hello"));

  assertEquals(a, 1);
  assertEquals(b, 1);
});

Deno.test("no listeners: dispatch returns true and does nothing", () => {
  const bus = new TypedEventTarget<DemoEventMap>();
  const ret = bus.dispatchTypedEvent("hello", new Event("hello"));
  assert(ret);
});

Deno.test("removing a non-existent listener is a no-op", () => {
  const bus = new TypedEventTarget<DemoEventMap>();
  let called = false;

  const fn: TypedEventListener<DemoEventMap, "hello"> = () => {
    called = true;
  };

  bus.removeEventListener("hello", fn);
  const ok = bus.dispatchTypedEvent("hello", new Event("hello"));

  assert(ok);
  assert(called === false);
});

Deno.test("options.capture & passive are accepted (DOM parity), not asserted here", () => {
  const bus = new TypedEventTarget<DemoEventMap>();
  let seen = false;

  bus.addEventListener(
    "hello",
    () => {
      seen = true;
    },
    { capture: true, passive: true },
  );

  const ok = bus.dispatchTypedEvent("hello", new Event("hello"));
  assert(ok);
  assert(seen);
});

Deno.test("listener object + removeEventListener with same reference", () => {
  const bus = new TypedEventTarget<DemoEventMap>();
  let hits = 0;

  const obj: TypedEventListenerObject<DemoEventMap, "hello"> = {
    handleEvent: () => {
      hits++;
    },
  };

  bus.addEventListener("hello", obj);
  bus.dispatchTypedEvent("hello", new Event("hello"));
  assertEquals(hits, 1);

  bus.removeEventListener("hello", obj);
  bus.dispatchTypedEvent("hello", new Event("hello"));
  assertEquals(hits, 1);
});

Deno.test("composed example: documenting a tiny event bus wrapper", async () => {
  class MiniBus extends TypedEventTarget<DemoEventMap> {
    hello() {
      return this.dispatchTypedEvent("hello", new Event("hello"));
    }
    tick(n: number) {
      return this.dispatchTypedEvent(
        "tick",
        new CustomEvent("tick", { detail: n }),
      );
    }
    sendPayload(p: { id: string; ok: boolean }) {
      return this.dispatchTypedEvent(
        "payload",
        new CustomEvent("payload", { detail: p }),
      );
    }
  }

  const bus = new MiniBus();

  let helloCount = 0;
  let lastTick = 0;
  let lastPayload: { id: string; ok: boolean } | undefined;

  bus.addEventListener("hello", () => {
    helloCount++;
  });
  bus.addEventListener("tick", (e) => {
    lastTick = e.detail;
  });
  bus.addEventListener("payload", (e) => {
    lastPayload = e.detail;
  });

  bus.hello();
  bus.tick(99);
  bus.sendPayload({ id: "p-1", ok: true });

  await new Promise((r) => setTimeout(r, 0));

  assertEquals(helloCount, 1);
  assertEquals(lastTick, 99);
  assertEquals(lastPayload, { id: "p-1", ok: true });
});

Deno.test("cancellation semantics: dispatchEvent returns false when preventDefault() on cancelable event", () => {
  const bus = new TypedEventTarget<DemoEventMap>();
  let prevented = false;

  bus.addEventListener("hello", (e) => {
    e.preventDefault();
    prevented = e.defaultPrevented;
  });

  const ev = new Event("hello", { cancelable: true });
  const result = bus.dispatchEvent(ev);

  assertFalse(result);
  assert(prevented);
});
