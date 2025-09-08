/**
 * Minimal tagged template for composing parameterized SQL, with nesting & raw chunks.
 *
 * Behavior
 * - Any non-SQL interpolation (string/number/boolean/bigint/Date/null/undefined) becomes:
 *   - a bound parameter in `safe()` (with placeholders controlled by `identifier`), and
 *   - an inlined SQL literal in `text()`.
 * - Arrays expand recursively as comma-separated items.
 * - Interpolated **SQL** is merged/spliced in (placeholders continue counting).
 * - Interpolated **raw(...)** is inserted **verbatim** (no params added).
 *
 * Lazy building
 * - Both `safe()` and `text()` loop `strings`/`exprs` **on demand** each call.
 */

export type SQLQuery = { text: string; values: readonly unknown[] };

export type SQL = {
    /**
     * Returns a parameterized query suitable for DB clients.
     *
     * @param options.identifier Controls placeholder format. Defaults to `"$"`.
     *   - `"$"` → `$1`, `$2`, ...
     *   - `":"` → `:1`, `:2`, ...
     *   - function → you decide: e.g. `(i) => ":p" + i` → `:p1`, `:p2`, ...
     */
    safe(options?: {
        identifier?: "$" | ":" | ((position: number) => string);
    }): SQLQuery;

    /**
     * Builds a single SQL string with **all parameters inlined as SQL literals**.
     * Nested `SQL` parts are inserted using their own `.text()` output.
     * Use for debugging/logging; for execution use `safe()`.
     *
     * @param options.ifDate Custom formatter for `Date` values. Must return the final SQL literal
     *                       (including quotes if desired).
     */
    text(options?: { ifDate?: (d: Date) => string }): string;

    /** Same as calling `text()` with default options. */
    toString(): string;
};

// ---------------------- Utility Functions ----------------------

export function isSQL(v: unknown): v is SQL {
    return (
        typeof v === "object" &&
        v !== null &&
        typeof (v as SQL).safe === "function" &&
        typeof (v as SQL).text === "function"
    );
}

/** Convert a single value into a SQL literal string (used by `.text()`). */
export function literal(
    v: unknown,
    opts?: { ifDate?: (d: Date) => string },
): string {
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "string") return `'${v.replaceAll("'", "''")}'`;
    if (typeof v === "number" || typeof v === "bigint") return String(v);
    if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
    if (v instanceof Date) {
        if (opts?.ifDate) return opts.ifDate(v);
        return `'${v.toISOString()}'`;
    }
    return `'${String(v).replaceAll("'", "''")}'`;
}

/**
 * Dedent template literal output if the first line is whitespace-only.
 * Removes the first blank line, then strips the smallest common indent.
 */
function dedentIfFirstLineBlank(s: string): string {
    if (s.length === 0) return s;

    const normalized = s.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");

    if (lines.length === 0) return s;
    if (lines[0].trim() !== "") return s; // leave unchanged if first line isn't blank

    // Drop first (blank) line
    lines.shift();

    // Find minimal indent of all non-empty lines
    let minIndent: number | null = null;
    for (const line of lines) {
        if (line.trim() === "") continue;
        const match = line.match(/^[ \t]*/);
        const indent = match ? match[0].length : 0;
        if (minIndent === null || indent < minIndent) minIndent = indent;
    }

    // Remove that indent
    if (minIndent && minIndent > 0) {
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            let remove = 0;
            while (
                remove < minIndent &&
                (line[remove] === " " || line[remove] === "\t")
            ) {
                remove++;
            }
            lines[i] = line.slice(remove);
        }
    }

    return lines.join("\n");
}

// ------------------------- RAW TEMPLATE ----------------------------------

type RawSQL = {
    readonly __raw: true;
    /** Build the raw text by walking its template and interpolations. */
    text(options?: { ifDate?: (d: Date) => string }): string;
};

function isRaw(x: unknown): x is RawSQL {
    // deno-lint-ignore no-explicit-any
    return typeof x === "object" && x !== null && (x as any).__raw === true;
}

export function raw(
    strings: TemplateStringsArray,
    ...exprs: unknown[]
): RawSQL {
    const buildText = (options?: { ifDate?: (d: Date) => string }) => {
        let out = "";

        const toRawText = (v: unknown): string => {
            if (isSQL(v)) return v.text(options);
            if (isRaw(v)) return v.text(options);
            if (Array.isArray(v)) return v.map(toRawText).join(", ");
            return String(v); // verbatim, no escaping
        };

        for (let i = 0; i < strings.length; i++) {
            out += strings[i];
            if (i < exprs.length) out += toRawText(exprs[i]);
        }

        return dedentIfFirstLineBlank(out);
    };

    return Object.freeze({
        __raw: true as const,
        text: buildText,
    });
}

// ------------------------- SQL TEMPLATE ----------------------------------

type Interp = unknown | readonly Interp[];
type PlaceholderFactory = (position: number) => string;

function resolveIdentifier(
    id?: "$" | ":" | PlaceholderFactory,
): PlaceholderFactory {
    if (typeof id === "function") return id;
    if (id === ":") return (i) => `:${i}`;
    return (i) => `$${i}`; // default "$"
}

/**
 * Tagged template that composes a parameterized SQL query with nesting & raw support.
 *
 * - Interpolation is **merged** when it's an `SQL` (placeholders continue counting).
 * - Interpolation is **inserted verbatim** when it's `raw(...)` (no parameters).
 * - Otherwise the value is a parameter (in `safe()`), or a literal (in `text()`).
 * - Arrays expand with ", " and each element follows these same rules recursively.
 *
 * Both `safe()` and `text()` are **lazy** and reconstruct their outputs each call.
 */
export function SQL(strings: TemplateStringsArray, ...exprs: Interp[]): SQL {
    /** Recursively build *parameterized* SQL for one interpolation, merging nested SQL. */
    const buildSafePart = (
        x: Interp,
        currentCount: number,
        ident: PlaceholderFactory,
    ): { text: string; values: unknown[] } => {
        // Raw chunk → insert as-is (no params)
        if (isRaw(x)) {
            return { text: x.text(), values: [] };
        }

        // Nested SQL with internal _buildSafe support
        // deno-lint-ignore no-explicit-any
        if (isSQL(x) && typeof (x as any)._buildSafe === "function") {
            // deno-lint-ignore no-explicit-any
            const nested: SQLQuery = (x as any)._buildSafe(currentCount, ident);
            return { text: nested.text, values: [...nested.values] };
        }

        // Nested SQL fallback: safe() + reindex placeholders
        if (isSQL(x)) {
            const nested = x.safe({ identifier: ident });
            const reindexed = nested.text.replace(
                /\$(\d+)/g,
                (_, n: string) => ident(currentCount + Number(n)),
            );
            return { text: reindexed, values: [...nested.values] };
        }

        // Arrays → join parts by ", "
        if (Array.isArray(x)) {
            if (x.length === 0) return { text: "", values: [] };
            let text = "";
            const values: unknown[] = [];
            for (let i = 0; i < x.length; i++) {
                const part = buildSafePart(
                    x[i],
                    currentCount + values.length,
                    ident,
                );
                if (i) text += ", ";
                text += part.text;
                values.push(...part.values);
            }
            return { text, values };
        }

        // Primitive/unknown → single placeholder
        return { text: ident(currentCount + 1), values: [x] };
    };

    /** Recursively build **inlined** SQL for one interpolation. */
    const buildTextPart = (
        x: Interp,
        options?: { ifDate?: (d: Date) => string },
    ): string => {
        if (isRaw(x)) return x.text(options);
        if (isSQL(x)) return x.text(options);
        if (Array.isArray(x)) {
            return x.map((v) => buildTextPart(v, options)).join(", ");
        }
        return literal(x, options);
    };

    /** Internal method used by parents to build parameterized SQL with an offset. */
    const _buildSafe = (
        startAt: number,
        ident: PlaceholderFactory,
    ): SQLQuery => {
        let text = "";
        const values: unknown[] = [];

        for (let i = 0; i < strings.length; i++) {
            text += strings[i];
            if (i < exprs.length) {
                const part = buildSafePart(
                    exprs[i],
                    startAt + values.length,
                    ident,
                );
                text += part.text;
                values.push(...part.values);
            }
        }

        // ✅ Dedent parameterized SQL if first line is whitespace-only
        return {
            text: dedentIfFirstLineBlank(text),
            values: Object.freeze(values),
        };
    };

    const publicSafe = (options?: {
        identifier?: "$" | ":" | ((position: number) => string);
    }): SQLQuery => {
        const ident = resolveIdentifier(options?.identifier);
        return _buildSafe(0, ident);
    };

    const buildText = (options?: { ifDate?: (d: Date) => string }): string => {
        let out = "";
        for (let i = 0; i < strings.length; i++) {
            out += strings[i];
            if (i < exprs.length) out += buildTextPart(exprs[i], options);
        }
        // ✅ Dedent inlined SQL if first line is whitespace-only
        return dedentIfFirstLineBlank(out);
    };

    // Return the SQL object. Add hidden _buildSafe for nested merge with offset.
    return Object.assign(
        {
            safe: publicSafe,
            text: buildText,
            toString: () => buildText(),
        } as SQL,
        { _buildSafe }, // internal
    );
}

/** Ensure a string ends with exactly one semicolon. */
export const ensureTrailingSemicolon = (str: string) =>
    str.replace(/;*\s*$/, ";");

/**
 * Inline parameter placeholders (`?`) in a SQL template with literal values.
 * Will work for any type of SQL text, but is especially useful for converting
 * from a Drizzle ORM query (which uses `?` placeholders) into a human-readable
 * SQL string with all parameters inlined.
 *
 * - Only replaces `?` placeholders that are **outside** single-quoted SQL string
 *   literals. Anything inside `'...'` (including doubled `''` escape sequences)
 *   is left untouched.
 * - Values are rendered as SQL-ish literals:
 *   - `string` → wrapped in single quotes with internal `'` doubled (e.g. `O'Hara` → `'O''Hara'`).
 *   - `number` → finite numbers serialized as-is; `NaN`/`±Infinity` → `null`.
 *   - `bigint` → `toString()` (no quotes).
 *   - `boolean` → `TRUE` / `FALSE`.
 *   - `Date` → ISO string in single quotes (UTC).
 *   - `Uint8Array` → hex blob like `X'00ff10'`.
 *   - `null`/`undefined` → `null`.
 *   - any other object/array → `JSON.stringify` wrapped in single quotes; any `'` are doubled.
 * - If there are more `?` than values, the remaining `?` are left as-is.
 *   Extra values in `params` are ignored.
 * - The returned SQL always has a trailing semicolon appended.
 *
 * ⚠️ **Note:** This is intended for debugging/logging or generating readable SQL.
 * It does **not** guarantee safety against SQL injection and should not be used
 * to execute queries against a database.
 *
 * @param q - Query descriptor
 * @param q.sql - SQL text containing `?` placeholders
 * @param q.params - Positional parameter values to inline
 * @returns SQL string with parameters inlined as literals, ending with `;`.
 *
 * @example
 * inlinedSQL({
 *   sql: "select * from users where id = ? and name like ? and note = '?'",
 *   params: [42, "%Ann%"]
 * });
 * // "select * from users where id = 42 and name like '%Ann%' and note = '?' ;"
 */
export function inlinedSQL(q: { sql: string; params: unknown[] }): string {
    function literal(v: unknown): string {
        if (v === null || v === undefined) return "null";
        if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
        if (typeof v === "number") {
            return Number.isFinite(v) ? String(v) : "null";
        }
        if (typeof v === "bigint") return v.toString();
        if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
        if (v instanceof Date) return `'${v.toISOString()}'`;
        if (v instanceof Uint8Array) {
            return "X'" + Array.from(v).map((b) =>
                b.toString(16).padStart(2, "0")
            ).join("") + "'";
        }
        return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
    }

    const { sql, params } = q;
    let i = 0, p = 0;
    let out = "";
    const n = sql.length;

    while (p < n) {
        const ch = sql[p];

        if (ch === "'") {
            // copy string literal verbatim, honoring doubled '' escapes
            out += ch;
            p++;
            while (p < n) {
                const c = sql[p];
                out += c;
                p++;
                if (c === "'") {
                    if (p < n && sql[p] === "'") {
                        out += "'";
                        p++;
                    } // escaped quote
                    else break; // end of string
                }
            }
            continue;
        }

        if (ch === "?") {
            out += i < params.length ? literal(params[i++]) : "?";
            p++;
            continue;
        }

        out += ch;
        p++;
    }

    return out + ";";
}
