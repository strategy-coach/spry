/**
 * Fast path-aware `JSON.stringify` replacer factory for Deno/TypeScript with
 * support for (1) segment-aware function rules and (2) simple jq-like string queries.
 *
 * USAGE
 *   const replacer = jsonStringifyReplacers(
 *     [
 *       // Function rules (boolean / structured):
 *       (s) => s.at(-1) !== "password",
 *       (s) => (s.join(".") === "user.ssn" ? { omit: true } : undefined),
 *       (s) => (s.at(-1) === "token" ? { replaceWith: "****" } : undefined),
 *
 *       // jq-like query rules:
 *       //   - Dot-separated path: ".user.profile.email"
 *       //   - "*" matches a single segment
 *       //   - "**" matches zero or more segments (any depth)
 *       //   - "[]" is treated as "*" (any array index)
 *       //   - Leading "." is optional; "user.*.id" is valid
 *       //   - A single token with no dots (e.g. "token") means "**.token" (match at any depth)
 *       //   - Examples: ".user.password", "items[].secret", "user.**.ssn", "token"
 *       { query: ".user.password", action: "omit" },
 *       { query: "items.[].secret", action: "replace", with: "<redacted>" },
 *       { query: "user.**.public", action: "keep" },
 *     ],
 *     { mode: "all" }, // "all" (AND, default) or "any" (OR)
 *   );
 *
 *   JSON.stringify(value, replacer, 2);
 *
 * RULE SEMANTICS
 *   Function rule result:
 *     - true or undefined  → keep value
 *     - false or { omit: true } → omit value
 *     - { replaceWith: <value> } → substitute <value> (takes precedence)
 *
 *   Query rule object: { query: string, action: "omit" | "keep" | "replace", with?: unknown }
 *     - "omit"    → behaves like false when matched
 *     - "keep"    → behaves like true when matched
 *     - "replace" → behaves like { replaceWith: with } when matched
 *
 * PERFORMANCE NOTES
 *   - Rules are compiled once up-front. Query strings are compiled into fast matchers.
 *   - WeakMap<object,string[]> tracks absolute paths (segments) for children; one array per object node.
 *   - No spreads/slices/joins on the hot path; tiny fixed loops & early exits:
 *       • First replacement wins immediately.
 *       • AND mode: first omit returns undefined.
 *       • OR mode: default is keep; explicit omit drops a value; replacement still overrides.
 *   - Zero rules short-circuits to a no-op replacer.
 */
export function jsonStringifyReplacers(
  rules:
    | readonly ((
      segments: readonly string[],
      node: unknown,
    ) =>
      | boolean
      | { omit: true }
      | { replaceWith: unknown }
      | undefined
      | null)[]
    | readonly {
      query: string;
      action: "omit" | "keep" | "replace";
      with?: unknown;
    }[],
  opts: { mode?: "all" | "any" } = {},
): (this: unknown, key: string, value: unknown) => unknown {
  type Decision =
    | boolean
    | { omit: true }
    | { replaceWith: unknown }
    | undefined
    | null;
  type Predicate = (segments: readonly string[], node: unknown) => Decision;

  const compiledPredicates: Predicate[] = [];
  compiledPredicates.length = rules.length;

  for (let i = 0; i < rules.length; i++) {
    const r = rules[i] as unknown;

    if (typeof r === "function") {
      compiledPredicates[i] = r as Predicate;
      continue;
    }

    const { query, action } = r as {
      query: string;
      action: "omit" | "keep" | "replace";
      with?: unknown;
    };
    const replacement = (r as { with?: unknown }).with;

    const matcher = compileSimpleJqQuery(query);
    if (action === "omit") {
      compiledPredicates[i] = (s) => (matcher(s) ? false : undefined);
    } else if (action === "keep") {
      compiledPredicates[i] = (s) => (matcher(s) ? true : undefined);
    } else {
      compiledPredicates[i] = (
        s,
      ) => (matcher(s) ? { replaceWith: replacement } : undefined);
    }
  }

  const modeAll = (opts.mode ?? "all") === "all";
  const paths = new WeakMap<object, string[]>();

  return function replacer(this: unknown, key: string, value: unknown) {
    if (key === "" && value !== null && typeof value === "object") {
      paths.set(value as object, []);
      return value;
    }

    const holder = this as Record<string, unknown> | unknown[];
    const parentPath = (holder && typeof holder === "object")
      ? (paths.get(holder as object) ?? [])
      : [];

    let path: string[];
    if (key) {
      path = new Array(parentPath.length + 1);
      for (let i = 0; i < parentPath.length; i++) path[i] = parentPath[i];
      path[parentPath.length] = key;
    } else {
      path = parentPath;
    }

    if (value !== null && typeof value === "object") {
      paths.set(value as object, path);
    }

    if (compiledPredicates.length === 0) return value;

    let replace: unknown | undefined = undefined;
    // Default KEEP in both modes; explicit omits will drop the value.
    let keepFlag = true;

    for (let i = 0; i < compiledPredicates.length; i++) {
      const r = compiledPredicates[i](path, value);

      if (r && typeof r === "object") {
        if ("replaceWith" in r) {
          replace = r.replaceWith;
          break; // replacement wins
        }
        if ("omit" in r && r.omit) {
          if (modeAll) return undefined; // AND: any omit => omit
          // OR: explicit omit overrides default keep
          keepFlag = false;
        } // else treat as keep (no change needed; keepFlag already true)
      } else if (r === false) {
        if (modeAll) return undefined;
        keepFlag = false; // OR: explicit false -> omit
      } else {
        // true or undefined/null => keep/no-op; keepFlag remains true
      }
    }

    if (replace !== undefined) return replace;
    return keepFlag ? value : undefined;
  };

  // --------- Simple jq-like compiler (., *, **, [] as *, and single-token => **.token) ----------
  function compileSimpleJqQuery(
    q: string,
  ): (segments: readonly string[]) => boolean {
    const normalized = q.startsWith(".") ? q.slice(1) : q;

    // Empty after trimming dot → root
    if (normalized.length === 0) {
      return (segments) => segments.length === 0;
    }

    // Treat a single token (no dots) as "**.<token>" (match that key at any depth)
    if (!normalized.includes(".")) {
      const token = normalized === "[]" ? "*" : normalized;
      const pattern = ["**", token] as const;
      return (segments) => matchWithGlob(pattern, segments);
    }

    const rawParts = normalized.split(".").filter((p) => p.length > 0);
    const tokens = rawParts.map((p) => (p === "[]" ? "*" : p));

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

    return (segments) => matchWithGlob(tokens, segments);
  }

  function matchWithGlob(
    pattern: readonly string[],
    segments: readonly string[],
  ): boolean {
    let p = 0;
    let s = 0;
    let starStarIdx = -1;
    let starStarMatchIdx = -1;

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
        p++;
        continue;
      }
      if (starStarIdx !== -1) {
        p = starStarIdx + 1;
        starStarMatchIdx++;
        s = starStarMatchIdx;
        continue;
      }
      return false;
    }

    while (p < pattern.length && pattern[p] === "**") p++;
    return p === pattern.length;
  }
}
