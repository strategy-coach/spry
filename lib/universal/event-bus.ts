/**
 * A tiny, **type-safe layer on top of the native `EventTarget`**.
 *
 * Design principles
 * - **Do not invent a new event system.** This file only wraps `EventTarget` and native `Event`/`CustomEvent`.
 * - **Maximize type-safety**: event names and payloads are checked at compile time.
 * - **Junior-friendly DX**: namespaced helpers (`on`, `once`, `emit`, `stream`) with auto-unsubscribe and timeouts.
 * - **Interop-first**: keep native methods (`addEventListener`, `removeEventListener`, `dispatchEvent`) intact.
 *
 * Highlights
 * - `bus.on.xyz(listener, options?) -> () => void` (unsubscribe function)
 * - `bus.on.withAbort.xyz(listener, options?) -> AbortController` (idiomatic native unsubscribe)
 * - `await bus.once.xyz(options?)` and `await bus.once.withTimeout.xyz(ms, options?)`
 * - `bus.emit.xyz(...)` (ergonomic) plus explicit `bus.emitEvent.xyz(init?)` and `bus.emitCustom.xyz(detail, init?)`
 *   to avoid any runtime ambiguity while staying purely native.
 * - `for await (const e of bus.stream.xyz()) { ... }` (async iterator, no polling)
 *
 * Example
 * ```ts
 * interface AppEvents {
 *   start: Event;                                    // payloadless (Event)
 *   progress: CustomEvent<{ pct: number }>;          // payloadful (CustomEvent<{pct:number}>)
 *   done: CustomEvent<void>;                         // treated as payloadless for DX
 * }
 *
 * const bus = new EventBus<AppEvents>();
 *
 * // Subscribe
 * const off = bus.on.progress(e => console.log(e.detail.pct));
 * const ac = bus.on.withAbort.start(() => console.log("start"), { passive: true });
 * // Later:
 * off();
 * ac.abort();
 *
 * // Emit (ergonomic)
 * bus.emit.start({ bubbles: true });                 // EventInit
 * bus.emit.progress({ pct: 50 }, { bubbles: true }); // detail + CustomEventInit (minus detail)
 * bus.emit.done();                                   // payloadless (treated like Event)
 *
 * // One-shot
 * await bus.once.done();
 * await bus.once.withTimeout.progress(2000);
 *
 * // Streams
 * for await (const e of bus.stream.progress()) {
 *   if (e.detail.pct >= 100) break;
 * }
 * ```
 */

/* ────────────────────────────────────────────────────────────────────────── */
/* Type utilities                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

/** Constrain a map so all values are `Event` subclasses. */
export type ValueIsEvent<T> = { [K in keyof T]: Event };

/** Extract `detail` from `CustomEvent<Detail>`, else `never`. */
type DetailOf<E> = E extends CustomEvent<infer D> ? D : never;

/**
 * Normalize payload type for DX:
 * - `Event`         → never (payloadless)
 * - `CustomEvent<void | undefined>` → never (treated as payloadless)
 * - `CustomEvent<D>` where D is anything else → D
 */
type PayloadOf<E> = DetailOf<E> extends void | undefined ? never : DetailOf<E>;

/** Initialization options: `Event` → `EventInit`; `CustomEvent<D>` → `Omit<CustomEventInit<D>, "detail">`. */
type InitOf<E> = E extends CustomEvent<infer D> ? Omit<CustomEventInit<D>, "detail"> : EventInit;

/** Keys for payloadless events. */
type PayloadlessKeys<M extends ValueIsEvent<M>> = {
  [K in keyof M & string]: PayloadOf<M[K]> extends never ? K : never;
}[keyof M & string];

/** Keys for payloadful (CustomEvent with real payload) events. */
type PayloadfulKeys<M extends ValueIsEvent<M>> = Exclude<keyof M & string, PayloadlessKeys<M>>;

/* ────────────────────────────────────────────────────────────────────────── */
/* Namespaced helper method shapes                                           */
/* ────────────────────────────────────────────────────────────────────────── */

/** `on.xyz(listener, options?) -> () => void` */
export type OnMethods<M extends ValueIsEvent<M>> = {
  [K in keyof M & string]: (
    listener: (evt: M[K]) => void,
    options?: boolean | AddEventListenerOptions
  ) => () => void;
} & {
  /** Native, abort-friendly subscription: returns an AbortController. */
  withAbort: {
    [K in keyof M & string]: (
      listener: (evt: M[K]) => void,
      options?: Omit<AddEventListenerOptions, "signal">
    ) => AbortController;
  };
};

/** `await once.xyz(options?) -> Promise<Event>` */
export type OnceMethods<M extends ValueIsEvent<M>> = {
  [K in keyof M & string]: (
    options?: AddEventListenerOptions
  ) => Promise<M[K]>;
} & {
  /** `await once.withTimeout.xyz(ms, options?)` → rejects if not received in time. */
  withTimeout: {
    [K in keyof M & string]: (
      ms: number,
      options?: AddEventListenerOptions
    ) => Promise<M[K]>;
  };
};

/** Ergonomic `emit` union: payloadless → (init?), payloadful → (detail, init?). */
export type EmitMethods<M extends ValueIsEvent<M>> = {
  [K in keyof M & string]:
    PayloadOf<M[K]> extends never
      ? (init?: InitOf<M[K]>) => boolean
      : (detail: PayloadOf<M[K]>, init?: InitOf<M[K]>) => boolean;
};

/** Explicit payloadless emit: `emitEvent.xyz(init?)`. */
export type EmitEventMethods<M extends ValueIsEvent<M>> = {
  [K in PayloadlessKeys<M>]: (init?: InitOf<M[K]>) => boolean;
};

/** Explicit payloadful emit: `emitCustom.xyz(detail, init?)`. */
export type EmitCustomMethods<M extends ValueIsEvent<M>> = {
  [K in PayloadfulKeys<M>]: (
    detail: PayloadOf<M[K]>,
    init?: InitOf<M[K]>
  ) => boolean;
};

/** `stream.xyz()` returns `AsyncIterable<Event>`; no polling, purely event-driven. */
export type StreamMethods<M extends ValueIsEvent<M>> = {
  [K in keyof M & string]: () => AsyncIterable<M[K]>;
};

/* ────────────────────────────────────────────────────────────────────────── */
/* Optional runtime registry                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Optional registry letting you **declare how to construct native events per name**.
 * This preserves 100% native semantics while eliminating any runtime ambiguity.
 *
 * If provided, `emit` delegates to the registry; if omitted, `emit` uses a conservative
 * rule: 0 args → `Event`, 2 args → `CustomEvent(detail, init)`, and 1 arg is **ambiguous**
 * and will throw with guidance to use `emitEvent` or `emitCustom`.
 */
export type EventFactoryRegistry<M extends ValueIsEvent<M>> = {
  [K in keyof M & string]: (...args: any[]) => M[K];
};

/* ────────────────────────────────────────────────────────────────────────── */
/* EventBus                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Strongly-typed event bus built on top of **native `EventTarget`**.
 *
 * - Retains native methods (typed) for maximal interop.
 * - Adds namespaced helpers:
 *   - `on`, `on.withAbort`
 *   - `once`, `once.withTimeout`
 *   - `emit` (ergonomic), `emitEvent` (payloadless), `emitCustom` (payloadful)
 *   - `stream` (async iterable)
 */
export class EventBus<M extends ValueIsEvent<M>> extends EventTarget {
  /** Namespaced subscription helpers. */
  public readonly on: OnMethods<M>;

  /** Namespaced one-shot helpers. */
  public readonly once: OnceMethods<M>;

  /**
   * Ergonomic emitter.
   *
   * - If a **registry** is provided, `emit` will always construct the correct native class.
   * - If **no registry** is provided:
   *     - 0 args → `new Event(name)`
   *     - 2 args → `new CustomEvent(name, { detail, ...init })`
   *     - 1 arg → **ambiguous** at runtime (types prevent mistakes), so we throw with guidance
   *       to use `emitEvent.name(init?)` or `emitCustom.name(detail, init?)`.
   */
  public readonly emit: EmitMethods<M>;

  /** Explicit payloadless emit: `emitEvent.xyz(init?)` */
  public readonly emitEvent: EmitEventMethods<M>;

  /** Explicit payloadful emit: `emitCustom.xyz(detail, init?)` */
  public readonly emitCustom: EmitCustomMethods<M>;

  /** Async streams per event: `for await (const e of bus.stream.xyz())` */
  public readonly stream: StreamMethods<M>;

  /**
   * @param devThrowOnUntypedDispatch  If true, calling untyped `dispatchEvent` throws (dev safety).
   * @param registry                    Optional per-name factory to produce native events, ensuring
   *                                    zero runtime ambiguity for `emit`.
   */
  constructor(
    private readonly devThrowOnUntypedDispatch = false,
    private readonly registry?: EventFactoryRegistry<M>
  ) {
    super();
    this.on = this.#makeOn();
    this.once = this.#makeOnce();
    this.emitEvent = this.#makeEmitEvent();
    this.emitCustom = this.#makeEmitCustom();
    this.emit = this.#makeEmit();        // delegates to registry or explicit emitters
    this.stream = this.#makeStream();
  }

  /* ——— Native methods, kept and typed ———————————————————————————————— */

  /** Typed `addEventListener` (fully native semantics). */
  public override addEventListener<K extends keyof M & string>(
    type: K,
    listener: ((evt: M[K]) => void) | { handleEvent(evt: M[K]): void } | null,
    options?: boolean | AddEventListenerOptions
  ): void {
    super.addEventListener(type, listener as any, options);
  }

  /** Typed `removeEventListener` (fully native semantics). */
  public override removeEventListener<K extends keyof M & string>(
    type: K,
    listener: ((evt: M[K]) => void) | { handleEvent(evt: M[K]): void } | null,
    options?: boolean | EventListenerOptions
  ): void {
    super.removeEventListener(type, listener as any, options);
  }

  /**
   * Untyped dispatch remains available for interop.
   * Set `devThrowOnUntypedDispatch=true` to catch accidental usage in development.
   */
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — keep native signature
  public override dispatchEvent(event: Event): boolean {
    if (this.devThrowOnUntypedDispatch) {
      throw new Error(
        "Use typed emitters: `bus.emit.<name>(...)`, `bus.emitEvent.<name>(...)`, or `bus.emitCustom.<name>(...)`."
      );
    }
    return super.dispatchEvent(event);
  }

  /* ——— Namespaced helpers ———————————————————————————————————————— */

  /** `on.xyz(listener, options?) -> () => void` and `on.withAbort.xyz(...) -> AbortController` */
  #makeOn(): OnMethods<M> {
    const base = new Proxy({} as OnMethods<M>, {
      get: (_t, name: string) => {
        return ((listener: (e: Event) => void, options?: boolean | AddEventListenerOptions) => {
          this.addEventListener(name as any, listener as any, options);
          return () => this.removeEventListener(name as any, listener as any, options as any);
        }) as any;
      },
    });

    const withAbort = new Proxy({} as OnMethods<M>["withAbort"], {
      get: (_t, name: string) => {
        return ((listener: (e: Event) => void, options?: Omit<AddEventListenerOptions, "signal">) => {
          const ac = new AbortController();
          this.addEventListener(name as any, listener as any, { ...(options ?? {}), signal: ac.signal });
          return ac;
        }) as any;
      },
    });

    (base as any).withAbort = withAbort;
    return base;
  }

  /** `once.xyz(options?) -> Promise<Event>` and `once.withTimeout.xyz(ms, options?)` */
  #makeOnce(): OnceMethods<M> {
    const base = new Proxy({} as OnceMethods<M>, {
      get: (_t, name: string) => {
        return ((options?: AddEventListenerOptions) =>
          new Promise<Event>((resolve) => {
            this.addEventListener(name as any, resolve as any, { ...(options ?? {}), once: true });
          })) as any;
      },
    });

    const withTimeout = new Proxy({} as OnceMethods<M>["withTimeout"], {
      get: (_t, name: string) => {
        return ((ms: number, options?: AddEventListenerOptions) =>
          new Promise<Event>((resolve, reject) => {
            const ac = new AbortController();
            const timer = setTimeout(() => {
              ac.abort();
              reject(new Error(`Timeout waiting for "${String(name)}" after ${ms}ms`));
            }, ms);
            this.addEventListener(
              name as any,
              (e) => { clearTimeout(timer); resolve(e as Event); },
              { ...(options ?? {}), signal: ac.signal, once: true },
            );
          })) as any;
      },
    });

    (base as any).withTimeout = withTimeout;
    return base;
  }

  /** Explicit payloadless emit namespace: `emitEvent.xyz(init?)` → `new Event(name, init)` */
  #makeEmitEvent(): EmitEventMethods<M> {
    return new Proxy({} as EmitEventMethods<M>, {
      get: (_t, name: string) => {
        const eventName = String(name);
        return ((init?: EventInit) =>
          super.dispatchEvent(new Event(eventName, init))) as any;
      },
    });
  }

  /** Explicit payloadful emit namespace: `emitCustom.xyz(detail, init?)` → `new CustomEvent(name, {detail, ...init})` */
  #makeEmitCustom(): EmitCustomMethods<M> {
    return new Proxy({} as EmitCustomMethods<M>, {
      get: (_t, name: string) => {
        const eventName = String(name);
        return ((detail: unknown, init?: Record<string, unknown>) =>
          super.dispatchEvent(new CustomEvent(eventName, { ...(init ?? {}), detail }))) as any;
      },
    });
  }

  /**
   * Ergonomic emit namespace.
   *
   * Behavior:
   * - If a **registry** is provided, we delegate to it for construction (always correct).
   * - Without a registry:
   *    - 0 args  → `Event`
   *    - 2 args  → `CustomEvent(detail, init)`
   *    - 1 arg   → **ambiguous** (types prevent mistakes at compile time, but at runtime we
   *                cannot know if it's `EventInit` or `detail`). To keep correctness, we
   *                throw with instructions to call `emitEvent.<name>(init?)` or `emitCustom.<name>(detail, init?)`.
   */
  #makeEmit(): EmitMethods<M> {
    if (this.registry) {
      // Zero-ambiguity path using the registry.
      const factories = this.registry;
      return new Proxy({} as EmitMethods<M>, {
        get: (_t, name: string) => {
          const key = name as keyof typeof factories;
          const make = factories[key] as any;
          return ((...args: any[]) => super.dispatchEvent(make(...args))) as any;
        },
      });
    }

    // Conservative, ambiguity-free default (with guidance).
    return new Proxy({} as EmitMethods<M>, {
      get: (_t, name: string) => {
        const eventName = String(name);
        return ((a?: unknown, b?: unknown) => {
          const argc = arguments.length;
          if (argc === 0) {
            return super.dispatchEvent(new Event(eventName));
          }
          if (argc === 2) {
            return super.dispatchEvent(new CustomEvent(eventName, { ...(b as object), detail: a }));
          }
          // argc === 1 is ambiguous at runtime; throw with guidance.
          throw new Error(
            `Ambiguous single-argument emit for "${eventName}". ` +
            `Use explicit emitters: emitEvent.${eventName}(init?) or emitCustom.${eventName}(detail, init?).`
          );
        }) as any;
      },
    });
  }

  /** `stream.xyz()` → AsyncIterable with no polling (purely event-driven). */
  #makeStream(): StreamMethods<M> {
    return new Proxy({} as StreamMethods<M>, {
      get: (_t, name: string) => {
        const eventName = String(name);
        const self = this;

        return (function streamFactory(): AsyncIterable<M[keyof M & string]> {
          return {
            [Symbol.asyncIterator]() {
              const queue: Event[] = [];
              let notify: (() => void) | null = null;

              const onEvent = (e: Event) => {
                queue.push(e);
                if (notify) { const n = notify; notify = null; n(); }
              };

              const ac = new AbortController();
              self.addEventListener(eventName as any, onEvent as any, { signal: ac.signal });

              return {
                async next() {
                  if (queue.length === 0) {
                    await new Promise<void>((resolve) => { notify = resolve; });
                  }
                  const value = queue.shift() as any;
                  return { done: false, value };
                },
                async return() {
                  ac.abort();
                  return { done: true, value: undefined as any };
                },
                async throw(err?: unknown) {
                  ac.abort();
                  throw err;
                },
              };
            },
          } as AsyncIterable<any>;
        }) as any;
      },
    });
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Safe wrapper for an existing native EventTarget                           */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Wrap an existing native `EventTarget` (e.g., `window`, `document`, `HTMLElement`, `MessagePort`)
 * with the **typed** `EventBus` helpers — without mutating its prototype or behavior.
 *
 * Interop: listeners you add/remove through the wrapper are added/removed on the underlying target.
 *
 * @example
 * ```ts
 * interface WinEvents {
 *   resize: Event;
 *   message: MessageEvent<any>;
 * }
 * const tw = wrapEventTarget<WinEvents>(window);
 * tw.on.resize(() => console.log("resized"));
 * tw.emit.resize(); // equivalent to dispatching `new Event("resize")`
 * ```
 */
export function wrapEventTarget<M extends ValueIsEvent<M>>(
  target: EventTarget,
  devThrowOnUntypedDispatch = false,
  registry?: EventFactoryRegistry<M>
): EventBus<M> {
  class DelegatingBus extends EventBus<M> {
    public override addEventListener(...args: Parameters<EventBus<M>["addEventListener"]>): void {
      (target as any).addEventListener(...(args as any));
    }
    public override removeEventListener(...args: Parameters<EventBus<M>["removeEventListener"]>): void {
      (target as any).removeEventListener(...(args as any));
    }
    public override dispatchEvent(event: Event): boolean {
      if (devThrowOnUntypedDispatch) {
        throw new Error(
          "Use typed emitters: `bus.emit.<name>(...)`, `bus.emitEvent.<name>(...)`, or `bus.emitCustom.<name>(...)`."
        );
      }
      return (target as any).dispatchEvent(event);
    }
  }
  return new DelegatingBus(devThrowOnUntypedDispatch, registry);
}
