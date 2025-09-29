export function eventBus<M extends Record<string, unknown | void>>() {
  type Key = Extract<keyof M, string>;
  type Detail<K extends Key> = M[K];
  type Args<K extends Key> = Detail<K> extends void ? [] : [Detail<K>];

  type ListenerFn<K extends Key> = (...args: Args<K>) => void | Promise<void>;
  type ListenerObj<K extends Key> = { handle: ListenerFn<K> };
  type Listener<K extends Key> = ListenerFn<K> | ListenerObj<K>;

  // Internal listener type (no `any`)
  type UnknownListener =
    | ((...args: readonly unknown[]) => void | Promise<void>)
    | { handle: (...args: readonly unknown[]) => void | Promise<void> };

  type AllFn = <K extends Key>(
    type: K,
    detail: Detail<K>,
  ) => void | Promise<void>;

  const target = new EventTarget();
  const listenerMap = new Map<Key, Map<UnknownListener, EventListener>>();
  const muted = new Set<Key>();
  const allListeners = new Set<AllFn>();
  let suspended = false;

  const ensureMap = <K extends Key>(type: K) => {
    if (!listenerMap.has(type)) listenerMap.set(type, new Map());
    return listenerMap.get(type)! as unknown as Map<Listener<K>, EventListener>;
  };

  const callUser = <K extends Key>(l: Listener<K>, args: Args<K>) => {
    if (typeof l === "function") return l(...args);
    return l.handle(...args);
  };

  const toDomHandler = <K extends Key>(
    type: K,
    listener: Listener<K>,
    onceCleanup?: boolean,
  ): EventListener => {
    return (ev) => {
      const ce = ev as CustomEvent<Detail<K>>;
      const args = (ce.detail === undefined ? [] : [ce.detail]) as Args<K>;
      void callUser(listener, args);
      if (onceCleanup) {
        const map = listenerMap.get(type);
        map?.delete(listener as unknown as UnknownListener);
      }
    };
  };

  const notifyAll = <K extends Key>(type: K, detail: Detail<K>) => {
    for (const fn of allListeners) void fn(type, detail);
  };

  const api = {
    on<K extends Key>(
      type: K,
      listener: Listener<K>,
      opts?: boolean | AddEventListenerOptions,
    ) {
      const map = ensureMap(type);
      if (map.has(listener)) return () => api.off(type, listener); // de-dupe
      const h = toDomHandler(type, listener);
      map.set(listener, h);
      target.addEventListener(type, h, opts);
      return () => api.off(type, listener);
    },

    once<K extends Key>(type: K, listener: Listener<K>) {
      const map = ensureMap(type);
      if (map.has(listener)) return () => api.off(type, listener);
      const h = toDomHandler(type, listener, true);
      map.set(listener, h);
      target.addEventListener(type, h, { once: true });
      return () => api.off(type, listener);
    },

    off<K extends Key>(type: K, listener: Listener<K>) {
      const map = ensureMap(type);
      const h = map.get(listener);
      if (h) {
        target.removeEventListener(type, h);
        map.delete(listener);
        if (map.size === 0) listenerMap.delete(type);
      }
    },

    emit<K extends Key>(type: K, ...detail: Args<K>) {
      if (suspended || muted.has(type)) return false;
      const d = (detail.length ? detail[0] : undefined) as Detail<K>;
      const dispatched = target.dispatchEvent(
        new CustomEvent(type, { detail: d }),
      );
      // Notify catch-all regardless of per-event listeners
      notifyAll(type, d);
      return dispatched;
    },

    async emitParallel<K extends Key>(type: K, ...detail: Args<K>) {
      if (suspended || muted.has(type)) return;
      const handlers = api.rawListeners(type);
      const args = (detail.length ? [detail[0]] : []) as Args<K>;
      await Promise.all(handlers.map((l) => callUser(l, args)));
      // Catch-all after listeners
      notifyAll(type, (detail.length ? detail[0] : undefined) as Detail<K>);
    },

    async emitSerial<K extends Key>(type: K, ...detail: Args<K>) {
      if (suspended || muted.has(type)) return;
      const handlers = api.rawListeners(type);
      const args = (detail.length ? [detail[0]] : []) as Args<K>;
      for (const l of handlers) {
        // eslint-disable-next-line no-await-in-loop
        await callUser(l, args);
      }
      notifyAll(type, (detail.length ? detail[0] : undefined) as Detail<K>);
    },

    async emitSafe<K extends Key>(type: K, ...detail: Args<K>) {
      if (suspended || muted.has(type)) return [] as unknown[];
      const handlers = api.rawListeners(type);
      const args = (detail.length ? [detail[0]] : []) as Args<K>;
      const errors: unknown[] = [];
      await Promise.all(
        handlers.map(async (l) => {
          try {
            await callUser(l, args);
          } catch (e) {
            errors.push(e);
          }
        }),
      );
      notifyAll(type, (detail.length ? detail[0] : undefined) as Detail<K>);
      return errors;
    },

    listenerCount<K extends Key>(type: K) {
      return listenerMap.get(type)?.size ?? 0;
    },

    hasListener<K extends Key>(type: K) {
      return (listenerMap.get(type)?.size ?? 0) > 0;
    },

    removeAllListeners(type?: Key) {
      if (type) {
        const map = listenerMap.get(type);
        if (map) {
          for (const h of map.values()) target.removeEventListener(type, h);
          listenerMap.delete(type);
        }
      } else {
        for (const [k, map] of listenerMap.entries()) {
          for (const h of map.values()) target.removeEventListener(k, h);
        }
        listenerMap.clear();
        allListeners.clear();
      }
    },

    waitFor<K extends Key>(type: K, opts?: { signal?: AbortSignal }) {
      return new Promise<Detail<K>>((resolve, reject) => {
        const handler = (ev: Event) =>
          resolve((ev as CustomEvent<Detail<K>>).detail);
        target.addEventListener(type, handler, { once: true });
        if (opts?.signal) {
          const onAbort = () => {
            target.removeEventListener(type, handler);
            reject(new DOMException("Aborted", "AbortError"));
          };
          if (opts.signal.aborted) onAbort();
          else opts.signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    },

    timeoutWaitFor<K extends Key>(type: K, ms: number) {
      return new Promise<Detail<K>>((resolve, reject) => {
        const handler = (ev: Event) => {
          clearTimeout(timer);
          resolve((ev as CustomEvent<Detail<K>>).detail);
        };
        const timer = setTimeout(() => {
          target.removeEventListener(type, handler);
          reject(new DOMException("Timeout", "TimeoutError"));
        }, ms);
        target.addEventListener(type, handler, { once: true });
      });
    },

    all(listener: AllFn) {
      allListeners.add(listener);
      return () => {
        allListeners.delete(listener);
      };
    },

    eventNames() {
      return Object.freeze(Array.from(listenerMap.keys())) as readonly Key[];
    },

    rawListeners<K extends Key>(type: K) {
      const map = ensureMap(type);
      return Object.freeze(Array.from(map.keys())) as readonly Listener<K>[];
    },

    mute<K extends Key>(type: K) {
      muted.add(type);
    },
    unmute<K extends Key>(type: K) {
      muted.delete(type);
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
      return out as Readonly<typeof out>;
    },

    target,
  } as const;

  return api;
}
