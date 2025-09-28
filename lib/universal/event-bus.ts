/**
 * # event-bus.ts
 *
 * ## Purpose
 *
 * This module provides a **type-safe EventBus** abstraction for Deno/TypeScript projects.
 *
 * - **For junior developers:** it exposes a **simple API** (`on`, `once`, `off`, `emit`)
 *   with both string-style (`bus.emit("tick", 42)`) and property-style
 *   (`bus.emit.tick(42)`) access. They never need to learn about
 *   `EventTarget` or `CustomEvent`.
 * - **For senior developers:** the implementation is a very thin layer on top
 *   of the browser-standard `EventTarget` and `CustomEvent`. We **do not
 *   reinvent** event dispatching. This ensures familiar semantics, predictable
 *   behavior, and interoperability with native APIs.
 *
 * ## Usage
 *
 * Define your own event map where keys are event names and values are the
 * payload (detail) types:
 *
 * ```ts
 * interface AppEvents {
 *   ready: void;
 *   tick: number;
 *   user: { id: string; name: string };
 * }
 *
 * const bus = eventBus<AppEvents>();
 *
 * bus.on.ready(() => console.log("ready!"));
 * bus.emit.ready();
 *
 * bus.on("tick", (n) => console.log("tick", n));
 * bus.emit("tick", 123);
 *
 * const disposer = bus.on.user((u) => console.log("user", u));
 * disposer(); // unsubscribe
 *
 * const u = await bus.waitFor("user");
 * console.log(u.id);
 * ```
 *
 * ## Philosophy
 *
 * - We **delegate** directly to `EventTarget` for listener registration and
 *   dispatch, and use `CustomEvent<T>` to carry typed `detail` payloads.
 * - No custom queueing, no reimplementation of pub/sub — just type-safe wrappers.
 * - This ensures the public API feels ergonomic and modern, while keeping the
 *   underlying mechanics **standard, minimal, and reliable**.
 *
 * ## Summary of Types
 *
 * - `EventMap`: An interface mapping event names (`string` keys) to payload
 *   types (`unknown | void`).
 *
 * - `EventBusListener<M, K>`: A listener function or object for event `K`
 *   from event map `M`. Accepts only the `detail` payload.
 *   ```ts
 *   (detail: M[K]) => void | Promise<void>
 *   { handle(detail: M[K]): void | Promise<void> }
 *   ```
 *
 * - `EventBusDisposer`: A `() => void` function returned by `.on.*` that
 *   unsubscribes the listener.
 *
 * - `EventBusStringly<M>`: String-style API:
 *   ```ts
 *   bus.on("tick", handler)
 *   bus.emit("tick", payload)
 *   ```
 *
 * - `EventBus<M>`: Property-style API:
 *   ```ts
 *   bus.on.tick(handler)
 *   bus.emit.tick(payload)
 *   ```
 *
 * ## Developer Notes (for maintainers)
 *
 * - We maintain **maps of original listeners to their wrapped EventListener**
 *   so `.off` works correctly. This avoids the common pitfall where `off`
 *   fails because the wrapper function reference is lost.
 * - `waitFor` and `timeoutWaitFor` build on top of `once` semantics and
 *   Promises, useful for async flows and testing.
 * - `listenerCount`, `hasListener`, and `removeAllListeners` are **ergonomic
 *   utilities** added for junior developers, not because `EventTarget`
 *   required them.
 * - The **only casts** are where we cross the generic boundary between
 *   `CustomEvent.detail` and the type-safe event map; they are localized and
 *   safe.
 * - We rely entirely on `EventTarget`’s native dispatch cycle — no attempt is
 *   made to alter bubbling, cancelation, or ordering.
 */
export interface EventMap {
  [event: string]: unknown | void;
}

export type EventBusListener<M extends EventMap, K extends keyof M> =
  | ((detail: M[K]) => void | Promise<void>)
  | { handle(detail: M[K]): void | Promise<void> };

export type EventBusDisposer = () => void;

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
  readonly target: EventTarget;
}

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

/**
 * Create a **string-style event bus** built on top of `EventTarget` and `CustomEvent`.
 *
 * ## How It Works
 *
 * - Internally, a single `EventTarget` instance (`target`) is created.
 * - When you call `.on("event", listener)`, we:
 *   1. Wrap your type-safe `listener` (function or object with `handle`) into a
 *      standard DOM `EventListener`.
 *   2. Store the mapping between your original listener and the wrapper in
 *      `listenerMap` so we can later remove it with `.off`.
 *   3. Call `target.addEventListener("event", wrapper, opts)`.
 * - When you call `.emit("event", payload)`, we:
 *   1. Construct a `CustomEvent` with `detail` set to the typed payload.
 *   2. Call `target.dispatchEvent(customEvent)`, letting the browser-standard
 *      event dispatch handle ordering and error propagation.
 * - When you call `.off("event", listener)`, we:
 *   1. Look up the stored wrapper for your original listener.
 *   2. Call `target.removeEventListener("event", wrapper)`.
 *   3. Remove it from our map so it doesn’t leak.
 *
 * ## Why String-Style?
 *
 * - Junior developers are often familiar with `.on("event", handler)` style from
 *   Node.js and many libraries.
 * - This API preserves autocomplete on event names while keeping syntax simple.
 * - If you want property-style (`bus.on.event(handler)`), use {@link eventBus}.
 *
 * ## Example
 *
 * ```ts
 * interface AppEvents {
 *   ready: void;
 *   tick: number;
 *   user: { id: string; name: string };
 * }
 *
 * const bus = eventBusStringly<AppEvents>();
 *
 * // Listen to events
 * const offTick = bus.on("tick", (n) => console.log("tick", n));
 *
 * // Emit events
 * bus.emit("tick", 42);
 *
 * // Remove a listener
 * offTick();
 *
 * // Promise-based listener
 * const user = await bus.waitFor("user");
 * console.log(user.id);
 *
 * // Remove all listeners
 * bus.removeAllListeners();
 * ```
 *
 * ## Notes for Maintainers
 *
 * - We use a nested `Map<string, Map<originalListener, wrapper>>` to track
 *   listeners. This ensures `.off` is precise and works with both function
 *   and object-style listeners.
 * - All helpers (`listenerCount`, `hasListener`, `waitFor`, etc.) are
 *   convenience utilities built on top of the native `EventTarget`.
 * - No custom dispatch system is created — this is purely type-safe sugar
 *   around `EventTarget` and `CustomEvent`.
 */
export function eventBusStringly<M extends EventMap>(): EventBusStringly<M> {
  const target = new EventTarget();
  const listenerMap = new Map<
    string,
    Map<EventBusListener<M, keyof M>, EventListener>
  >();

  function toHandler<K extends keyof M>(
    listener: EventBusListener<M, K>,
  ): EventListener {
    return (ev) => {
      const ce = ev as CustomEvent<M[K]>;
      if (typeof listener === "function") {
        void listener(ce.detail);
      } else {
        void listener.handle(ce.detail);
      }
    };
  }

  return {
    on(type, listener, opts) {
      const h = toHandler(listener);
      const key = type as string;
      if (!listenerMap.has(key)) listenerMap.set(key, new Map());
      listenerMap.get(key)!.set(listener as EventBusListener<M, keyof M>, h);
      target.addEventListener(key, h, opts);
      return () => {
        this.off(type, listener);
      };
    },
    once(type, listener) {
      const h = toHandler(listener);
      const key = type as string;
      target.addEventListener(key, h, { once: true });
      return () => {
        this.off(type, listener);
      };
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
    target,
  };
}

/**
 * Create a **property-style event bus** that builds directly on top of
 * {@link eventBusStringly}.
 *
 * ## How It Works
 *
 * - This function **does not reimplement** any event system.
 *   Instead, it calls {@link eventBusStringly} internally to create a
 *   fully functional string-style bus, and then wraps it with `Proxy`
 *   objects to provide property-style access.
 *
 * - For each method group (`on`, `once`, `off`, `emit`), we:
 *   1. Return the original string-style method so you can still use
 *      `bus.on("tick", handler)`.
 *   2. Wrap it in a `Proxy` that intercepts property access
 *      (`bus.on.tick`) and dynamically returns a function that
 *      delegates to the string-style method with the property name
 *      as the event key.
 *
 * - Example: `bus.emit.tick(42)` → internally becomes
 *   `base.emit("tick", 42)`.
 *
 * ## Why Property-Style?
 *
 * - Juniors benefit from **strong autocomplete** in editors: typing
 *   `bus.on.` shows all event names defined in the event map.
 * - It prevents typos in string keys while keeping syntax concise.
 * - It’s purely a **convenience layer**: nothing changes in semantics,
 *   and it’s always safe to fall back to string-style methods.
 *
 * ## Example
 *
 * ```ts
 * interface AppEvents {
 *   ready: void;
 *   tick: number;
 *   user: { id: string; name: string };
 * }
 *
 * const bus = eventBus<AppEvents>();
 *
 * // Property-style subscriptions
 * bus.on.ready(() => console.log("ready!"));
 * bus.on.tick((n) => console.log("tick", n));
 *
 * // Property-style emits
 * bus.emit.ready();
 * bus.emit.tick(42);
 *
 * // Equivalent string-style calls still work
 * bus.on("user", (u) => console.log("user", u));
 * bus.emit("user", { id: "1", name: "Alice" });
 * ```
 *
 * ## Notes for Maintainers
 *
 * - This function is intentionally **thin**. All actual dispatch logic,
 *   listener tracking, and utility methods come from
 *   {@link eventBusStringly}.
 * - The `Proxy` traps are typed with `<K extends keyof M>` generics so
 *   property access preserves strong typing.
 * - Because it’s built on the string-style version, any bugfix or
 *   improvement in {@link eventBusStringly} automatically benefits
 *   property-style usage.
 */
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
