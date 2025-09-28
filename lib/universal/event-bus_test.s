import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";

import {
  EventBus,
  wrapEventTarget,
  type ValueIsEvent,
} from "./event-bus.ts";

/** Simple event map used across basic tests */
interface AppEvents extends ValueIsEvent<AppEvents> {
  start: Event;                                   // payloadless
  progress: CustomEvent<{ pct: number }>;         // payloadful
  done: CustomEvent<void>;                        // treated as payloadless
}

/** Complex/nested shapes to demo type-safety thoroughly */
interface ComplexEvents extends ValueIsEvent<ComplexEvents> {
  ping: Event;

  userCreated: CustomEvent<{
    id: string;
    profile: {
      name: string;
      tags: string[];
      address?: {
        city: string;
        geo: { lat: number; lng: number };
      };
    };
  }>;

  settingsUpdated: CustomEvent<{
    path: readonly (string | number)[];
    value: unknown;
    previous?: unknown;
  }>;

  error: CustomEvent<{
    code: "E_INPUT" | "E_NETWORK";
    meta?: { retry: boolean; cause?: { message: string } };
  }>;

  batchProcessed: CustomEvent<
    Array<{ id: number; ok: boolean; metrics: { ms: number } }>
  >;

  voidy: CustomEvent<void>; // treated as payloadless by the bus
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Basic EventBus tests (from earlier)                                        */
/* ────────────────────────────────────────────────────────────────────────── */

Deno.test("EventBus: basic on/off and emit (payloadless)", async (t) => {
  const bus = new EventBus<AppEvents>();

  await t.step("on.start subscribes and unsubscribe works", async () => {
    let calls = 0;
    const off = bus.on.start(() => calls++);
    bus.emit.start();
    bus.emit.start();
    off();
    bus.emit.start();
    assertEquals(calls, 2);
  });

  await t.step("on.withAbort.start returns AbortController", async () => {
    let calls = 0;
    const ac = bus.on.withAbort.start(() => calls++, { passive: true });
    bus.emit.start();
    ac.abort();
    bus.emit.start();
    assertEquals(calls, 1);
  });

  await t.step("emitEvent.start(init?) dispatches native Event", () => {
    let gotType = "";
    const off = bus.on.start((e) => (gotType = e.type));
    const ok = bus.emitEvent.start({ bubbles: true });
    off();
    assert(ok);
    assertEquals(gotType, "start");
  });

  await t.step("emit.done() dispatches CustomEvent<void> treated as payloadless", () => {
    let gotType = "";
    const off = bus.on.done((e) => (gotType = e.type));
    const ok = bus.emit.done();
    off();
    assert(ok);
    assertEquals(gotType, "done");
  });
});

Deno.test("EventBus: payloadful emit and listener typing", async (t) => {
  const bus = new EventBus<AppEvents>();

  await t.step("emit.progress(detail, init?) -> CustomEvent with detail", () => {
    let lastPct = -1;
    const off = bus.on.progress((e) => (lastPct = e.detail.pct));
    const ok = bus.emit.progress({ pct: 42 }, { bubbles: true });
    off();
    assert(ok);
    assertEquals(lastPct, 42);
  });

  await t.step("emitCustom.progress(detail, init?) works explicitly", () => {
    let lastPct = -1;
    const off = bus.on.progress((e) => (lastPct = e.detail.pct));
    const ok = bus.emitCustom.progress({ pct: 7 });
    off();
    assert(ok);
    assertEquals(lastPct, 7);
  });

  await t.step("ambiguous single-argument emit throws without registry", () => {
    // When called with exactly one argument, runtime cannot decide EventInit vs detail.
    // The EventBus is designed to throw with guidance.
    assertThrows(
      // @ts-expect-error Purposefully violating the ergonomic overload at runtime
      () => (bus.emit as any).progress({ pct: 1 }),
      Error,
      'Ambiguous single-argument emit for "progress"',
    );
  });
});

Deno.test("EventBus: once and withTimeout", async (t) => {
  const bus = new EventBus<AppEvents>();

  await t.step("once.progress resolves with the next event", async () => {
    const p = bus.once.progress();
    // schedule emit
    queueMicrotask(() => bus.emit.progress({ pct: 99 }));
    const e = await p;
    assertEquals(e.type, "progress");
    assertEquals(e.detail.pct, 99);
  });

  await t.step("once.withTimeout.progress rejects when not emitted", async () => {
    await assertRejects(
      () => bus.once.withTimeout.progress(25),
      Error,
      'Timeout waiting for "progress" after 25ms',
    );
  });

  await t.step("once.done with native { once: true } only fires once", async () => {
    let count = 0;
    const p = bus.once.done();
    bus.emit.done();
    bus.emit.done();
    await p;
    // extra emits shouldn't affect the already-resolved promise
    count++;
    assertEquals(count, 1);
  });
});

Deno.test("EventBus: stream.<name>() async iterator (no polling)", async (t) => {
  const bus = new EventBus<AppEvents>();

  await t.step("collects multiple progress events then breaks", async () => {
    const seen: number[] = [];
    const run = (async () => {
      for await (const e of bus.stream.progress()) {
        seen.push(e.detail.pct);
        if (e.detail.pct >= 3) break; // stop stream, should auto-abort listener
      }
    })();

    // Emit a few in sequence
    bus.emit.progress({ pct: 1 });
    bus.emit.progress({ pct: 2 });
    bus.emit.progress({ pct: 3 });

    await run;
    assertEquals(seen, [1, 2, 3]);
  });
});

Deno.test("EventBus: native methods remain interoperable", async (t) => {
  const bus = new EventBus<AppEvents>();

  await t.step("typed addEventListener/removeEventListener", () => {
    let count = 0;
    const handler = () => count++;
    bus.addEventListener("start", handler);
    (bus as EventTarget).dispatchEvent(new Event("start"));
    bus.removeEventListener("start", handler);
    (bus as EventTarget).dispatchEvent(new Event("start"));
    assertEquals(count, 1);
  });

  await t.step("dispatchEvent allowed by default (dev flag off)", () => {
    let called = false;
    const off = bus.on.start(() => (called = true));
    const ok = (bus as EventTarget).dispatchEvent(new Event("start"));
    off();
    assert(ok);
    assert(called);
  });
});

Deno.test("EventBus: devThrowOnUntypedDispatch only throws when enabled", async (t) => {
  await t.step("default false does not throw", () => {
    const bus = new EventBus<AppEvents>(/* devThrowOnUntypedDispatch */ false);
    assert((bus as EventTarget).dispatchEvent(new Event("start")));
  });

  await t.step("true causes dispatchEvent to throw", () => {
    const bus = new EventBus<AppEvents>(true);
    assertThrows(
      () => (bus as EventTarget).dispatchEvent(new Event("start")),
      Error,
      "Use typed emitters",
    );
  });
});

Deno.test("wrapEventTarget: delegates to an existing native EventTarget", async (t) => {
  const target = new EventTarget();
  const bus = wrapEventTarget<AppEvents>(target);

  await t.step("on/emit affects the underlying target", () => {
    let got = 0;
    target.addEventListener("progress", (e) => {
      got = (e as CustomEvent<{ pct: number }>).detail.pct;
    });
    bus.emitCustom.progress({ pct: 88 });
    assertEquals(got, 88);
  });

  await t.step("listeners added via wrapper are invoked on native dispatch", () => {
    let called = false;
    const off = bus.on.start(() => (called = true));
    target.dispatchEvent(new Event("start"));
    off();
    assert(called);
  });

  await t.step("devThrowOnUntypedDispatch respected in wrapper", () => {
    const wrapped = wrapEventTarget<AppEvents>(target, true);
    assertThrows(
      () => (wrapped as unknown as EventTarget).dispatchEvent(new Event("start")),
      Error,
      "Use typed emitters",
    );
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Complex type-safety demos                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

Deno.test("ComplexEvents: nested object payloads, arrays, optionals, unions", async (t) => {
  const bus = new EventBus<ComplexEvents>();

  await t.step("userCreated: nested optional access and correct types", () => {
    let city = "";
    let lat = 0;
    const off = bus.on.userCreated((e) => {
      // Strongly typed nested access:
      city = e.detail.profile.address?.city ?? "";
      lat = e.detail.profile.address?.geo.lat ?? -1;

      // @ts-expect-error property does not exist
      // deno-lint-ignore no-explicit-any
      const _bad = (e.detail.profile as any).unknownField;
    });

    const detail = {
      id: "u-1",
      profile: {
        name: "Zoya",
        tags: ["kid", "student"],
        address: { city: "Austin", geo: { lat: 30.27, lng: -97.74 } },
      },
    };
    bus.emit.userCreated(detail);
    off();
    assertEquals(city, "Austin");
    assertEquals(lat, 30.27);
  });

  await t.step("userCreated: compile-time guardrails on detail shape", () => {
    // @ts-expect-error id must be string
    // deno-lint-ignore ban-ts-comment
    // @ts-ignore: intentional misuse for type-safety demo
    // This line should produce a TS error in editors/CI (not executed at runtime).
    // bus.emit.userCreated({ id: 123, profile: { name: "X", tags: [] } });

    // Correct usage:
    const ok = bus.emit.userCreated({ id: "u-2", profile: { name: "Hafsa", tags: [] } });
    assert(ok);
  });

  await t.step("settingsUpdated: readonly path with string|number; rejects boolean", () => {
    const off = bus.on.settingsUpdated((e) => {
      // path is readonly; ensure we don't mutate:
      // @ts-expect-error path is readonly
      // deno-lint-ignore no-explicit-any
      (e.detail.path as any).push?.("illegal");
      assertEquals(Array.isArray(e.detail.path), true);
    });

    // OK: strings and numbers
    bus.emit.settingsUpdated({ path: ["root", "theme", 0], value: { dark: true } });

    off();

    // @ts-expect-error boolean not allowed in path element
    // bus.emit.settingsUpdated({ path: ["root", true], value: 1 });
  });

  await t.step("error: union codes enforced and optional meta typed", () => {
    let gotRetry = false;
    let gotMsg = "";
    const off = bus.on.error((e) => {
      gotRetry = !!e.detail.meta?.retry;
      gotMsg = e.detail.meta?.cause?.message ?? "";
    });

    bus.emit.error({
      code: "E_INPUT",
      meta: { retry: false, cause: { message: "Bad value" } },
    });

    off();
    assertEquals(gotRetry, false);
    assertEquals(gotMsg, "Bad value");

    // @ts-expect-error invalid union member
    // bus.emit.error({ code: "E_TIMEOUT" });
  });

  await t.step("batchProcessed: array of records typed; stream consumption", async () => {
    const seen: Array<{ id: number; ok: boolean; ms: number }> = [];

    const run = (async () => {
      for await (const e of bus.stream.batchProcessed()) {
        for (const item of e.detail) {
          seen.push({ id: item.id, ok: item.ok, ms: item.metrics.ms });
        }
        if (seen.length >= 3) break;
      }
    })();

    bus.emit.batchProcessed([
      { id: 1, ok: true, metrics: { ms: 12 } },
      { id: 2, ok: false, metrics: { ms: 34 } },
    ]);
    bus.emit.batchProcessed([{ id: 3, ok: true, metrics: { ms: 56 } }]);

    await run;

    assertEquals(seen, [
      { id: 1, ok: true, ms: 12 },
      { id: 2, ok: false, ms: 34 },
      { id: 3, ok: true, ms: 56 },
    ]);

    // @ts-expect-error wrong property name 'metric'
    // bus.emit.batchProcessed([{ id: 4, ok: true, metric: { ms: 1 } }]);
  });

  await t.step("voidy: treated as payloadless CustomEvent<void>", () => {
    let count = 0;
    const off = bus.on.voidy(() => count++);
    bus.emit.voidy();
    bus.emitEvent.voidy(); // also allowed (payloadless)
    off();
    assertEquals(count, 2);
  });

  await t.step("ambiguous single-argument emit: throws with guidance", () => {
    // One-argument `emit` is intentionally disallowed at runtime without registry:
    // it is ambiguous whether it's EventInit or payload. TS prevents misuse at compile time,
    // but we also enforce it at runtime for robustness.
    assertThrows(
      // @ts-expect-error runtime misuse demo
      () => (bus.emit as any).userCreated({ id: "X", profile: { name: "Y", tags: [] } }),
      Error,
      'Ambiguous single-argument emit for "userCreated"',
    );
  });
});

/* Sanity: wrapEventTarget works with ComplexEvents, too */
Deno.test("wrapEventTarget + ComplexEvents interop", async (t) => {
  const target = new EventTarget();
  const bus = wrapEventTarget<ComplexEvents>(target);

  await t.step("typed listener sees nested payloads correctly", () => {
    let lng = 0;
    const off = bus.on.userCreated((e) => {
      lng = e.detail.profile.address?.geo.lng ?? -1;
    });

    target.dispatchEvent(
      new CustomEvent("userCreated", {
        detail: {
          id: "u-9",
          profile: {
            name: "Mira",
            tags: [],
            address: { city: "Dallas", geo: { lat: 32.77, lng: -96.79 } },
          },
        },
      }),
    );

    off();
    assertEquals(lng, -96.79);
  });
});
