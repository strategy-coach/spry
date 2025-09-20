#!/usr/bin/env -S deno run -A
/**
 * DevExperience: single-class DX runner for sqlpage + sqlite reloader.
 * - Optional init SQL load (before sqlpage starts)
 * - Starts sqlpage, then a file watcher
 * - On changes: stops watcher -> stops sqlpage -> (re)loads SQLite -> gates -> restarts sqlpage -> restarts watcher
 * - Watcher is never running while SQL is being generated or SQLite is being refreshed.
 */

import * as color from "jsr:@std/fmt@1/colors";
import { debounce } from "jsr:@std/async@1/debounce";

type SqlSource =
    | string
    | Iterable<string>
    | AsyncIterable<string>
    | Promise<string | Iterable<string> | AsyncIterable<string>>;

type ReloadPhase = "init" | "watch";

export interface DevExperienceOptions {
    dbPath?: string;
    cwd?: string;
    env?: Record<string, string>;
    watch?: string[];
    sqlTextFn?: () => SqlSource;
    policy?: { onInit?: boolean; onReload?: boolean | (() => boolean) };
    sqlpagePath?: string;
    sqlpageArgs?: string[];
    sqlite3Path?: string;
    restartSignal?: Deno.Signal;
    debounceMs?: number;
    sqlpageStopGraceMs?: number;
    /** Optional fixed delay before restarting sqlpage (ms). */
    restartDelayMs?: number;
    /** Awaited before sqlpage restarts. Defaults to a no-op. */
    beforeSqlpageRestart?: () => Promise<void> | void;
    defaultLogging?: boolean;
}

export class DevExperience extends EventTarget {
    /* ---------------- Public Fluent API ---------------- */
    withDb(dbPath: string) {
        this.cfg.dbPath = dbPath;
        return this;
    }
    withEnv(env: Record<string, string>) {
        this.cfg.env = env;
        return this;
    }
    withCWD(cwd: string) {
        this.cfg.cwd = cwd;
        return this;
    }
    withSqlText(
        fn: () => SqlSource,
        opts?: { onInit?: boolean; onReload?: boolean | (() => boolean) },
    ) {
        this.cfg.sqlTextFn = fn;
        if (opts) this.cfg.policy = { ...this.cfg.policy, ...opts };
        return this;
    }
    watch(...paths: string[]) {
        this.cfg.watch = paths;
        return this;
    }
    sqlpagePath(p: string) {
        this.cfg.sqlpagePath = p;
        return this;
    }
    sqlpageArgs(...a: string[]) {
        this.cfg.sqlpageArgs = a;
        return this;
    }
    sqlite3Path(p: string) {
        this.cfg.sqlite3Path = p;
        return this;
    }
    restartSignal(sig: Deno.Signal) {
        this.cfg.restartSignal = sig;
        return this;
    }
    debounce(ms: number) {
        this.cfg.debounceMs = ms;
        return this;
    }
    sqlpageStopGraceMs(ms: number) {
        this.cfg.sqlpageStopGraceMs = ms;
        return this;
    }
    restartDelayMs(ms: number) {
        this.cfg.restartDelayMs = ms;
        return this;
    }
    beforeSqlpageRestart(fn: () => Promise<void> | void) {
        this.cfg.beforeSqlpageRestart = fn;
        return this;
    }
    on<T = unknown>(type: string, handler: (detail: T) => void) {
        const wrapped = (e: Event) => handler((e as CustomEvent).detail as T);
        this.addEventListener(type, wrapped);
        return () => this.removeEventListener(type, wrapped);
    }

    /** Start the orchestrator. Intentionally never resolves. */
    async start(): Promise<void> {
        this.assertReady();

        // (1) Optional init SQL load (watcher is not running yet)
        if (this.cfg.policy.onInit) {
            this.emit("reload:start", {
                phase: "init" as ReloadPhase,
                db: this.cfg.dbPath,
            });
            const st = await this.runSqlTextIntoSqlite();
            if (!st.success) {
                this.emit("reload:fail", {
                    code: st.code,
                    phase: "init" as ReloadPhase,
                });
            } else {
                this.emit("sqlite3:closed", { phase: "init" as ReloadPhase });
                await this.applyRestartGates();
                this.emit("reload:ok", {
                    phase: "init" as ReloadPhase,
                    db: this.cfg.dbPath,
                });
            }
        }

        // (2) Start sqlpage
        this.sqlpage = this.spawnSqlpage();

        // (3) Start watcher
        this.startWatcher();

        // Keep process alive indefinitely
        await new Promise<never>(() => {/* never resolves */});
    }

    /* ---------------- Construction ---------------- */
    protected cfg: Required<DevExperienceOptions>;
    protected sqlpage?: Deno.ChildProcess;
    protected watcher?: Deno.FsWatcher;
    protected watcherActive = false;
    protected reloading = false;
    #te = new TextEncoder();

    // debounced scheduler bound to instance
    protected scheduleReload: () => void;

    constructor(opts?: DevExperienceOptions) {
        super();
        this.cfg = {
            dbPath: opts?.dbPath ?? "",
            cwd: opts?.cwd ?? "",
            env: opts?.env ?? {},
            watch: opts?.watch ?? [],
            sqlTextFn: opts?.sqlTextFn ?? undefined!,
            policy: { onInit: false, onReload: true, ...(opts?.policy ?? {}) },
            sqlpagePath: opts?.sqlpagePath ?? "sqlpage",
            sqlpageArgs: opts?.sqlpageArgs ?? [],
            sqlite3Path: opts?.sqlite3Path ?? "sqlite3",
            restartSignal: opts?.restartSignal ?? "SIGHUP",
            debounceMs: opts?.debounceMs ?? 150,
            sqlpageStopGraceMs: opts?.sqlpageStopGraceMs ?? 1500,
            restartDelayMs: opts?.restartDelayMs ?? 0,
            beforeSqlpageRestart: opts?.beforeSqlpageRestart ??
                (() => {/* no-op */}),
            defaultLogging: opts?.defaultLogging ?? true,
        };

        // Debounced reload task
        this.scheduleReload = debounce(
            () => this.performReload(),
            this.cfg.debounceMs,
        );

        this.setupSignals();
        if (this.cfg.defaultLogging) this.attachDefaultConsoleLogging();
    }

    /* ---------------- Watcher lifecycle ---------------- */
    protected startWatcher() {
        if (this.watcherActive) return;
        this.watcher = Deno.watchFs(this.cfg.watch);
        this.watcherActive = true;

        // detached loop
        (async () => {
            try {
                for await (const ev of this.watcher!) {
                    this.emit("fs:event", ev);
                    if (
                        !ev.paths.length ||
                        !/modify|create|remove/.test(ev.kind)
                    ) continue;
                    this.emit("fs:debounce", { ms: this.cfg.debounceMs });
                    this.scheduleReload();
                }
            } catch (e) {
                // watcher closed or errored
                this.emit("watcher:error", { error: String(e) });
            } finally {
                this.watcherActive = false;
            }
        })();
        this.emit("watcher:started", { paths: this.cfg.watch.slice() });
    }

    protected stopWatcher() {
        if (this.watcher) {
            try {
                this.watcher.close();
            } catch { /* already closed */ }
            this.watcher = undefined;
        }
        this.watcherActive = false;
        this.emit("watcher:stopped", {});
    }

    /* ---------------- Reload pipeline ---------------- */
    protected async performReload() {
        if (this.reloading) return; // serialize
        this.reloading = true;
        try {
            // (A) stop watcher first (no events during regen/refresh)
            if (this.watcherActive) this.stopWatcher();

            const shouldRun = typeof this.cfg.policy.onReload === "function"
                ? !!this.cfg.policy.onReload()
                : this.cfg.policy.onReload !== false;
            if (!shouldRun) {
                this.emit("reload:skipped", {
                    reason: "policy.onReload=false",
                });
                // restart watcher to keep monitoring
                this.startWatcher();
                return;
            }

            this.emit("reload:start", {
                phase: "watch" as ReloadPhase,
                db: this.cfg.dbPath,
            });

            // (B) stop sqlpage
            await this.stopSqlpage(this.cfg.sqlpageStopGraceMs);

            // (C) regenerate/load SQL
            const st = await this.runSqlTextIntoSqlite();
            if (!st.success) {
                this.emit("reload:fail", {
                    code: st.code,
                    phase: "watch" as ReloadPhase,
                });
                // Don't restart sqlpage; just resume watching so dev can fix errors
                this.startWatcher();
                return;
            }

            // (D) announce DB closed, apply restart gates
            this.emit("sqlite3:closed", { phase: "watch" as ReloadPhase });
            await this.applyRestartGates();

            // (E) restart sqlpage
            this.sqlpage = this.spawnSqlpage();
            this.emit("reload:ok", {
                phase: "watch" as ReloadPhase,
                db: this.cfg.dbPath,
            });

            // (F) restart watcher
            this.startWatcher();
        } finally {
            this.reloading = false;
        }
    }

    /* ---------------- Processes & helpers ---------------- */
    protected emit<T>(type: string, detail: T) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    protected pipeChild(child: Deno.ChildProcess, name: "sqlpage" | "sqlite3") {
        if (child.stdout) {
            child.stdout
                .pipeThrough(new TextDecoderStream())
                .pipeTo(
                    new WritableStream<string>({
                        write: (chunk) => this.emit(`${name}:stdout`, chunk),
                    }),
                )
                .catch(() => {/* stream ended */});
        }
        if (child.stderr) {
            child.stderr
                .pipeThrough(new TextDecoderStream())
                .pipeTo(
                    new WritableStream<string>({
                        write: (chunk) => this.emit(`${name}:stderr`, chunk),
                    }),
                )
                .catch(() => {/* stream ended */});
        }
        (async () => {
            const st = await child.status;
            this.emit(`${name}:exit`, st);
        })();
    }

    protected async runSqlTextIntoSqlite(): Promise<Deno.CommandStatus> {
        let src: string | Iterable<string> | AsyncIterable<string>;
        try {
            src = await this.cfg.sqlTextFn();
            this.emit("sql:generated", {});
        } catch (e) {
            this.emit("reload:fail", { code: -1, error: String(e) });
            return { success: false, code: -1, signal: null };
        }

        const child = new Deno.Command(this.cfg.sqlite3Path, {
            args: [this.cfg.dbPath],
            stdin: "piped",
            stdout: "piped",
            stderr: "piped",
            cwd: this.cfg.cwd || undefined,
            env: Object.keys(this.cfg.env).length ? this.cfg.env : undefined,
        }).spawn();
        this.pipeChild(child, "sqlite3");

        if (child.stdin) {
            const writer = child.stdin.getWriter();
            try {
                if (typeof src === "string") {
                    const s = src.endsWith("\n") ? src : src + "\n";
                    await writer.write(this.#te.encode(s));
                    this.emit("sqlite3:stdin", s);
                } else if (Symbol.asyncIterator in Object(src)) {
                    for await (const s of src as AsyncIterable<string>) {
                        const line = s.endsWith("\n") ? s : s + "\n";
                        await writer.write(this.#te.encode(line));
                        this.emit("sqlite3:stdin", line);
                    }
                } else {
                    for (const s of src as Iterable<string>) {
                        const line = s.endsWith("\n") ? s : s + "\n";
                        await writer.write(this.#te.encode(line));
                        this.emit("sqlite3:stdin", line);
                    }
                }
            } finally {
                await writer.close();
            }
        }
        return await child.status;
    }

    protected spawnSqlpage(): Deno.ChildProcess {
        const child = new Deno.Command(this.cfg.sqlpagePath, {
            args: this.cfg.sqlpageArgs,
            stdin: "null",
            stdout: "piped",
            stderr: "piped",
            cwd: this.cfg.cwd || undefined,
            env: Object.keys(this.cfg.env).length ? this.cfg.env : undefined,
        }).spawn();
        this.emit("sqlpage:start", { pid: child.pid });
        this.pipeChild(child, "sqlpage");
        return child;
    }

    protected async stopSqlpage(graceMs = 1500): Promise<void> {
        const p = this.sqlpage;
        if (!p) return;
        try {
            p.kill("SIGTERM");
            this.emit("sqlpage:stopping", {
                pid: p.pid,
                signal: "SIGTERM" as Deno.Signal,
            });
        } catch {
            /* process may already be down */
        }
        const exited = await this.withTimeout(p.status, graceMs);
        if (!exited) {
            try {
                p.kill("SIGKILL");
                this.emit("sqlpage:stopping", {
                    pid: p.pid,
                    signal: "SIGKILL" as Deno.Signal,
                });
            } catch {
                /* ignore if already exited */
            }
            await this.withTimeout(p.status, 500);
        }
        this.emit("sqlpage:stopped", {});
        this.sqlpage = undefined;
    }

    /** Apply optional restart gates in order: delay → awaitable hook. */
    protected async applyRestartGates() {
        if (this.cfg.restartDelayMs && this.cfg.restartDelayMs > 0) {
            await this.sleep(this.cfg.restartDelayMs);
        }
        try {
            await this.cfg.beforeSqlpageRestart();
        } catch (e) {
            this.emit("restart:gate:error", { error: String(e) });
        }
    }

    protected async withTimeout<T>(
        promise: Promise<T>,
        ms: number,
    ): Promise<boolean> {
        let done = false;
        promise.finally(() => {
            done = true;
        });
        await Promise.race([promise, new Promise((r) => setTimeout(r, ms))]);
        return done;
    }

    protected shutdown() {
        // Stop watcher first to avoid further events
        this.stopWatcher();
        try {
            this.sqlpage?.kill("SIGTERM");
        } catch { /* already down */ }
        this.emit("shutdown", {});
        Deno.exit(0);
    }

    /* ---------------- Internals ---------------- */
    protected setupSignals() {
        const bound = this.shutdown.bind(this);
        Deno.addSignalListener("SIGINT", bound);
        Deno.addSignalListener("SIGTERM", bound);
    }

    protected assertReady() {
        if (!this.cfg.dbPath) throw new Error("dbPath is required");
        if (!this.cfg.watch.length) throw new Error("watch paths are required");
        if (!this.cfg.sqlTextFn) throw new Error("sqlTextFn is required");
    }

    protected sleep(ms: number) {
        return new Promise((r) => setTimeout(r, ms));
    }

    protected attachDefaultConsoleLogging() {
        this.on<{ paths: string[] }>(
            "watcher:started",
            ({ paths }) =>
                console.log(
                    color.gray(`watcher started for ${paths.join(", ")}`),
                ),
        );
        this.on<void>(
            "watcher:stopped",
            () => console.log(color.gray("watcher stopped")),
        );
        this.on<{ pid: number }>(
            "sqlpage:start",
            ({ pid }) =>
                console.log(
                    color.green(
                        `sqlpage ${
                            this.cfg.sqlpageArgs.join(" ")
                        } started (pid ${pid})`,
                    ),
                ),
        );
        this.on<{ pid: number; signal: Deno.Signal }>(
            "sqlpage:stopping",
            ({ pid, signal }) =>
                console.log(
                    color.yellow(`stopping sqlpage (pid ${pid}) via ${signal}`),
                ),
        );
        this.on<void>(
            "sqlpage:stopped",
            () => console.log(color.gray("sqlpage stopped")),
        );
        this.on<string>(
            "sqlpage:stdout",
            (s) => s.trim() && console.log(color.gray(s.trim())),
        );
        this.on<string>(
            "sqlpage:stderr",
            (s) => s.trim() && console.error(color.red(s.trim())),
        );
        this.on<Deno.FsEvent>(
            "fs:event",
            (e) =>
                console.log(
                    color.blue(`fs:${e.kind}`),
                    color.gray(e.paths.join(", ")),
                ),
        );
        this.on<{ ms: number }>(
            "fs:debounce",
            ({ ms }) => console.log(color.gray(`debounce ${ms}ms`)),
        );
        this.on<{ phase: ReloadPhase; db: string }>(
            "reload:start",
            ({ phase, db }) =>
                console.log(color.magenta(`reload (${phase}) -> ${db}`)),
        );
        this.on<{ phase: ReloadPhase }>(
            "sqlite3:closed",
            ({ phase }) => console.log(color.gray(`sqlite3 closed (${phase})`)),
        );
        this.on<{ error: string }>(
            "restart:gate:error",
            ({ error }) =>
                console.error(
                    color.yellow(`beforeSqlpageRestart threw: ${error}`),
                ),
        );
        this.on<void>("reload:ok", () => console.log(color.green("reload OK")));
        this.on<{ code?: number; error?: string }>(
            "reload:fail",
            ({ code, error }) =>
                console.error(
                    color.red(
                        `reload FAILED${
                            code !== undefined ? ` (${code})` : ""
                        }${error ? `: ${error}` : ""}`,
                    ),
                ),
        );
        this.on<{ reason: string }>(
            "reload:skipped",
            ({ reason }) =>
                console.log(color.gray(`reload skipped: ${reason}`)),
        );
        this.on<void>("shutdown", () => console.log(color.gray("shutdown")));
    }
}
