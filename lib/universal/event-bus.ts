/**
 * # event-bus.ts
 *
 * A **type-safe EventBus** built on top of `EventTarget` and `CustomEvent`.
 *
 * ## Purpose
 *
 * - **For juniors:** provide a simple, strongly typed API (`on`, `once`, `off`, `emit`)
 *   without exposing `EventTarget` or `CustomEvent`.
 * - **For seniors:** no reinvention — all functionality delegates directly
 *   to `EventTarget` and `CustomEvent`, ensuring familiar, predictable semantics.
 *
 * ## Features
 *
 * - Two styles of API:
 *   - **String-style:** `bus.on("tick", handler)` / `bus.emit("tick", 42)`
 *   - **Property-style:** `bus.on.tick(handler)` / `bus.emit.tick(42)`
 * - Typed payloads (`detail`) for each event.
 * - Utilities for developer ergonomics:
 *   - `listenerCount`, `hasListener`, `removeAllListeners`
 *   - `waitFor`, `timeoutWaitFor`
 *   - `all` (catch-all listener), `eventNames`, `rawListeners`
 *   - `emitParallel`, `emitSerial`, `emitSafe`
 *   - `mute` / `unmute` (per-event), `suspend` / `resume` (global)
 *   - `debugListeners` (introspection)
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
