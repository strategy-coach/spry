/**
 * event-bus.ts
 *
 * A tiny, type-safe event bus utility built on top of the native EventTarget
 * and CustomEvent APIs. It hides DOM classes from everyday usage so junior
 * developers only see a simple API, but internally it delegates to the browser
 * standard semantics that senior developers will recognize.
 *
 * Purpose:
 * - Provide a safe, ergonomic way to publish and subscribe to events in Deno or
 *   other TypeScript runtimes without exposing EventTarget or CustomEvent.
 * - Give juniors familiar patterns like `on`, `once`, `off`, and `emit` with
 *   both string-style (`bus.on("tick", ...)`) and property-style
 *   (`bus.on.tick(...)`) APIs.
 * - Give seniors confidence that this is not a reinvention of event systems,
 *   just a typed convenience wrapper.
 *
 * Capabilities:
 * - Typed event maps: developers define an interface mapping event names to
 *   their payloads. Example: `{ tick: number; ready: void; user: { id: string } }`.
 * - Two API styles:
 *   • String-style: `bus.on("tick", handler)` and `bus.emit("tick", 42)`.
 *   • Property-style: `bus.on.tick(handler)` and `bus.emit.tick(42)`.
 * - Core operations: `on`, `once`, `off`, `emit`.
 * - Helpers for better DX: `listenerCount`, `hasListener`,
 *   `removeAllListeners`.
 * - Promise helpers: `waitFor("event")` resolves with the next payload,
 *   `timeoutWaitFor("event", ms)` rejects if timeout expires first.
 * - Catch-all listener: `bus.all((type, detail) => { ... })`.
 * - Introspection: `eventNames()` lists events with listeners,
 *   `rawListeners("event")` returns attached handlers,
 *   `debugListeners()` shows counts per event.
 * - Async emission modes:
 *   • `emitParallel("event", payload)` runs listeners concurrently.
 *   • `emitSerial("event", payload)` runs listeners sequentially in order.
 *   • `emitSafe("event", payload)` runs all listeners and collects errors
 *     without throwing.
 * - Controls: `mute("event")` disables a single event, `unmute("event")` re-enables,
 *   `suspend()` pauses all events globally, `resume()` resumes them.
 * - Disposer return values: calling the function returned by `on` or `once`
 *   unsubscribes that specific listener.
 *
 * Usage example:
 * ```ts
 * interface AppEvents {
 *   ready: void;
 *   tick: number;
 *   user: { id: string; name: string };
 * }
 *
 * const bus = eventBus<AppEvents>();
 * bus.on.ready(() => console.log("Ready!"));
 * bus.emit.tick(42);
 * const user = await bus.waitFor("user");
 * ```
 *
 * Notes for humans and AI:
 * - Do not invent new semantics; this module strictly layers on top of
 *   EventTarget and CustomEvent.
 * - Focus is on type safety, developer ergonomics, and ease of learning.
 * - Implementation is minimal; most complexity is in type definitions and
 *   Proxy-based property access.
 */

/**
 * EventMap
 *
 * The central type definition that applications use to describe their event
 * contracts. An EventMap is an interface where each key is the name of an event
 * and the value is the type of the `detail` payload carried by that event.
 *
 * How it works:
 * - Keys must be strings (the event names).
 * - Values define the payload type for the event:
 *   • If the type is `void`, the event carries no payload and `emit` requires
 *     no arguments.
 *   • If the type is any other type, that is the payload type passed to
 *     listeners and required when emitting.
 *
 * Why it matters:
 * - This is the main entry point for applications using the event bus.
 * - By defining a custom interface that extends `EventMap`, developers declare
 *   all possible events and their associated payloads in one place.
 * - The event bus then uses this interface to enforce type safety for
 *   subscribing, emitting, and handling events.
 *
 * Example:
 * ```ts
 * // Define the application’s events by extending EventMap.
 * interface AppEvents extends EventMap {
 *   ready: void; // no payload
 *   tick: number; // payload is a number
 *   user: { id: string; name: string }; // complex payload
 * }
 *
 * // Create the bus typed to the AppEvents map.
 * const bus = eventBus<AppEvents>();
 *
 * // Subscribe to events with full type safety.
 * bus.on.ready(() => console.log("ready!"));
 * bus.on.tick((n) => console.log("tick", n.toFixed(2)));
 * bus.on.user((u) => console.log("user", u.id));
 *
 * // Emit events with correctly typed payloads.
 * bus.emit.ready();
 * bus.emit.tick(42);
 * bus.emit.user({ id: "u1", name: "Alice" });
 * ```
 */
export interface EventMap {
  [event: string]: unknown | void;
}

export type EventBusListener<M extends EventMap, K extends keyof M> =
  | ((detail: M[K]) => void | Promise<void>)
  | { handle(detail: M[K]): void | Promise<void> };

export type EventBusDisposer = () => void;

/**
 * EventBusStringly<M>
 *
 * The core event bus interface that provides a **string-based API** for
 * subscribing, unsubscribing, and emitting events. It is called *stringly*
 * because all operations reference events by string keys, e.g.
 * `bus.on("tick", handler)` and `bus.emit("user", payload)`.
 *
 * Why "stringly":
 * - Event names are provided as strings rather than properties.
 * - This style is familiar to developers coming from Node.js EventEmitter,
 *   browser addEventListener, or other event systems that use string event
 *   names.
 * - TypeScript still enforces correctness: event names must be valid keys of
 *   the `EventMap` type `M`, and payload types are checked against the event
 *   definition.
 *
 * Companion factory: `eventBusStringly<M>()`
 * - Applications should not construct this interface manually.
 * - Use the `eventBusStringly` factory function to create a bus instance typed
 *   to your `EventMap`.
 * - The returned object implements this interface and provides all the methods
 *   described below.
 *
 * Main methods:
 * - `on("event", listener)` subscribe
 * - `once("event", listener)` subscribe once
 * - `off("event", listener)` unsubscribe
 * - `emit("event", payload?)` publish
 * - Helpers: `listenerCount`, `hasListener`, `removeAllListeners`,
 *   `waitFor`, `timeoutWaitFor`
 * - Advanced: `all`, `eventNames`, `rawListeners`,
 *   `emitParallel`, `emitSerial`, `emitSafe`
 * - Controls: `mute`, `unmute`, `suspend`, `resume`
 * - Diagnostics: `debugListeners`
 *
 * Example usage:
 * ```ts
 * // Define event map
 * interface AppEvents extends EventMap {
 *   ready: void;
 *   tick: number;
 *   user: { id: string; name: string };
 * }
 *
 * // Create stringly bus
 * const bus = eventBusStringly<AppEvents>();
 *
 * // Subscribe using string keys
 * bus.on("tick", (n) => console.log("tick", n));
 * bus.on("user", (u) => console.log("user", u.name));
 *
 * // Emit events
 * bus.emit("tick", 42);
 * bus.emit("user", { id: "u1", name: "Alice" });
 *
 * // Unsubscribe
 * const off = bus.on("ready", () => console.log("ready"));
 * off(); // removes listener
 *
 * // Wait for the next event
 * const user = await bus.waitFor("user");
 * console.log("waitFor resolved with", user.id);
 * ```
 *
 * When to use:
 * - Prefer `EventBusStringly` when you want a familiar, Node.js-like API that
 *   uses string event names.
 * - If you want property-style autocomplete (`bus.on.tick`), use the
 *   higher-level `eventBus<M>()` wrapper instead, which internally builds on
 *   this interface.
 */
export interface EventBusStringly<M extends EventMap> {
  readonly on: <K extends keyof M>(
    type: K,
    listener: EventBusListener<M, K>,
    opts?: AddEventListenerOptions,
  ) => EventBusDisposer;
  readonly once: <K extends keyof M>(
    type: K,
    listener: EventBusListener<M, K>,
  ) => EventBusDisposer;
  readonly off: <K extends keyof M>(
    type: K,
    listener: EventBusListener<M, K>,
  ) => void;
  readonly emit: <K extends keyof M>(
    type: K,
    ...detail: M[K] extends void ? [] : [M[K]]
  ) => boolean;

  readonly listenerCount: <K extends keyof M>(type: K) => number;
  readonly hasListener: <K extends keyof M>(type: K) => boolean;
  readonly removeAllListeners: (type?: keyof M) => void;

  readonly waitFor: <K extends keyof M>(
    type: K,
    opts?: { signal?: AbortSignal },
  ) => Promise<M[K]>;
  readonly timeoutWaitFor: <K extends keyof M>(
    type: K,
    ms: number,
  ) => Promise<M[K]>;

  readonly all: (
    listener: <K extends keyof M>(
      type: K,
      detail: M[K],
    ) => void | Promise<void>,
  ) => EventBusDisposer;

  readonly eventNames: () => (keyof M)[];
  readonly rawListeners: <K extends keyof M>(
    type: K,
  ) => EventBusListener<M, K>[];

  readonly emitParallel: <K extends keyof M>(
    type: K,
    ...detail: M[K] extends void ? [] : [M[K]]
  ) => Promise<void>;
  readonly emitSerial: <K extends keyof M>(
    type: K,
    ...detail: M[K] extends void ? [] : [M[K]]
  ) => Promise<void>;
  readonly emitSafe: <K extends keyof M>(
    type: K,
    ...detail: M[K] extends void ? [] : [M[K]]
  ) => Promise<unknown[]>;

  readonly mute: <K extends keyof M>(type: K) => void;
  readonly unmute: <K extends keyof M>(type: K) => void;
  readonly suspend: () => void;
  readonly resume: () => void;

  readonly debugListeners: () => Record<string, number>;
  readonly target: EventTarget;
}

/**
 * EventBus<M>
 *
 * The higher-level event bus interface that extends `EventBusStringly<M>` and
 * adds a **property-style API** for subscribing, unsubscribing, and emitting.
 *
 * Why it exists:
 * - While `EventBusStringly` provides string-based methods like
 *   `bus.on("tick", handler)`, this interface enhances the developer experience
 *   by exposing strongly typed properties like `bus.on.tick(handler)`.
 * - Property access gives **editor autocomplete** for event names, reducing
 *   typos and making it easier for juniors to discover available events.
 * - It is purely a **convenience layer**: the implementation delegates all
 *   logic to the underlying `EventBusStringly` while adding `Proxy` wrappers to
 *   support property-style usage.
 *
 * Companion factory: `eventBus<M>()`
 * - Applications should not construct this interface directly.
 * - Use the `eventBus` factory function to create a typed bus instance.
 * - The returned bus supports **both styles**:
 *   • String-style: `bus.on("tick", ...)`
 *   • Property-style: `bus.on.tick(...)`
 *
 * Main methods:
 * - `on.eventName(listener)` or `on("eventName", listener)`
 * - `once.eventName(listener)` or `once("eventName", listener)`
 * - `off.eventName(listener)` or `off("eventName", listener)`
 * - `emit.eventName(payload?)` or `emit("eventName", payload?)`
 * - Inherits all helpers from `EventBusStringly`:
 *   `listenerCount`, `hasListener`, `removeAllListeners`, `waitFor`,
 *   `timeoutWaitFor`, `all`, `eventNames`, `rawListeners`,
 *   `emitParallel`, `emitSerial`, `emitSafe`, `mute`, `unmute`,
 *   `suspend`, `resume`, `debugListeners`
 *
 * Example usage:
 * ```ts
 * // Define event map
 * interface AppEvents extends EventMap {
 *   ready: void;
 *   tick: number;
 *   user: { id: string; name: string };
 * }
 *
 * // Create property-style bus
 * const bus = eventBus<AppEvents>();
 *
 * // Property-style subscriptions
 * bus.on.ready(() => console.log("Ready!"));
 * bus.on.tick((n) => console.log("Tick", n));
 * bus.on.user((u) => console.log("User", u.name));
 *
 * // Property-style emits
 * bus.emit.ready();
 * bus.emit.tick(42);
 * bus.emit.user({ id: "u1", name: "Alice" });
 *
 * // Equivalent string-style calls also work
 * bus.on("tick", (n) => console.log("tick again", n));
 * bus.emit("tick", 99);
 * ```
 *
 * When to use:
 * - Prefer `EventBus` when you want **maximum type safety and autocomplete**,
 *   especially for junior developers.
 * - It builds on `EventBusStringly`, so you can always fall back to string
 *   style if you need dynamic event names.
 */
export interface EventBus<M extends EventMap> extends EventBusStringly<M> {
  readonly on:
    & EventBusStringly<M>["on"]
    & {
      [K in keyof M]: (
        listener: EventBusListener<M, K>,
        opts?: AddEventListenerOptions,
      ) => EventBusDisposer;
    };
  readonly once:
    & EventBusStringly<M>["once"]
    & {
      [K in keyof M]: (listener: EventBusListener<M, K>) => EventBusDisposer;
    };
  readonly off:
    & EventBusStringly<M>["off"]
    & {
      [K in keyof M]: (listener: EventBusListener<M, K>) => void;
    };
  readonly emit:
    & EventBusStringly<M>["emit"]
    & {
      [K in keyof M]: (...detail: M[K] extends void ? [] : [M[K]]) => boolean;
    };
}

export function eventBusStringly<M extends EventMap>(): EventBusStringly<M> {
  const target = new EventTarget();

  const listenerMap = new Map<
    string,
    Map<EventBusListener<M, keyof M>, EventListener>
  >();

  const muted = new Set<string>();
  const allListeners = new Set<
    (type: keyof M, detail: M[keyof M]) => void | Promise<void>
  >();

  let suspended = false;

  function toHandler<K extends keyof M>(
    type: K,
    listener: EventBusListener<M, K>,
  ): EventListener {
    return (ev) => {
      const ce = ev as CustomEvent<M[K]>;
      if (typeof listener === "function") {
        void listener(ce.detail);
      } else {
        void listener.handle(ce.detail);
      }
      for (const fn of allListeners) void fn(type, ce.detail);
    };
  }

  return {
    on(type, listener, opts) {
      const h = toHandler(type, listener);
      const key = type as string;
      if (!listenerMap.has(key)) listenerMap.set(key, new Map());
      (listenerMap.get(key) as Map<
        EventBusListener<M, keyof M>,
        EventListener
      >).set(listener as EventBusListener<M, keyof M>, h);
      target.addEventListener(key, h, opts);
      return () => this.off(type, listener);
    },
    once(type, listener) {
      const h = toHandler(type, listener);
      const key = type as string;
      target.addEventListener(key, h, { once: true });
      if (!listenerMap.has(key)) listenerMap.set(key, new Map());
      (listenerMap.get(key) as Map<
        EventBusListener<M, keyof M>,
        EventListener
      >).set(listener as EventBusListener<M, keyof M>, h);
      return () => this.off(type, listener);
    },
    off(type, listener) {
      const key = type as string;
      const map = listenerMap.get(key);
      const h = map?.get(listener as EventBusListener<M, keyof M>);
      if (h) {
        target.removeEventListener(key, h);
        map!.delete(listener as EventBusListener<M, keyof M>);
      }
    },
    emit(type, ...detail) {
      if (suspended || muted.has(type as string)) return false;
      return target.dispatchEvent(
        new CustomEvent(type as string, {
          detail: (detail.length ? detail[0] : undefined) as M[typeof type],
        }),
      );
    },
    listenerCount(type) {
      return listenerMap.get(type as string)?.size ?? 0;
    },
    hasListener(type) {
      return (listenerMap.get(type as string)?.size ?? 0) > 0;
    },
    removeAllListeners(type) {
      if (type) {
        const key = type as string;
        for (const h of listenerMap.get(key)?.values() ?? []) {
          target.removeEventListener(key, h);
        }
        listenerMap.delete(key);
      } else {
        for (const [k, map] of listenerMap.entries()) {
          for (const h of map.values()) target.removeEventListener(k, h);
        }
        listenerMap.clear();
        allListeners.clear();
      }
    },
    waitFor(type, opts) {
      return new Promise<M[typeof type]>((resolve, reject) => {
        const key = type as string;
        const handler = (ev: Event) => {
          resolve((ev as CustomEvent<M[typeof type]>).detail);
        };
        target.addEventListener(key, handler, { once: true });
        if (opts?.signal) {
          opts.signal.addEventListener("abort", () => {
            target.removeEventListener(key, handler);
            reject(new DOMException("Aborted", "AbortError"));
          });
        }
      });
    },
    timeoutWaitFor(type, ms) {
      return new Promise<M[typeof type]>((resolve, reject) => {
        const key = type as string;
        const timer = setTimeout(() => {
          target.removeEventListener(key, handler);
          reject(new DOMException("Timeout", "TimeoutError"));
        }, ms);
        const handler = (ev: Event) => {
          clearTimeout(timer);
          resolve((ev as CustomEvent<M[typeof type]>).detail);
        };
        target.addEventListener(key, handler, { once: true });
      });
    },
    all(listener) {
      allListeners.add(
        listener as (
          type: keyof M,
          detail: M[keyof M],
        ) => void | Promise<void>,
      );
      return () =>
        allListeners.delete(
          listener as (
            type: keyof M,
            detail: M[keyof M],
          ) => void | Promise<void>,
        );
    },
    eventNames() {
      return Array.from(listenerMap.keys()) as (keyof M)[];
    },
    rawListeners(type) {
      return Array.from(
        listenerMap.get(type as string)?.keys() ?? [],
      ) as EventBusListener<M, typeof type>[];
    },
    async emitParallel(type, ...detail) {
      if (suspended || muted.has(type as string)) return;
      const handlers = this.rawListeners(type);
      await Promise.all(
        handlers.map((fn) =>
          typeof fn === "function"
            ? fn((detail[0] ?? undefined) as M[typeof type])
            : fn.handle((detail[0] ?? undefined) as M[typeof type])
        ),
      );
    },
    async emitSerial(type, ...detail) {
      if (suspended || muted.has(type as string)) return;
      const handlers = this.rawListeners(type);
      for (const fn of handlers) {
        if (typeof fn === "function") {
          await fn((detail[0] ?? undefined) as M[typeof type]);
        } else {
          await fn.handle((detail[0] ?? undefined) as M[typeof type]);
        }
      }
    },
    async emitSafe(type, ...detail) {
      if (suspended || muted.has(type as string)) return [];
      const handlers = this.rawListeners(type);
      const errors: unknown[] = [];
      await Promise.all(
        handlers.map(async (fn) => {
          try {
            if (typeof fn === "function") {
              await fn((detail[0] ?? undefined) as M[typeof type]);
            } else {
              await fn.handle((detail[0] ?? undefined) as M[typeof type]);
            }
          } catch (err) {
            errors.push(err);
          }
        }),
      );
      return errors;
    },
    mute(type) {
      muted.add(type as string);
    },
    unmute(type) {
      muted.delete(type as string);
    },
    suspend() {
      suspended = true;
    },
    resume() {
      suspended = false;
    },
    debugListeners() {
      const out: Record<string, number> = {};
      for (const [k, map] of listenerMap.entries()) out[k] = map.size;
      return out;
    },
    target,
  };
}

export function eventBus<M extends EventMap>(): EventBus<M> {
  const base = eventBusStringly<M>();

  const on = new Proxy(base.on, {
    get: <K extends keyof M>(
      _target: EventBusStringly<M>["on"],
      prop: string,
    ) =>
    (listener: EventBusListener<M, K>, opts?: AddEventListenerOptions) =>
      base.on(prop as K, listener, opts),
  }) as EventBus<M>["on"];

  const once = new Proxy(base.once, {
    get: <K extends keyof M>(
      _target: EventBusStringly<M>["once"],
      prop: string,
    ) =>
    (listener: EventBusListener<M, K>) => base.once(prop as K, listener),
  }) as EventBus<M>["once"];

  const off = new Proxy(base.off, {
    get: <K extends keyof M>(
      _target: EventBusStringly<M>["off"],
      prop: string,
    ) =>
    (listener: EventBusListener<M, K>) => base.off(prop as K, listener),
  }) as EventBus<M>["off"];

  const emit = new Proxy(base.emit, {
    get: <K extends keyof M>(
      _target: EventBusStringly<M>["emit"],
      prop: string,
    ) =>
    (...detail: M[K] extends void ? [] : [M[K]]) =>
      base.emit(prop as K, ...(detail as M[K] extends void ? [] : [M[K]])),
  }) as EventBus<M>["emit"];

  return { ...base, on, once, off, emit };
}
