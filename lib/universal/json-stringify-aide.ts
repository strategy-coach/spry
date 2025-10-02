/**
 * Fast path-aware `JSON.stringify` replacer factory for Deno/TypeScript with
 * support for (1) ultra-fast segment-aware function rules and (2) simple jq-like
 * string query rules compiled to matchers. Designed for tight loops.
 *
 * USAGE
 *   const replacer = jsonStringifyReplacers(
 *     [
 *       // 1) Function rules (boolean / structured):
 *       //    - true or undefined  → keep value
 *       //    - false or { omit: true } → omit value
 *       //    - { replaceWith: <value> } → substitute <value> (wins over keep/omit)
 *       (segments, node) => segments.at(-1) !== "password",
 *       (segments) => (segments.join(".") === "user.ssn" ? { omit: true } : undefined),
 *       (segments) => (segments.at(-1) === "token" ? { replaceWith: "****" } : undefined),
 *
 *       // 2) jq-like query rules (discriminated union):
 *       //    - Dot-separated path: ".user.profile.email"
 *       //    - "*" matches a single segment
 *       //    - "**" matches zero or more segments (any depth)
 *       //    - "[]" is treated as "*" (any array index)
 *       //    - Leading "." is optional; "user.*.id" is valid
 *       //    - A single token with no dots (e.g. "token") means "**.token" (match at any depth)
 *       //    - Examples: ".user.password", "items[].secret", "user.**.ssn", "token"
 *       { action: "omit",    query: ".user.password" },
 *       { action: "replace", query: "items.[].secret", with: "<redacted>" },
 *       { action: "keep",    query: "user.**.public" },
 *       // Dynamic replacement example:
 *       // { action: "replace", query: "walkEntry.path", with: (s, n) => relative(Deno.cwd(), String(n)) },
 *     ],
 *     { mode: "all" }, // "all" (AND, default) or "any" (OR)
 *   );
 *
 *   JSON.stringify(value, replacer, 2);
 *
 * PERFORMANCE NOTES
 *   - Rules compile once. Query strings become efficient matchers.
 *   - WeakMap<object,string[]> tracks absolute paths for children; one array per object node.
 *   - No spreads/slices/joins on the hot path; small loops + early exits:
 *       • First replacement wins immediately.
 *       • AND mode: any explicit omit returns undefined.
 *       • OR  mode: default is keep; explicit omit drops a value; replacement still overrides.
 *   - Zero rules short-circuits to a no-op replacer.
 */

// ---------- Exported types (for external type-safety & tests) ----------
export type JsonStringifyPredicate = (
  segments: readonly string[],
  node: unknown,
) =>
  | boolean
  | { omit: true }
  | { replaceWith: unknown }
  | undefined
  | null;

export type JsonStringifyQueryKeep = { action: "keep"; query: string };
export type JsonStringifyQueryOmit = { action: "omit"; query: string };
export type JsonStringifyQueryReplace = {
  action: "replace";
  query: string;
  with: (segments: readonly string[], node: unknown) => unknown;
};

export type JsonStringifyQueryRule =
  | JsonStringifyQueryKeep
  | JsonStringifyQueryOmit
  | JsonStringifyQueryReplace;

export type JsonStringifyRule =
  | JsonStringifyPredicate
  | JsonStringifyQueryRule;

// ------------------------------ Implementation ------------------------------
export function jsonStringifyReplacers(
  rules: readonly JsonStringifyRule[],
  opts: { mode?: "all" | "any" } = {},
): (this: unknown, key: string, value: unknown) => unknown {
  type Decision =
    | boolean
    | { omit: true }
    | { replaceWith: unknown }
    | undefined
    | null;

  type Predicate = (segments: readonly string[], node: unknown) => Decision;

  // Compile rules → predicates
  const compiled: Predicate[] = new Array(rules.length);

  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];

    if (typeof r === "function") {
      compiled[i] = r as Predicate;
      continue;
    }

    // r is a query rule (discriminated by r.action)
    const matcher = compileSimpleJqQuery(r.query);

    switch (r.action) {
      case "omit": {
        compiled[i] = (s) => (matcher(s) ? false : undefined);
        break;
      }
      case "keep": {
        compiled[i] = (s) => (matcher(s) ? true : undefined);
        break;
      }
      case "replace": {
        const w = r.with;
        compiled[i] = (s, n) =>
          matcher(s)
            ? {
              replaceWith: typeof w === "function"
                ? (w as (s: readonly string[], n: unknown) => unknown)(s, n)
                : w,
            }
            : undefined;
        break;
      }
      default: {
        const _exhaustive: never = r;
        throw new Error(`Unhandled rule action: ${_exhaustive}`);
      }
    }
  }

  const modeAll = (opts.mode ?? "all") === "all";
  const paths = new WeakMap<object, string[]>();

  return function replacer(this: unknown, key: string, value: unknown) {
    // Seed root path
    if (key === "" && value !== null && typeof value === "object") {
      paths.set(value as object, []);
      return value;
    }

    // holder is the parent container for (key, value)
    const holder = this as Record<string, unknown> | unknown[];
    const parentPath = (holder && typeof holder === "object")
      ? (paths.get(holder as object) ?? [])
      : [];

    // Build current path (avoid spreads/slices)
    let path: string[];
    if (key) {
      path = new Array(parentPath.length + 1);
      for (let i = 0; i < parentPath.length; i++) path[i] = parentPath[i];
      path[parentPath.length] = key;
    } else {
      path = parentPath;
    }

    // Record path for children (objects/arrays only)
    if (value !== null && typeof value === "object") {
      paths.set(value as object, path);
    }

    // Zero rules → keep
    if (compiled.length === 0) return value;

    // Tight loop with early exits
    let replace: unknown | undefined = undefined;
    // Default KEEP in both modes; explicit omits will drop unless replaced.
    let keepFlag = true;

    for (let i = 0; i < compiled.length; i++) {
      const res = compiled[i](path, value);

      if (res && typeof res === "object") {
        if ("replaceWith" in res) {
          replace = res.replaceWith;
          break; // replacement wins immediately
        }
        if ("omit" in res && res.omit) {
          if (modeAll) return undefined; // AND: any omit → omit now
          keepFlag = false; // OR: mark omit unless replacement overrides
        }
        // else structured keep → no-op (keepFlag already true)
      } else if (res === false) {
        if (modeAll) return undefined; // AND: explicit false → omit
        keepFlag = false; // OR: mark omit (may still be overridden)
      } else {
        // true / undefined / null → keep/no-op
      }
    }

    if (replace !== undefined) return replace;
    return keepFlag ? value : undefined;
  };

  // ----------------------- Query compiler & matcher ------------------------
  // Supports ".", "*", "**", "[]", and single-token shorthand => "**.<token>"
  function compileSimpleJqQuery(
    q: string,
  ): (segments: readonly string[]) => boolean {
    const normalized = q.startsWith(".") ? q.slice(1) : q;

    // Empty → root
    if (normalized.length === 0) {
      return (segments) => segments.length === 0;
    }

    // Single token → "**.token" (match at any depth)
    if (!normalized.includes(".")) {
      const token = normalized === "[]" ? "*" : normalized;
      const pattern = ["**", token] as const;
      return (segments) => matchWithGlob(pattern, segments);
    }

    const rawParts = normalized.split(".").filter((p) => p.length > 0);
    const tokens = rawParts.map((p) => (p === "[]" ? "*" : p));

    // Fast path: no "**"
    if (!tokens.includes("**")) {
      return (segments) => {
        if (segments.length !== tokens.length) return false;
        for (let i = 0; i < tokens.length; i++) {
          const t = tokens[i];
          if (t === "*") continue;
          if (segments[i] !== t) return false;
        }
        return true;
      };
    }

    // General matcher with "**"
    return (segments) => matchWithGlob(tokens, segments);
  }

  function matchWithGlob(
    pattern: readonly string[],
    segments: readonly string[],
  ): boolean {
    let p = 0; // pattern index
    let s = 0; // segments index
    let starStarIdx = -1; // last '**' index in pattern
    let starStarMatchIdx = -1; // segments index where '**' started consuming

    while (s < segments.length) {
      if (
        p < pattern.length && (pattern[p] === segments[s] || pattern[p] === "*")
      ) {
        p++;
        s++;
        continue;
      }
      if (p < pattern.length && pattern[p] === "**") {
        starStarIdx = p;
        starStarMatchIdx = s;
        p++; // try zero-length match first
        continue;
      }
      if (starStarIdx !== -1) {
        // backtrack: let '**' consume one more segment
        p = starStarIdx + 1;
        starStarMatchIdx++;
        s = starStarMatchIdx;
        continue;
      }
      return false;
    }

    // Consume trailing '**'
    while (p < pattern.length && pattern[p] === "**") p++;
    return p === pattern.length;
  }
}
