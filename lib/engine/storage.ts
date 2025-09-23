import { ensureDir } from "jsr:@std/fs@^1/ensure-dir";
import { dirname, isAbsolute, join, normalize } from "jsr:@std/path@1";
import { z } from "jsr:@zod/zod@4";

// deno-lint-ignore no-explicit-any
type Any = any;

/**
 * Basic filesystem store. Writes text/bytes to caller-provided RELATIVE paths under destRoot.
 * No atomic temp/rename; just ensure dirs and write.
 */
export class Store<I extends string> {
    readonly destFsRoot: string;

    constructor(destRoot: string, readonly webPathRoot?: string) {
        this.destFsRoot = normalize(destRoot);
    }

    webPath(relPath: string) {
        return this.webPathRoot ? join(this.webPathRoot, relPath) : relPath;
    }

    /**
     * Write text content to a relative path (typed by I).
     * Returns the absolute path written.
     */
    async writeText(
        relPath: I,
        text:
            | string
            | ((s: Store<I>) => string),
    ): Promise<string> {
        const bytes = new TextEncoder().encode(
            typeof text === "string" ? text : text(this),
        );
        return await this.writeBytes(relPath, bytes);
    }

    /**
     * Write binary content to a relative path (typed by I).
     * Returns the absolute path written.
     */
    async writeBytes(relPath: I, bytes: Uint8Array): Promise<string> {
        const abs = this.resolveRel(relPath);
        await ensureDir(dirname(abs));
        await Deno.writeFile(abs, bytes);
        return abs;
    }

    // ---------- overridables kept inside the class ----------

    protected resolveRel(relPath: string): string {
        if (isAbsolute(relPath)) {
            throw new Error(
                `Expected a relative path, got absolute: ${relPath}`,
            );
        }
        const normRel = normalize(relPath);
        if (normRel.startsWith("../")) {
            throw new Error(`Path escapes store root: ${relPath}`);
        }
        return normalize(join(this.destFsRoot, normRel));
    }
}

/**
 * JSON convenience wrapper. Optionally validates with Zod before writing.
 */
export class JsonStore<
    I extends string,
    Z extends z.ZodTypeAny | undefined = undefined,
> {
    constructor(
        readonly store: Store<I>,
        readonly schema?: Z,
        readonly init?: { readonly pretty?: boolean },
    ) {
    }

    async write(
        relPath: I,
        value: Z extends z.ZodTypeAny ? z.infer<NonNullable<Z>> : unknown,
        replacer?: (this: Any, key: string, value: Any) => Any,
    ): Promise<string> {
        const validated = this.validate(value);
        const json = this.init?.pretty
            ? JSON.stringify(validated, replacer, 2)
            : JSON.stringify(validated, replacer);
        return await this.store.writeText(relPath, json);
    }

    protected validate(value: unknown): unknown {
        if (!this.schema) return value;
        return (this.schema as z.ZodTypeAny).parse(value);
    }
}
