import { z } from "jsr:@zod/zod@4";
import { basename, normalize } from "jsr:@std/path@1";

/**
 * includeTextRegions()
 *  - Builds the Zod schema for parsing `{ include, includeEnd }` directive strings
 *  - Supports ${var} substitutions via `init.vars(name)`
 *  - Disallows POSIX absolute paths (leading '/')
 *  - Attaches caller-supplied line numbers via `init.lineNums()`, called ONCE per parse
 *
 * Returned schema value shape:
 * {
 *   include:    { relPath: string; name: string; lineNum: number };
 *   includeEnd: { name: string; lineNum: number };
 * }
 */
export function includeTextRegions(init: {
    vars: (name: string) => string;
    lineNums: () => { include: number; includeEnd: number };
}) {
    const TOKENS_RE = /"([^"]+)"|(\S+)/g;
    const tokenize = (s: string): string[] => {
        const out: string[] = [];
        let m: RegExpExecArray | null;
        while ((m = TOKENS_RE.exec(s))) out.push(m[1] ?? m[2]);
        return out;
    };

    function expandTemplateOrIssue(
        raw: string,
        ctx: z.RefinementCtx,
        pathKey: "include" | "includeEnd",
    ): string {
        const rx = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
        return raw.replace(rx, (_match, rawName: string) => {
            try {
                const v = init.vars(rawName);
                if (typeof v !== "string") {
                    ctx.addIssue({
                        path: [pathKey],
                        code: "custom",
                        message: `\${${rawName}} did not resolve to a string`,
                    });
                    return "";
                }
                return v;
            } catch {
                ctx.addIssue({
                    path: [pathKey],
                    code: "custom",
                    message: `unknown template variable \${${rawName}}`,
                });
                return "";
            }
        });
    }

    const isDisallowedAbsolute = (p: string) => p.startsWith("/");

    function parseInclude(
        input: string,
        ctx: z.RefinementCtx,
        lineNum: number,
    ): { relPath: string; name: string; lineNum: number } | typeof z.NEVER {
        const expanded = expandTemplateOrIssue(input.trim(), ctx, "include");
        if (!expanded && /\$\{/.test(input)) return z.NEVER;

        const tokens = tokenize(expanded);
        if (tokens.length === 0) {
            ctx.addIssue({
                path: ["include"],
                code: "custom",
                message: "missing filepath",
            });
            return z.NEVER;
        }
        if (tokens.length > 2) {
            ctx.addIssue({
                path: ["include"],
                code: "custom",
                message:
                    "too many arguments; if name has spaces, wrap it in double quotes",
            });
            return z.NEVER;
        }

        const pathRaw = tokens[0];
        if (isDisallowedAbsolute(pathRaw)) {
            ctx.addIssue({
                path: ["include"],
                code: "custom",
                message: "absolute paths starting with '/' are not allowed",
            });
            return z.NEVER;
        }

        const normalized = normalize(pathRaw);
        const relPath = pathRaw.startsWith("./")
            ? `./${normalized.replace(/^\.\/+/, "")}`
            : normalized;
        const rawName = tokens[1];
        const name = (rawName?.replace(/^"|"$/g, "")) ?? basename(relPath);

        return { relPath, name, lineNum };
    }

    function parseIncludeEnd(
        input: string,
        _ctx: z.RefinementCtx,
        lineNum: number,
    ): { name: string; lineNum: number } {
        const tokens = tokenize(input.trim());
        const rawName = tokens[0] ?? "";
        const name = rawName.replace(/^"|"$/g, "");
        return { name, lineNum };
    }

    const schema = z
        .object({
            include: z.string(),
            includeEnd: z.string(),
        })
        .transform((val, ctx) => {
            const lines = init.lineNums(); // once per parse
            const inc = parseInclude(val.include, ctx, lines.include);
            const end = parseIncludeEnd(val.includeEnd, ctx, lines.includeEnd);

            if (inc === z.NEVER) return z.NEVER;

            // NEW: require matching names
            if (inc.name !== end.name) {
                ctx.addIssue({
                    path: ["includeEnd"],
                    code: "custom",
                    message:
                        `includeEnd name "${end.name}" must match include name "${inc.name}"`,
                });
                return z.NEVER;
            }

            return { include: inc, includeEnd: end };
        });

    return { schema, vars: init.vars };
}

/** Convenience types derived from the built schema */
export type IncludeTextRegionsDirectives = ReturnType<
    typeof includeTextRegions
>;
export type ParsedIncludeTextRegions = z.infer<
    IncludeTextRegionsDirectives["schema"]
>;

/**
 * TextRegions
 *  - Builder that wraps a built textRegions() and provides file-edit helpers.
 *
 * include(directives, src, getTarget, onError?)
 *  - directives: parsed Zod object (output of schema.parse)
 *  - src:        the content to INSERT (string | Promise | function of directives)
 *  - getTarget:  returns the current TARGET file content as string
 *  - onError:    optional; if provided, called with (error, directives, target)
 *                and should return a fallback string to use as the result
 *
 * Behavior:
 *  - Keeps the include & includeEnd directive lines intact.
 *  - Replaces ONLY the lines strictly between those two line numbers (exclusive).
 *  - Line numbers are treated as 1-based indices.
 *  - Preserves the target file's EOL convention (\n vs \r\n).
 */
export class TextRegions {
    /**
     * Resolve `src` into a string.
     */
    private async resolveSrc(
        src:
            | string
            | Promise<string>
            | ((d: ParsedIncludeTextRegions) => Promise<string> | string),
        directives: ParsedIncludeTextRegions,
    ): Promise<string> {
        if (typeof src === "string") return src;
        if (typeof src === "function") return await src(directives);
        return await src;
    }

    /**
     * Replace the region between include.lineNum and includeEnd.lineNum (exclusive).
     */
    async include(
        directives: ParsedIncludeTextRegions,
        src:
            | string
            | Promise<string>
            | ((d: ParsedIncludeTextRegions) => Promise<string> | string),
        getTarget: (d: ParsedIncludeTextRegions) => string | Promise<string>,
        onError?: (
            error: unknown,
            directives: ParsedIncludeTextRegions,
            target: string,
        ) => string | Promise<string>,
    ): Promise<string> {
        let target = "";
        try {
            // 1) Read target first
            target = await getTarget(directives);

            // 2) Then resolve src (may throw)
            const contentToInsert = await this.resolveSrc(src, directives);
            target = await getTarget(directives);

            // detect EOL style of the target
            const eol = target.includes("\r\n") ? "\r\n" : "\n";
            const lines = target.split(/\r?\n/);

            const beginLine = directives.include.lineNum; // 1-based
            const endLine = directives.includeEnd.lineNum; // 1-based

            if (!Number.isInteger(beginLine) || !Number.isInteger(endLine)) {
                throw new Error(
                    "Invalid or missing line numbers on directives.",
                );
            }
            if (
                beginLine < 1 || endLine < 1 || beginLine > lines.length ||
                endLine > lines.length
            ) {
                throw new Error(
                    "Directive line numbers out of range of target file.",
                );
            }
            if (beginLine >= endLine) {
                throw new Error(
                    "include.lineNum must be < includeEnd.lineNum.",
                );
            }

            const b = beginLine - 1; // zero-based index of include line
            const e = endLine - 1; // zero-based index of includeEnd line

            const before = lines.slice(0, b + 1); // keep include line
            const after = lines.slice(e); // keep includeEnd line (and below)

            const insertLines = contentToInsert.split(/\r?\n/);

            const result = before.concat(insertLines, after).join(eol);
            return result;
        } catch (error) {
            if (onError) return await onError(error, directives, target);
            return target || "";
        }
    }
}
