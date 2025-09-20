// env.ts
// EnvAide: convenient wrapper around ALL env vars
// CapExecEnvAide: composition wrapper around EnvAide for CAPEXEC_ vars

export class EnvAide {
  private readonly all: Record<string, string>;
  private readonly convenienceMap: Map<string, string>;

  constructor() {
    // Requires --allow-env
    this.all = Deno.env.toObject();
    this.convenienceMap = new Map(Object.entries(this.all));

    return new Proxy(this, {
      get: (target, prop, receiver) => {
        if (
          typeof prop === "string" &&
          !(prop in target) &&
          /^[A-Za-z]\w*$/.test(prop)
        ) {
          return () => target.get(EnvAide.camelToSnake(prop));
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  static camelToSnake(name: string): string {
    // Handles consecutive capitals well: dbURL → DB_URL, HTTPServer → HTTP_SERVER
    return name
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/([A-Z]+)([A-Z][a-z0-9]+)/g, "$1_$2")
      .toUpperCase();
  }

  /** Exact-name lookup (case-sensitive, e.g., "PATH") */
  get(name: string): string | undefined {
    return this.convenienceMap.get(name);
  }

  require(name: string): string {
    const v = this.get(name);
    if (v === undefined) throw new Error(`Missing ${name}`);
    return v;
  }

  has(name: string): boolean {
    return this.convenienceMap.has(name);
  }

  /** Exact env keys as present in the environment */
  keys(): string[] {
    return Object.keys(this.all);
  }

  /**
   * toObject(filter?)
   * - Default: return *all* envs.
   * - With filter: include only entries where filter(key, value) is true.
   */
  toObject(
    filter?: (key: string, value: string) => boolean,
  ): Record<string, string> {
    if (!filter) return { ...this.all };
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.all)) {
      if (filter(k, v)) out[k] = v;
    }
    return out;
  }
}

/**
 * CapExecEnvAide (composition)
 * - Wraps an EnvAide instance; focuses on CAPEXEC_* variables.
 * - Dynamic lookup: `cap.targetSqliteDb()` → CAPEXEC_TARGET_SQLITE_DB
 * - get/require/has accept de-prefixed names (e.g., "DB_URL") or fully prefixed names.
 * - keys() returns de-prefixed keys.
 * - toObject(filter?) returns CAPEXEC_* by default (prefixed); filter may include other envs.
 * - context<T>() parses or CAPEXEC_CONTEXT_JSON or CAPEXEC_CONTEXT JSON with optional schema validation (e.g., zod).
 */
export class CapExecEnvAide {
  readonly prefix = "CAPEXEC_";
  private readonly env: EnvAide;
  private readonly all: Record<string, string>;
  private readonly capexecMap: Map<string, string>;

  constructor(env = new EnvAide()) {
    this.env = env;
    this.all = env.toObject();
    this.capexecMap = new Map(
      Object.entries(this.all)
        .filter(([k]) => k.startsWith(this.prefix))
        .map(([k, v]) => [k.slice(this.prefix.length), v]),
    );

    return new Proxy(this, {
      get: (target, prop, receiver) => {
        if (
          typeof prop === "string" &&
          !(prop in target) &&
          /^[A-Za-z]\w*$/.test(prop)
        ) {
          const key = target.prefix + EnvAide.camelToSnake(prop);
          return () => target.env.get(key);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  /** De-prefixed or prefixed get */
  get(name: string): string | undefined {
    if (this.capexecMap.has(name)) return this.capexecMap.get(name);
    if (name.startsWith(this.prefix)) return this.env.get(name);
    return undefined;
  }

  require(name: string): string {
    const v = this.get(name);
    if (v === undefined) {
      const hint = name.startsWith(this.prefix) ? name : this.prefix + name;
      throw new Error(`Missing ${hint}`);
    }
    return v;
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  /** De-prefixed CAPEXEC keys, e.g., ["TARGET_SQLITE_DB", "DB_URL", ...] */
  keys(): string[] {
    return [...this.capexecMap.keys()];
  }

  /** Prefixed CAPEXEC keys, e.g., ["CAPEXEC_TARGET_SQLITE_DB", "CAPEXEC_DB_URL", ...] */
  prefixedKeys(): string[] {
    return [...this.capexecMap.keys()].map((k) => this.prefix + k);
  }

  /**
   * toObject(filter?)
   * - Default: only CAPEXEC_* variables with their original (prefixed) names.
   * - With filter: include any other envs for which filter(key, value) is true.
   */
  toObject(
    filter?: (key: string, value: string) => boolean,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.all)) {
      if (k.startsWith(this.prefix) || (filter?.(k, v) ?? false)) {
        out[k] = v;
      }
    }
    return out;
  }

  /**
   * Parse CAPEXEC_CONTEXT or CAPEXEC_CONTEXT_JSON as JSON with optional schema validation.
   * Returns T | undefined.
   */
  context<T = unknown>(schema?: {
    parse?: (value: unknown) => T;
    safeParse?: (
      value: unknown,
    ) => { success: boolean; data: T; error: unknown };
  }): T | undefined {
    const raw = this.env.get(`${this.prefix}CONTEXT`) ??
      this.env.get(`${this.prefix}CONTEXT_JSON`) ?? "";
    if (!raw) return undefined;

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Invalid JSON in ${this.prefix}CONTEXT: ${(err as Error).message}`,
      );
    }

    if (schema?.safeParse) {
      const res = schema.safeParse(json);
      if (!res.success) {
        throw new Error(
          `Schema validation failed for ${this.prefix}CONTEXT: ${
            String(
              // deno-lint-ignore no-explicit-any
              (res as any).error,
            )
          }`,
        );
      }
      return res.data;
    }
    if (schema?.parse) return schema.parse(json);
    return json as T;
  }
}
