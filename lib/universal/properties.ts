/**
 * @module properties
 *
 * Zod-first, event-driven, type-safe properties.
 *
 * ## Core concepts
 * - **Define once in camelCase**: Write your Zod object schema using camelCase keys.
 * - **Zod owns semantics**: Types, defaults, refinements, transforms, `.describe()`, and `.meta()`.
 * - **Evented bag**: `assemblerProperties()` validates, sets, loads, and emits typed events.
 * - **Read-only view**: `propertiesQuery()` lists/filters/picks without mutation concerns.
 * - **Naming strategies**: Present or map names (camelCase/snake_case/SCREAMING_SNAKE/kebab/Pascal) via `PropertyNamingStrategy`.
 * - **Pluggable loaders**: `envLoader`, `jsonLoader`, `sqlRowLoader` use strategies and respect per-field `meta.externalName`.
 *
 * ## Quick start
 * ```ts
 * import { z } from "jsr:@zod/zod@4";
 * import {
 *   assemblerProperties, propertiesQuery,
 *   envLoader, jsonLoader, Naming,
 * } from "./properties.ts";
 *
 * // 1) Define schema in camelCase
 * const SpryProps = z.object({
 *   databaseUrl: z.string().url()
 *     .describe("DB connection string")
 *     .meta({ required: true, tags: ["infra","sql"], sourceHint: "env" }),
 *   pageLimit: z.coerce.number().int().positive().max(10_000)
 *     .default(100).describe("Default LIMIT").meta({ tags: ["sql"] }),
 *   mode: z.enum(["discovery","materialization","both"])
 *     .default("both").describe("Active phase(s)")
 *     .meta({ externalName: "assembly_mode", tags: ["spry"] }),
 *   secretToken: z.string().min(12).optional()
 *     .describe("Service token").meta({ redact: true, tags: ["secret"] }),
 * });
 *
 * // 2) Create the bag and load values (env → json)
 * const bag = assemblerProperties(SpryProps);
 * await bag.loadAll([
 *   envLoader({ prefix: "SPRY" }),                             // SPRY_DATABASE_URL, SPRY_MODE, ...
 *   jsonLoader({ page_limit: 500, assembly_mode: "discovery" })// snake_case mapping by default
 * ]);
 *
 * // 3) Read-only queries & naming
 * const q = propertiesQuery(bag);
 * console.table(q.list({ nameAs: Naming.screamingSnake, redactSecrets: true }));
 * // → rows with name: "DATABASE_URL", "PAGE_LIMIT", ...
 * ```
 */

import { z } from "jsr:@zod/zod@4";
import { eventBus } from "./event-bus.ts";
import process from "node:process";

/* ────────────────────────────────────────────────────────────────────────── */
/* Zod v4 metadata & description helpers                                      */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Extra, optional metadata you can attach to a field via `zodSchema.meta({...})`.
 * None of these keys are required by the library—use what helps your DX.
 */
export type Meta = {
  /** External key/name (e.g., env var, JSON key, SQL column) to prefer over strategy output. */
  externalName?: string;
  /** Arbitrary tags for grouping/filtering in UIs and consoles. */
  tags?: readonly string[];
  /** If true, `propertiesQuery.list({redactSecrets:true})` masks string values. */
  redact?: boolean;
  /** Operational “must be present” flag, in addition to Zod optionality. */
  required?: boolean;
  /** Human hint about likely source: "env" | "sql" | "file" | "computed" | ... */
  sourceHint?: string;
  /** Optional description; `.describe()` usually supplies this (but we also read here). */
  description?: string;
  /** Future-proof escape hatch—store any additional metadata keys here. */
  [k: string]: unknown;
};

/**
 * Get metadata for a Zod node, working across Zod v4 builds.
 * @internal
 */
const metaOf = (s: z.ZodTypeAny): Meta | undefined => {
  type WithMetaFns = {
    meta?: () => unknown;
    getMeta?: () => unknown;
    _def?: Record<string, unknown>;
    def?: Record<string, unknown>;
  };
  const node = s as unknown as WithMetaFns;

  if (typeof node.meta === "function") {
    try {
      const m = node.meta();
      if (m && typeof m === "object") return m as Meta;
    } catch { /* ignore */ }
  }
  if (typeof node.getMeta === "function") {
    try {
      const m = node.getMeta();
      if (m && typeof m === "object") return m as Meta;
    } catch { /* ignore */ }
  }
  const def = (node._def ?? node.def ?? {}) as Record<string, unknown>;
  const maybe =
    (def.meta ?? (def as Record<string, unknown>).metadata) as unknown;
  return (maybe && typeof maybe === "object") ? maybe as Meta : undefined;
};

/**
 * Get human description for a Zod node, preferring public `.description`,
 * then internals, then metadata mirror.
 * @internal
 */
const descOf = (s: z.ZodTypeAny): string | undefined => {
  type WithDesc = {
    description?: unknown;
    _def?: Record<string, unknown>;
    def?: Record<string, unknown>;
  };
  const node = s as unknown as WithDesc;

  if (typeof node.description === "string") return node.description;

  const def = (node._def ?? node.def ?? {}) as Record<string, unknown>;
  const d = def.description;
  if (typeof d === "string") return d;

  const m = metaOf(s);
  return typeof m?.description === "string" ? m.description : undefined;
};

/* ────────────────────────────────────────────────────────────────────────── */
/* Internal type helpers                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

type KeyOf<S extends z.ZodRawShape> = keyof S & string;
type ValOf<S extends z.ZodRawShape, K extends keyof S> = z.infer<S[K]>;

/* ────────────────────────────────────────────────────────────────────────── */
/* Naming strategies                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * A function that computes an external/presented **name** for a property key.
 * Internals always use **camelCase** keys; strategies affect presentation
 * (e.g., UI columns) and loader mapping (when `meta.externalName` is absent).
 *
 * @example
 * ```ts
 * const Upper = (key) => key.toUpperCase();
 * q.list({ nameAs: Upper });
 * ```
 */
export type PropertyNamingStrategy = (
  key: string,
  zsub: z.ZodTypeAny,
  meta: Meta | undefined,
) => string;

const splitWords = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-\.\s]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

const toCamel = (s: string) => {
  const p = splitWords(s.toLowerCase());
  return p.map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1))).join(
    "",
  );
};
const toSnake = (s: string) =>
  splitWords(s).map((w) => w.toLowerCase()).join("_");
const toScreamingSnake = (s: string) => toSnake(s).toUpperCase();
const toKebab = (s: string) =>
  splitWords(s).map((w) => w.toLowerCase()).join("-");
const toPascal = (s: string) =>
  splitWords(s).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(
    "",
  );

/**
 * Built-in naming strategies (plug into `list({nameAs})` and loader options).
 */
export const Naming = {
  /** `databaseUrl` → `databaseUrl` */
  camel: ((key: string) => toCamel(key)) as PropertyNamingStrategy,
  /** `databaseUrl` → `database_url` */
  snake: ((key: string) => toSnake(key)) as PropertyNamingStrategy,
  /** `databaseUrl` → `DATABASE_URL` */
  screamingSnake:
    ((key: string) => toScreamingSnake(key)) as PropertyNamingStrategy,
  /** `databaseUrl` → `database-url` */
  kebab: ((key: string) => toKebab(key)) as PropertyNamingStrategy,
  /** `databaseUrl` → `DatabaseUrl` */
  pascal: ((key: string) => toPascal(key)) as PropertyNamingStrategy,
} as const;

/* ────────────────────────────────────────────────────────────────────────── */
/* Loader & event contracts                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Pluggable loader: try to provide a raw value for a key. Return `undefined` to skip.
 *
 * @typeParam S - Raw shape of the owning Zod object
 */
export type Loader<S extends z.ZodRawShape> = {
  /** Loader name (used in provenance and events). */
  name: string;
  /**
   * Attempt to supply a value for the given key.
   * @param key  - Property key (canonical camelCase)
   * @param zsub - Zod node for this key (inspect `.meta()` / `.describe()` if needed)
   * @param meta - Convenience: parsed metadata for the node, if any
   * @returns The raw value (sync/async) or `undefined` to indicate "not provided"
   */
  load<K extends KeyOf<S>>(
    key: K,
    zsub: z.ZodTypeAny,
    meta: Meta | undefined,
  ): unknown | Promise<unknown> | undefined;
};

/**
 * Typed event map emitted by the property bag.
 * @typeParam S - Raw shape of the owning Zod object
 */
export type PropEvents<S extends z.ZodRawShape> = {
  /** Emitted for every successful set, manual or via loader. */
  "prop:set": { key: KeyOf<S>; value: unknown; source: string; raw?: unknown };
  /** Emitted when a loader wins for a key. */
  "prop:loaded": {
    key: KeyOf<S>;
    loader: string;
    value: unknown;
    raw?: unknown;
  };
  /** Emitted when a loader did not supply a value for a key. */
  "prop:skipped": { key: KeyOf<S>; loader: string };
  /** Emitted when a required property is missing after load attempts. */
  "prop:missing": { key: KeyOf<S> };
  /** Emitted when validation/loading throws. */
  "prop:error": { key: KeyOf<S>; error: unknown; during: "set" | "load" };
  /** Emitted after `loadAll()` succeeds and `toObject()` parses. */
  "props:ready": { object: z.infer<z.ZodObject<S>> };
};

/* ────────────────────────────────────────────────────────────────────────── */
/* assemblerProperties(): mutation + events                                   */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Create an **event-driven property bag** bound to a Zod object schema.
 *
 * @remarks
 * - Zod is the single source of truth for types, defaults, and transforms.
 * - `set()` validates through Zod; `get()` realizes defaults on demand.
 * - `loadAll()` tries loaders in order per key; first non-`undefined` wins.
 * - Emits typed events for observability and UI hooks.
 *
 * @typeParam S - Raw shape of the provided Zod object
 * @param schema - Zod object schema that defines all properties
 * @returns API with `set/get/require/loadAll/toObject/extend` and a typed `bus`
 */
export function assemblerProperties<S extends z.ZodRawShape>(
  schema: z.ZodObject<S>,
) {
  type K = KeyOf<S>;
  const values = new Map<K, unknown>();
  const bus = eventBus<PropEvents<S>>();

  type ShapeAsAny = { [P in keyof S]: z.ZodTypeAny };
  const shape = schema.shape as unknown as ShapeAsAny;

  const keys = () => Object.keys(schema.shape) as K[];
  const sub = <T extends K>(k: T) => shape[k] as z.ZodTypeAny;

  /**
   * Set a value after validating/coercing through its Zod schema.
   * @throws ZodError if validation fails
   */
  function set<T extends K>(key: T, value: unknown, source = "manual") {
    try {
      const s = sub(key);
      const parsed = s.parse(value);
      values.set(key, parsed);
      bus.emit("prop:set", { key, value: parsed, source, raw: value });
      return parsed as ValOf<S, T>;
    } catch (e) {
      bus.emit("prop:error", { key, error: e, during: "set" });
      throw e;
    }
  }

  /**
   * Get a typed value, realizing Zod defaults/transforms if present.
   * @returns The typed value, or `undefined` if unset and no default exists
   */
  function get<T extends K>(key: T): ValOf<S, T> | undefined {
    if (values.has(key)) return values.get(key) as ValOf<S, T>;
    const s = sub(key);
    const out = s.safeParse(undefined); // realize defaults/transforms if any
    if (out.success && out.data !== undefined) {
      values.set(key, out.data as unknown);
      return out.data as ValOf<S, T>;
    }
    return undefined;
  }

  /**
   * Require a property value; throws if missing. Emits `prop:missing` on failure.
   * Uses `meta.required === true` to decide the error message wording.
   */
  function require<T extends K>(key: T): ValOf<S, T> {
    const s = sub(key);
    const v = get(key);
    const hardReq = metaOf(s)?.required === true;
    if (v === undefined) {
      bus.emit("prop:missing", { key });
      throw new Error(
        hardReq
          ? `Missing required property '${key}'`
          : `Required property '${key}' not found`,
      );
    }
    return v;
  }

  /**
   * Load all keys by attempting each loader in order per key.
   * First non-`undefined` raw value wins for that key.
   *
   * @emits prop:loaded | prop:skipped | prop:error | prop:missing | props:ready
   * @returns The bag itself (for chaining)
   */
  async function loadAll(loaders: Loader<S>[]) {
    for (const k of keys()) {
      if (values.has(k)) continue;
      const s = sub(k), m = metaOf(s);
      let hit = false;

      for (const L of loaders) {
        try {
          const raw = await L.load(k, s, m);
          if (raw !== undefined) {
            const parsed = set(k, raw, L.name);
            bus.emit("prop:loaded", {
              key: k,
              loader: L.name,
              value: parsed,
              raw,
            });
            hit = true;
            break;
          } else {
            bus.emit("prop:skipped", { key: k, loader: L.name });
          }
        } catch (e) {
          bus.emit("prop:error", { key: k, error: e, during: "load" });
          throw e;
        }
      }

      // Enforce meta.required if nothing supplied and no default realized
      if (!hit && m?.required) {
        const out = s.safeParse(undefined);
        if (!(out.success && out.data !== undefined)) {
          bus.emit("prop:missing", { key: k });
          throw new Error(`Required property '${k}' not provided`);
        }
        values.set(k, out.data as unknown);
      }
    }

    const obj = toObject();
    bus.emit("props:ready", { object: obj });
    return api;
  }

  /**
   * Build a fully parsed/defaulted object `{ key: value }` validated by the top-level schema.
   * @throws ZodError if aggregate validation fails
   */
  function toObject(): z.infer<typeof schema> {
    const obj: Partial<Record<K, unknown>> = {};
    for (const k of keys()) obj[k] = get(k as K);
    return schema.parse(obj as unknown);
  }

  /**
   * Create a **new bag** bound to `schema.merge(extra)` and carry forward compatible values.
   */
  function extend<E extends z.ZodRawShape>(extra: z.ZodObject<E>) {
    const merged = schema.merge(extra);
    const next = assemblerProperties(merged);
    const mergedKeys = new Set(Object.keys(merged.shape));

    // Compute the merged key type to avoid `any`
    type MShape = typeof merged extends z.ZodObject<infer MS> ? MS : never;
    type MK = keyof MShape & string;

    for (const [k, v] of values.entries()) {
      if (mergedKeys.has(k)) {
        // Type-safe invocation of next.set for merged schema
        (next.set as (key: MK, value: unknown, source?: string) => unknown)(
          k as unknown as MK,
          v,
          "extend-copy",
        );
      }
    }
    return next;
  }

  /** Full bag API. */
  const api = {
    schema,
    bus,
    set,
    get,
    require,
    loadAll,
    toObject,
    extend,
  } as const;
  return api;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* propertiesQuery(): read-only query facade                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Compose a **read-only** view of a property bag for listing/filtering/picking.
 * Keeps mutation and querying separate for clean composition (e.g., CLI/GUI).
 */
export function propertiesQuery<S extends z.ZodRawShape>(
  bag: ReturnType<typeof assemblerProperties<S>>,
) {
  type K = KeyOf<S>;
  type ShapeAsAny = { [P in keyof S]: z.ZodTypeAny };
  const shape = bag.schema.shape as unknown as ShapeAsAny;

  const keys = () => Object.keys(bag.schema.shape) as K[];
  const sub = <T extends K>(k: T) => shape[k] as z.ZodTypeAny;

  /**
   * List properties with optional tag filter, redaction, and **name transformation**.
   *
   * @param opts.nameAs        Naming strategy for the presented `name` (default: `Naming.camel`)
   * @param opts.tag           Only include entries whose `.meta().tags` contains this tag
   * @param opts.redactSecrets If true, masks string values when `.meta().redact` is true
   */
  function list(opts?: {
    nameAs?: PropertyNamingStrategy;
    tag?: string;
    redactSecrets?: boolean;
  }) {
    const strategy = opts?.nameAs ?? Naming.camel;
    return keys()
      .filter((k) => {
        if (!opts?.tag) return true;
        const t = metaOf(sub(k))?.tags;
        return Array.isArray(t) ? t.includes(opts.tag) : false;
      })
      .map((k) => {
        const s = sub(k), m = metaOf(s), v = bag.get(k);
        const redacted =
          m?.redact && typeof v === "string" && opts?.redactSecrets
            ? (v.length <= 6 ? "***" : `${v.slice(0, 2)}***${v.slice(-2)}`)
            : v;
        return {
          key: k, // canonical (camelCase) key
          name: strategy(k, s, m), // presented name (strategy-applied)
          description: descOf(s),
          tags: m?.tags,
          sourceHint: m?.sourceHint,
          required: !!m?.required,
          set: v !== undefined,
          value: redacted,
        };
      });
  }

  /**
   * Pick a small, typed subset of required properties.
   * @throws Error if any requested key is missing
   */
  function pick<T extends readonly K[]>(
    ...ks: T
  ): { [P in T[number]]: ValOf<S, P> } {
    const out = {} as { [P in T[number]]: ValOf<S, P> };
    for (const k of ks) {
      (out as Record<string, unknown>)[k] = bag.require(k) as unknown as ValOf<
        S,
        typeof k
      >;
    }
    return out;
  }

  /**
   * Convenience: list only entries that contain the specified tag (with optional naming).
   */
  function byTag(tag: string, nameAs?: PropertyNamingStrategy) {
    return list({ tag, nameAs });
  }

  /**
   * Resolve a presented name (with a given strategy) back to the canonical key.
   * Useful for CLIs that accept non-camel names.
   */
  function resolveName(name: string, strategy: PropertyNamingStrategy) {
    for (const k of keys()) {
      const s = sub(k);
      const m = metaOf(s);
      if (strategy(k, s, m) === name) return k;
    }
    return undefined;
  }

  return { list, pick, byTag, resolveName } as const;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Built-in loaders (strategy-aware, respect meta.externalName)               */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Loader: read values from environment variables.
 *
 * - Default naming for basename: `SCREAMING_SNAKE` (e.g., `DATABASE_URL`)
 * - Optional `prefix` will be prepended as `PREFIX_BASENAME`
 *
 * @example
 * ```ts
 * await bag.loadAll([envLoader({ prefix: "SPRY" })]);
 * // databaseUrl → SPRY_DATABASE_URL (unless meta.externalName provided)
 * ```
 */
export function envLoader<S extends z.ZodRawShape>(opts?: {
  /** Optional prefix (`PREFIX_BASENAME`). */
  prefix?: string;
  /** Strategy for basename when `meta.externalName` is absent (default: `Naming.screamingSnake`). */
  strategy?: PropertyNamingStrategy;
}): Loader<S> {
  return {
    name: "env",
    load(key, zsub) {
      const m = metaOf(zsub);
      const base = m?.externalName ??
        (opts?.strategy ?? Naming.screamingSnake)(key, zsub, m);
      const envName = [opts?.prefix, base].filter(Boolean).join("_")
        .toUpperCase();

      const raw =
        (typeof Deno !== "undefined" ? Deno.env.get(envName) : undefined) ??
          (process?.env ? process.env[envName] : undefined);

      return raw ?? undefined;
    },
  };
}

/**
 * Loader: read values from a plain JSON object.
 *
 * - Default naming: `snake_case` (e.g., `page_limit`)
 * - Uses `meta.externalName` if present
 */
export const jsonLoader = <S extends z.ZodRawShape>(
  obj: Record<string, unknown>,
  opts?: {
    /** Strategy for object key when `meta.externalName` is absent (default: `Naming.snake`). */
    strategy?: PropertyNamingStrategy;
  },
): Loader<S> => ({
  name: "json",
  load(key, zsub) {
    const m = metaOf(zsub);
    const name = m?.externalName ??
      (opts?.strategy ?? Naming.snake)(key, zsub, m);
    return Object.prototype.hasOwnProperty.call(obj, name)
      ? obj[name]
      : undefined;
  },
});

/**
 * Loader: read values from a SQL row map (column → value).
 *
 * - Default naming: `snake_case`
 * - Uses `meta.externalName` if present
 */
export const sqlRowLoader = <S extends z.ZodRawShape>(
  row: Record<string, unknown>,
  opts?: {
    /** Strategy for column name when `meta.externalName` is absent (default: `Naming.snake`). */
    strategy?: PropertyNamingStrategy;
  },
): Loader<S> => ({
  name: "sql",
  load(key, zsub) {
    const m = metaOf(zsub);
    const col = m?.externalName ??
      (opts?.strategy ?? Naming.snake)(key, zsub, m);
    return Object.prototype.hasOwnProperty.call(row, col)
      ? row[col]
      : undefined;
  },
});
