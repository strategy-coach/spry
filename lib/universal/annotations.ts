/**
 * @module annotations
 *
 * Utilities for parsing and discovering SQL or any other text file comment
 * annotations such as:
 *
 *   -- @<identity>.<arg> <value> [@<identity>.<arg> <value> ...]
 *
 * This module exposes a factory, {@link annotationsParser}, that builds
 * parsers scoped to a specific `identity` (e.g., "sql" → @sql.arg value).
 *
 * It provides two complementary capabilities:
 *
 * 1. Parsing + Validation — `parse(text, [predicate])`
 *    Aggregates matched annotations into a plain object and validates it
 *    against a user-supplied Zod schema. Returns Zod’s `safeParse` result,
 *    or `undefined` if the optional `predicate` returns `false`.
 *
 * 2. Discovery (no validation) — `discover(text)`
 *    Returns a rich summary of all matched annotations, including counts,
 *    unique values, first/last values, and precise source positions.
 *
 * Typical use cases include:
 * - Embedding structured metadata in SQL files or migrations.
 * - Enforcing annotation schemas via Zod.
 * - Tooling, linting, and editor integration via `discover`.
 */
import { z } from "jsr:@zod/zod@^4.1.5";

/**
 * Build a parser/discovery utility for structured SQL or any other text file
 * comment annotations of the form:
 *
 *   -- @<identity>.<arg> <value> [@<identity>.<arg> <value> ...]
 *
 * The factory returns an object with:
 *
 * - `parse(text, [predicate])`: Scans comment lines for annotations, aggregates
 *   them into an object, and validates against the given Zod schema. Returns a
 *   `SafeParseReturnType` or `undefined` if the optional predicate returns false.
 *
 * - `discover(text)`: Scans the text and returns a summary of all matches,
 *   without validation, including value counts, unique values, first/last values,
 *   and occurrence positions (line, column, start, end).
 *
 * - `ensure(obj, key, defaultValue)`: Helper that assigns a default value to a
 *   missing key and narrows the type accordingly.
 *
 * @template S - Zod schema type for the validated object.
 *
 * @param identity - The annotation identity, e.g. "sql" for @sql.arg value.
 * @param schema - A Zod schema used by `parse` to validate the aggregated object.
 * @param init - Optional configuration:
 *   @param init.esc - Escape helper for regex generation (default escapes meta-chars).
 *   @param init.commentMarkers - Comment markers to scan (default ["--"]).
 *   @param init.blockComments - Whether to scan /* ... *\/ block comments (default false).
 *   @param init.prefix - Annotation prefix (default "@").
 *   @param init.coalesce - Handling of duplicate args: "array" (default), "first", "last".
 *   @param init.argName - Regex for argument names (default /[A-Za-z_][\\w-]*\/).
 *   @param init.normalizeArg - Normalize argument names (default: identity function).
 *   @param init.findValueEnd - Custom logic to find value end position.
 *   @param init.trim - Trim extracted values (default true).
 *   @param init.normalizeValue - Transform extracted values (default strips quotes).
 *
 * @returns An object containing:
 *   - `schema`: The provided Zod schema.
 *   - `parse(text, [predicate])`: Parse + validate annotations.
 *   - `discover(text)`: Inspect annotations without validation.
 *   - `ensure(obj, key, defaultValue)`: Helper for setting defaults safely.
 *
 * @example
 * const schema = z.object({
 *   target: z.string(),
 *   mode: z.enum(["append", "overwrite"]).optional(),
 * });
 *
 * const { parse } = annotationsParser("sql", schema);
 *
 * const result = parse(`
 *   -- @sql.target table_a
 *   -- @sql.mode "append"
 * `);
 *
 * if (result?.success) {
 *   console.log(result.data);
 *   // { target: "table_a", mode: "append" }
 * }
 */
export function annotationsParser<S extends z.ZodTypeAny>(
  identity: string,
  schema: S,
  init: {
    esc?: (s: string) => string;
    commentMarkers?: string[]; // line comment markers to scan (default ["--"])
    blockComments?: boolean; // scan /* ... */ too
    prefix?: string; // default "@"
    coalesce?: "array" | "first" | "last";
    argName?: RegExp; // arg-name pattern (default /[A-Za-z_][\w-]*/)
    normalizeArg?: (s: string) => string;
    findValueEnd?: (comment: string, start: number) => number;
    trim?: boolean; // trim extracted values (default true)
    normalizeValue?: (raw: string) => string; // e.g., strip quotes
  } = {},
) {
  const {
    esc = (s: string) => s.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&"),
    commentMarkers = ["--"],
    blockComments = false,
    prefix = "@",
    coalesce = "array",
    argName = /[A-Za-z_][\w-]*/,
    normalizeArg = (s: string) => s,
    findValueEnd,
    trim = true,
    normalizeValue = (raw: string) => {
      const v = trim ? raw.trim() : raw;
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        return v.slice(1, -1);
      }
      return v;
    },
  } = init;

  const token = `${prefix}${identity}.`;
  const atHeadRe = new RegExp(
    `^${esc(prefix)}${esc(identity)}\\.${argName.source}\\s+`,
  );
  const nextTokenRe = new RegExp(`\\s${esc(prefix)}`);

  const add = (obj: Record<string, unknown>, key: string, raw: string) => {
    const k = normalizeArg(key);
    const v = normalizeValue(raw);
    const prev = obj[k];
    if (prev === undefined) obj[k] = v;
    else if (coalesce === "array") {
      obj[k] = Array.isArray(prev) ? (prev.push(v), prev) : [prev as string, v];
    } else if (coalesce === "last") obj[k] = v; // "first" => ignore subsequent
  };

  const parseComment = (comment: string, obj: Record<string, unknown>) => {
    let i = 0;
    while (true) {
      const at = comment.indexOf(token, i);
      if (at === -1) break;

      const head = comment.slice(at);
      const m = atHeadRe.exec(head);
      if (!m) {
        i = at + 1;
        continue;
      }

      const arg = m[0].slice(token.length, m[0].length).split(/\s/, 1)[0];
      const start = at + m[0].length;

      let end: number;
      if (findValueEnd) end = findValueEnd(comment, start);
      else {
        const rel = comment.slice(start).search(nextTokenRe);
        end = rel >= 0 ? start + rel : comment.length;
      }

      add(obj, arg, comment.slice(start, end));
      i = end;
    }
  };

  // ---- helper: line starts (for discover line/col) ----
  const makeLineStarts = (text: string) => {
    const starts: number[] = [0];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") starts.push(i + 1);
    }
    return starts;
  };
  const posToLineCol = (starts: number[], pos: number) => {
    // linear scan is fine for typical SQL sizes; replace with binary search if needed
    let line = 0;
    for (let i = 0; i < starts.length; i++) {
      if (starts[i] <= pos) line = i;
      else break;
    }
    return { line: line + 1, column: pos - starts[line] + 1 };
  };

  // ---- helper: general segment scanner for discover ----
  const scanSegment = (
    segment: string,
    segmentStartPos: number,
    onHit: (arg: string, raw: string, startAbs: number, endAbs: number) => void,
  ) => {
    let i = 0;
    while (true) {
      const at = segment.indexOf(token, i);
      if (at === -1) break;

      const head = segment.slice(at);
      const m = atHeadRe.exec(head);
      if (!m) {
        i = at + 1;
        continue;
      }

      const arg = m[0].slice(token.length, m[0].length).split(/\s/, 1)[0];
      const start = at + m[0].length;

      let end: number;
      if (findValueEnd) end = findValueEnd(segment, start);
      else {
        const rel = segment.slice(start).search(nextTokenRe);
        end = rel >= 0 ? start + rel : segment.length;
      }

      const raw = segment.slice(start, end);
      onHit(arg, raw, segmentStartPos + start, segmentStartPos + end);
      i = end;
    }
  };

  type NonUndefined<T> = T extends undefined ? never : T;

  /**
   * If obj[key] is undefined, set it to `defaultValue`.
   * Returns `obj` with `key` narrowed to a non-undefined type.
   */
  const ensure = <T extends Record<PropertyKey, unknown>, K extends keyof T>(
    obj: T,
    key: K,
    defaultValue: NonUndefined<T[K]>,
  ) => {
    if (obj[key] === undefined) {
      // assignment is safe: NonUndefined<T[K]> is assignable to T[K]
      (obj as Record<K, T[K]>)[key] = defaultValue as T[K];
    }
    return obj as T & Record<K, NonUndefined<T[K]>>;
  };

  return {
    schema,
    /**
     * If obj[key] is undefined, set it to `defaultValue`.
     * Returns `obj` with `key` narrowed to a non-undefined type.
     */
    ensure,
    // Zod-only validation; returns schema.safeParse(obj)
    parse(
      text: string,
      parse?: (
        obj: {
          [K in keyof z.input<S>]?: z.input<S>[K];
        },
        check: typeof ensure,
      ) => boolean,
    ) {
      const obj: Record<string, unknown> = {};
      const lines = text.split(/\r?\n/);

      for (const line of lines) {
        let first = Infinity, mark = "";
        for (const m of commentMarkers) {
          const p = line.indexOf(m);
          if (p !== -1 && p < first) {
            first = p;
            mark = m;
          }
        }
        if (first === Infinity) continue;
        parseComment(line.slice(first + mark.length), obj);
      }

      if (blockComments) {
        let pos = 0;
        while (true) {
          const open = text.indexOf("/*", pos);
          if (open === -1) break;
          const close = text.indexOf("*/", open + 2);
          if (close === -1) break;
          scanSegment(text.slice(open + 2, close), open + 2, () => {});
          // We only need parseComment behavior (aggregation) for block comments:
          parseComment(text.slice(open + 2, close), obj);
          pos = close + 2;
        }
      }

      // at this time we've gotten all annotations into obj now let's validate
      // unless the caller wants to skip the parsing step
      // deno-lint-ignore no-explicit-any
      if (parse) { if (!parse(obj as any, ensure)) return undefined; }
      return schema.safeParse(obj);
    },

    // Discovery without validation: returns a rich summary of found annotations.
    discover(text: string) {
      const starts = makeLineStarts(text);
      const args: Record<string, {
        name: string;
        count: number;
        values: string[];
        uniqueValues: string[];
        first?: string;
        last?: string;
        occurrences: {
          value: string;
          line: number;
          column: number;
          start: number;
          end: number;
        }[];
      }> = {};
      const order: {
        arg: string;
        value: string;
        line: number;
        column: number;
        start: number;
        end: number;
      }[] = [];

      const onHit = (
        arg0: string,
        raw0: string,
        startAbs: number,
        endAbs: number,
      ) => {
        const arg = normalizeArg(arg0);
        const value = normalizeValue(raw0);
        const { line, column } = posToLineCol(starts, startAbs);
        order.push({ arg, value, line, column, start: startAbs, end: endAbs });

        const a = args[arg] ?? {
          name: arg,
          count: 0,
          values: [],
          uniqueValues: [],
          occurrences: [],
        };
        a.count++;
        a.values.push(value);
        a.occurrences.push({
          value,
          line,
          column,
          start: startAbs,
          end: endAbs,
        });
        a.first ??= value;
        a.last = value;
        if (!a.uniqueValues.includes(value)) a.uniqueValues.push(value);
        args[arg] = a;
      };

      // line comments
      const lines = text.split(/\r?\n/);
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        let first = Infinity, mark = "";
        for (const m of commentMarkers) {
          const p = line.indexOf(m);
          if (p !== -1 && p < first) {
            first = p;
            mark = m;
          }
        }
        if (first === Infinity) continue;

        const commentStartAbs = (starts[li] ?? 0) + first + mark.length;
        scanSegment(line.slice(first + mark.length), commentStartAbs, onHit);
      }

      // block comments
      if (blockComments) {
        let pos = 0;
        while (true) {
          const open = text.indexOf("/*", pos);
          if (open === -1) break;
          const close = text.indexOf("*/", open + 2);
          if (close === -1) break;
          const segStart = open + 2;
          scanSegment(text.slice(segStart, close), segStart, onHit);
          pos = close + 2;
        }
      }

      return {
        identity,
        prefix,
        total: order.length,
        args,
        order, // chronological list of all hits with positions
      };
    },
  };
}
