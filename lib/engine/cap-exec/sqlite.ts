import { CapExecEnvAide } from "./env.ts";

/**
 * SqliteAide for Deno TypeScript-based capturable executables.
 *
 * Run SQLite via the `sqlite3` CLI using `Deno.Command`.
 * - `run()` → raw stdout string from sqlite.
 * - `toJson()` / `toStdOutJson()` → parse stdout as JSON and (optionally) attach execution context.
 *
 * ### Context modes
 * Use `.contextMode()` to control how `".context"` is attached:
 * - `"smart"` (default): if result is an **object**, return `{ ...result, ".context": { ... } }`;
 *   if result is an **array or scalar**, return it unchanged.
 * - `"none"`: never attach `.context`; return parsed JSON as-is.
 * - `"force"`: always attach `.context`.
 *   - If result is an **object**: `{ ...result, ".context": { ... } }`
 *   - If result is an **array/scalar**: `{ data: result, ".context": { ... } }`
 *
 * ### DB resolution
 * 1. Env var `CAPEXEC_<dbEnvKey>` (default `CAPEXEC_TARGET_SQLITEDB`).
 * 2. Explicit path via `.database(path)`.
 * 3. Fallback to `:memory:`.
 */
export class SqliteAide {
    private sql = "";
    private readonly env: CapExecEnvAide;
    private cmd = "sqlite3";
    private dbEnvKey = "TARGET_SQLITEDB";
    private dbExplicit?: string;
    private mode: ContextMode = ContextMode.Smart;

    static create(env = new CapExecEnvAide()) {
        return new SqliteAide(env);
    }

    constructor(env = new CapExecEnvAide()) {
        this.env = env;
    }

    sqlText(s: string) {
        this.sql = s;
        return this;
    }

    database(path: string) {
        this.dbExplicit = path;
        return this;
    }

    sqliteCmd(cmd: string) {
        this.cmd = cmd;
        return this;
    }

    databaseEnvSrc(name?: string) {
        this.dbEnvKey = name ?? "TARGET_SQLITEDB";
        return this;
    }

    contextMode(
        mode: ContextMode | "smart" | "none" | "force" = ContextMode.Smart,
    ) {
        this.mode = typeof mode === "string"
            // deno-lint-ignore no-explicit-any
            ? (ContextMode as any)[capitalize(mode)]
            : mode;
        return this;
    }

    async run() {
        const { target } = this.resolveDb();
        const p = new Deno.Command(this.cmd, {
            args: [target],
            stdin: "piped",
            stdout: "piped",
            stderr: "piped",
        }).spawn();
        const w = p.stdin.getWriter();
        await w.write(new TextEncoder().encode(this.sql));
        w.releaseLock();
        await p.stdin.close();
        const { code, stdout, stderr } = await p.output();
        if (code) throw new Error(new TextDecoder().decode(stderr));
        return new TextDecoder().decode(stdout).trim();
    }

    async toJson() {
        const sel = this.resolveDb();
        const raw = await this.run();
        const parsed = JSON.parse(raw) as unknown;
        if (this.mode === ContextMode.None) return parsed;

        const ctx = {
            sqliteDB: {
                target: sel.target,
                kind: sel.target === ":memory:" ? "memory" : "file",
                source: sel.source,
                envKey: sel.envKey,
                warning: "warning" in sel ? sel.warning : undefined,
            },
            capExecEnv: this.env.toObject(),
        };

        const isObj = isPlainObject(parsed);
        if (this.mode === ContextMode.Smart) {
            return isObj
                ? { ...(parsed as Record<string, unknown>), ".context": ctx }
                : parsed;
        }
        return isObj
            ? { ...(parsed as Record<string, unknown>), ".context": ctx }
            : { data: parsed, ".context": ctx };
    }

    /**
     * Execute and print JSON produced by {@link toJson}.
     * @param pretty if true, prints with indentation (2 spaces). Default: false
     */
    async toStdOutJson(pretty = false) {
        const obj = await this.toJson();
        console.log(JSON.stringify(obj, null, pretty ? 2 : 0));
    }

    private resolveDb() {
        const fromEnv = this.env.get(this.dbEnvKey);
        const envKey = this.env.prefix + this.dbEnvKey;
        if (fromEnv && fromEnv.trim() !== "") {
            return {
                target: fromEnv,
                source: "env" as const,
                envKey,
            };
        }
        if (this.dbExplicit) {
            return {
                target: this.dbExplicit,
                source: "explicit" as const,
                envKey,
            };
        }
        return {
            target: ":memory:",
            source: "fallback" as const,
            envKey,
            warning:
                `Missing ${envKey} and no explicit database provided; using in-memory.`,
        };
    }
}

/** Enum of context modes. */
export enum ContextMode {
    Force = "force",
    Smart = "smart",
    None = "none",
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function capitalize<T extends string>(s: T): Capitalize<T> {
    return (s.charAt(0).toUpperCase() + s.slice(1)) as Capitalize<T>;
}
