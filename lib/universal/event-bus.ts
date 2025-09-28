// event-bus.ts

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

export type EventMap = Record<string, Event>;

/* ────────────────────────────────────────────────────────────────────────── */
/* Type utilities                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

type DetailOf<E> = E extends CustomEvent<infer D> ? D : never;
type PayloadOf<E> = DetailOf<E> extends void | undefined ? never : DetailOf<E>;
type InitOf<E> = E extends CustomEvent<infer D>
  ? Omit<CustomEventInit<D>, "detail">
  : EventInit;

type PayloadlessKeys<M extends EventMap> = {
  [K in keyof M & string]: PayloadOf<M[K]> extends never ? K : never;
}[keyof M & string];

type PayloadfulKeys<M extends EventMap> = Exclude<
  keyof M & string,
  PayloadlessKeys<M>
>;

/* Namespaced helper method shapes */

export type OnMethods<M extends EventMap> =
  & {
    [K in keyof M & string]: (
      listener: (evt: M[K]) => void,
      options?: boolean | AddEventListenerOptions,
    ) => () => void;
  }
  & {
    withAbort: {
      [K in keyof M & string]: (
        listener: (evt: M[K]) => void,
        options?: Omit<AddEventListenerOptions, "signal">,
      ) => AbortController;
    };
  };

export type OnceMethods<M extends EventMap> =
  & {
    [K in keyof M & string]: (
      options?: AddEventListenerOptions,
    ) => Promise<M[K]>;
  }
  & {
    withTimeout: {
      [K in keyof M & string]: (
        ms: number,
        options?: AddEventListenerOptions,
      ) => Promise<M[K]>;
    };
  };

export type EmitMethods<M extends EventMap> = {
  [K in keyof M & string]: PayloadOf<M[K]> extends never
    ? (init?: InitOf<M[K]>) => boolean
    : (detail: PayloadOf<M[K]>, init?: InitOf<M[K]>) => boolean;
};

export type EmitEventMethods<M extends EventMap> = {
  [K in PayloadlessKeys<M>]: (init?: InitOf<M[K]>) => boolean;
};

export type EmitCustomMethods<M extends EventMap> = {
  [K in PayloadfulKeys<M>]: (
    detail: PayloadOf<M[K]>,
    init?: InitOf<M[K]>,
  ) => boolean;
};

export type StreamMethods<M extends EventMap> = {
  [K in keyof M & string]: () => AsyncIterable<M[K]>;
};

/* Optional runtime registry to build native events per key */

export type EventFactoryRegistry<M extends EventMap> = {
  [K in keyof M & string]: (...args: unknown[]) => M[K];
};

/* ────────────────────────────────────────────────────────────────────────── */
/* EventBus                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

export class EventBus<M extends EventMap> extends EventTarget {
  public readonly on: OnMethods<M>;
  public readonly once: OnceMethods<M>;
  public readonly emit: EmitMethods<M>;
  public readonly emitEvent: EmitEventMethods<M>;
  public readonly emitCustom: EmitCustomMethods<M>;
  public readonly stream: StreamMethods<M>;

  constructor(
    private readonly devThrowOnUntypedDispatch = false,
    private readonly registry?: EventFactoryRegistry<M>,
  ) {
    super();
    this.on = this.#makeOn();
    this.once = this.#makeOnce();
    this.emitEvent = this.#makeEmitEvent();
    this.emitCustom = this.#makeEmitCustom();
    this.emit = this.#makeEmit();
    this.stream = this.#makeStream();
  }

  /* Native methods, kept and typed */

  public override addEventListener<K extends keyof M & string>(
    type: K,
    listener: ((evt: M[K]) => void) | { handleEvent(evt: M[K]): void } | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    super.addEventListener(
      type,
      listener as unknown as EventListenerOrEventListenerObject | null,
      options,
    );
  }

  public override removeEventListener<K extends keyof M & string>(
    type: K,
    listener: ((evt: M[K]) => void) | { handleEvent(evt: M[K]): void } | null,
    options?: boolean | EventListenerOptions,
  ): void {
    super.removeEventListener(
      type,
      listener as unknown as EventListenerOrEventListenerObject | null,
      options,
    );
  }

  // @ts-ignore — keep native signature for interop
  public override dispatchEvent(event: Event): boolean {
    if (this.devThrowOnUntypedDispatch) {
      throw new Error(
        "Use typed emitters: `bus.emit.<name>(...)`, `bus.emitEvent.<name>(...)`, or `bus.emitCustom.<name>(...)`.",
      );
    }
    return super.dispatchEvent(event);
  }

  /* Namespaced helpers */

  #makeOn(): OnMethods<M> {
    const base = new Proxy({} as OnMethods<M>, {
      get: (_t, name: string) => {
        return (
          listener: (e: Event) => void,
          options?: boolean | AddEventListenerOptions,
        ) => {
          this.addEventListener(
            name as keyof M & string,
            listener as unknown as (evt: M[keyof M & string]) => void,
            options,
          );
          return () =>
            this.removeEventListener(
              name as keyof M & string,
              listener as unknown as (evt: M[keyof M & string]) => void,
              options as EventListenerOptions | boolean | undefined,
            );
        };
      },
    });

    const withAbort = new Proxy({} as OnMethods<M>["withAbort"], {
      get: (_t, name: string) => {
        return (
          listener: (e: Event) => void,
          options?: Omit<AddEventListenerOptions, "signal">,
        ) => {
          const ac = new AbortController();
          this.addEventListener(
            name as keyof M & string,
            listener as unknown as (evt: M[keyof M & string]) => void,
            { ...(options ?? {}), signal: ac.signal },
          );
          return ac;
        };
      },
    });

    (base as unknown as { withAbort: OnMethods<M>["withAbort"] }).withAbort =
      withAbort;
    return base;
  }

  #makeOnce(): OnceMethods<M> {
    const base = new Proxy({} as OnceMethods<M>, {
      get: (_t, name: string) => {
        return (options?: AddEventListenerOptions) =>
          new Promise<Event>((resolve) => {
            this.addEventListener(
              name as keyof M & string,
              resolve as (evt: M[keyof M & string]) => void,
              { ...(options ?? {}), once: true },
            );
          }) as Promise<M[keyof M & string]>;
      },
    });

    const withTimeout = new Proxy({} as OnceMethods<M>["withTimeout"], {
      get: (_t, name: string) => {
        return (ms: number, options?: AddEventListenerOptions) =>
          new Promise<Event>((resolve, reject) => {
            const ac = new AbortController();
            const timer = setTimeout(() => {
              ac.abort();
              reject(
                new Error(
                  `Timeout waiting for "${String(name)}" after ${ms}ms`,
                ),
              );
            }, ms);
            this.addEventListener(
              name as keyof M & string,
              (e: Event) => {
                clearTimeout(timer);
                resolve(e);
              },
              { ...(options ?? {}), signal: ac.signal, once: true },
            );
          }) as Promise<M[keyof M & string]>;
      },
    });

    (base as unknown as { withTimeout: OnceMethods<M>["withTimeout"] })
      .withTimeout = withTimeout;
    return base;
  }

  #makeEmitEvent(): EmitEventMethods<M> {
    return new Proxy({} as EmitEventMethods<M>, {
      get: (_t, name: string) => {
        const eventName = String(name);
        return (init?: EventInit) =>
          super.dispatchEvent(new Event(eventName, init));
      },
    });
  }

  #makeEmitCustom(): EmitCustomMethods<M> {
    return new Proxy({} as EmitCustomMethods<M>, {
      get: (_t, name: string) => {
        const eventName = String(name);
        return (detail: unknown, init?: Record<string, unknown>) =>
          super.dispatchEvent(
            new CustomEvent(eventName, { ...(init ?? {}), detail }),
          );
      },
    });
  }

  #makeEmit(): EmitMethods<M> {
    if (this.registry) {
      const factories = this.registry;
      return new Proxy({} as EmitMethods<M>, {
        get: (_t, name: string) => {
          const key = name as keyof typeof factories;
          const make = factories[key] as
            | ((...args: unknown[]) => Event)
            | undefined;
          return (...args: unknown[]) => {
            if (!make) {
              throw new Error(
                `No event factory registered for "${String(name)}".`,
              );
            }
            const ev = make(...args);
            return super.dispatchEvent(ev);
          };
        },
      });
    }

    // No registry: avoid heuristics. Only 0 or 2 args are accepted at runtime.
    return new Proxy({} as EmitMethods<M>, {
      get: (_t, name: string) => {
        const eventName = String(name);
        return (a?: unknown, b?: unknown) => {
          const argc = arguments.length;
          if (argc === 0) {
            return super.dispatchEvent(new Event(eventName));
          }
          if (argc === 2) {
            return super.dispatchEvent(
              new CustomEvent(eventName, {
                ...(b as Record<string, unknown>),
                detail: a,
              }),
            );
          }
          throw new Error(
            `Ambiguous single-argument emit for "${eventName}". ` +
              `Use explicit emitters: emitEvent.${eventName}(init?) or emitCustom.${eventName}(detail, init?).`,
          );
        };
      },
    });
  }

  #makeStream(): StreamMethods<M> {
    return new Proxy({} as StreamMethods<M>, {
      get: (_t, name: string) => {
        const eventName = String(name);
        return function (
          this: EventBus<M>,
        ): AsyncIterable<M[keyof M & string]> {
          return {
            [Symbol.asyncIterator]: () => {
              const queue: Event[] = [];
              let notify: (() => void) | null = null;

              const onEvent = (e: Event) => {
                queue.push(e);
                if (notify) {
                  const n = notify;
                  notify = null;
                  n();
                }
              };

              const ac = new AbortController();
              this.addEventListener(
                eventName as keyof M & string,
                onEvent as (evt: M[keyof M & string]) => void,
                { signal: ac.signal },
              );

              return {
                next: async () => {
                  if (queue.length === 0) {
                    await new Promise<void>((resolve) => {
                      notify = resolve;
                    });
                  }
                  const value = queue.shift() as M[keyof M & string];
                  return { done: false, value };
                },
                return: () => {
                  ac.abort();
                  return Promise.resolve({
                    done: true,
                    value: undefined as unknown as M[keyof M & string],
                  });
                },
                throw: (err?: unknown) => {
                  ac.abort();
                  return Promise.reject(err);
                },
              };
            },
          };
        }.bind(this);
      },
    });
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Safe wrapper for an existing native EventTarget                           */
/* ────────────────────────────────────────────────────────────────────────── */

export function wrapEventTarget<M extends EventMap>(
  target: EventTarget,
  devThrowOnUntypedDispatch = false,
  registry?: EventFactoryRegistry<M>,
): EventBus<M> {
  class DelegatingBus extends EventBus<M> {
    public override addEventListener<K extends keyof M & string>(
      type: K,
      listener: ((evt: M[K]) => void) | { handleEvent(evt: M[K]): void } | null,
      options?: boolean | AddEventListenerOptions,
    ): void {
      target.addEventListener(
        type,
        listener as unknown as EventListenerOrEventListenerObject | null,
        options,
      );
    }
    public override removeEventListener<K extends keyof M & string>(
      type: K,
      listener: ((evt: M[K]) => void) | { handleEvent(evt: M[K]): void } | null,
      options?: boolean | EventListenerOptions,
    ): void {
      target.removeEventListener(
        type,
        listener as unknown as EventListenerOrEventListenerObject | null,
        options,
      );
    }
    // @ts-ignore — keep native signature for interop
    public override dispatchEvent(event: Event): boolean {
      if (devThrowOnUntypedDispatch) {
        throw new Error(
          "Use typed emitters: `bus.emit.<name>(...)`, `bus.emitEvent.<name>(...)`, or `bus.emitCustom.<name>(...)`.",
        );
      }
      return target.dispatchEvent(event);
    }
  }
  return new DelegatingBus(devThrowOnUntypedDispatch, registry);
}
