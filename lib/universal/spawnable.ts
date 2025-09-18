// Deno 2.4+ — ultra-simple, self-contained builder around Deno.Command
// Simplified: no helper utilities; explicit args only; flexible sync/async stdin.

export class Spawnable {
    private constructor(
        private readonly cmdSupplier:
            | string
            | URL
            | ((purpose: "spawn", ...args: string[]) => string | URL),
        private readonly defaults: {
            args?: string[];
            env?: Record<string, string>;
            cwd?: string;
            stdin?:
                | Uint8Array
                | string
                | Iterable<string | Uint8Array>
                | AsyncIterable<string | Uint8Array>
                | (() =>
                    | string
                    | Uint8Array
                    | Iterable<string | Uint8Array>
                    | AsyncIterable<string | Uint8Array>)
                | ((
                    w: WritableStreamDefaultWriter<Uint8Array>,
                ) => Promise<void> | void);
            timeoutMs?: number;
            abort?: AbortSignal;
        } = {},
    ) {}

    static from(
        cmd:
            | string
            | URL
            | ((purpose: "spawn", ...args: string[]) => string | URL),
    ) {
        return new Spawnable(cmd, {});
    }

    withArgs(args: string[]) {
        return new Spawnable(this.cmdSupplier, { ...this.defaults, args });
    }

    // NEW: append to existing args (used by CapExec to preserve base args)
    withArgsAppend(...args: string[]) {
        const next = [...(this.defaults.args ?? []), ...args];
        return new Spawnable(this.cmdSupplier, {
            ...this.defaults,
            args: next,
        });
    }

    withEnv<T extends Record<string, string>>(
        env: T,
        opts?: { inherit?: boolean },
    ) {
        const base = opts?.inherit
            ? { ...Deno.env.toObject(), ...this.defaults.env }
            : (this.defaults.env ?? {});
        return new Spawnable(this.cmdSupplier, {
            ...this.defaults,
            env: { ...base, ...env },
        });
    }

    withCwd(cwd: string) {
        return new Spawnable(this.cmdSupplier, { ...this.defaults, cwd });
    }
    withTimeout(ms: number) {
        return new Spawnable(this.cmdSupplier, {
            ...this.defaults,
            timeoutMs: ms,
        });
    }
    withAbort(signal: AbortSignal) {
        return new Spawnable(this.cmdSupplier, {
            ...this.defaults,
            abort: signal,
        });
    }
    withStdin(stdin: NonNullable<typeof this.defaults.stdin>) {
        return new Spawnable(this.cmdSupplier, { ...this.defaults, stdin });
    }

    async run(overrides?: Partial<typeof this.defaults>) {
        const cfg = { ...this.defaults, ...overrides };
        const args = cfg.args ?? [];

        const resolved = typeof this.cmdSupplier === "function"
            ? this.cmdSupplier("spawn", ...args)
            : this.cmdSupplier;
        const bin = resolved instanceof URL
            ? resolved.pathname
            : String(resolved);

        const cmd = new Deno.Command(bin, {
            args,
            env: cfg.env,
            cwd: cfg.cwd,
            stdin: cfg.stdin ? "piped" : undefined,
            stdout: "piped",
            stderr: "piped",
            signal: cfg.abort,
        });

        const child = cmd.spawn();

        let timeoutId: number | undefined;
        if (cfg.timeoutMs && !cfg.abort?.aborted) {
            const ctrl = new AbortController();
            const original = cfg.abort;
            if (original) {
                original.addEventListener(
                    "abort",
                    () => ctrl.abort(original.reason),
                    { once: true },
                );
            }
            timeoutId = setTimeout(
                () => ctrl.abort("Spawnable timeout"),
                cfg.timeoutMs,
            ) as unknown as number;
            ctrl.signal.addEventListener("abort", () => {
                try {
                    child.kill();
                } catch { /* ignore */ }
            }, { once: true });
        }

        if (cfg.stdin) {
            const w = child.stdin.getWriter();
            try {
                const source = typeof cfg.stdin === "function"
                    // deno-lint-ignore ban-types
                    ? (cfg.stdin as Function)(w)
                    : cfg.stdin;
                if (typeof source === "undefined") {
                    // writer callback already handled
                } else if (source instanceof Uint8Array) {
                    await w.write(source);
                } else if (typeof source === "string") {
                    await w.write(Spawnable.#te.encode(source));
                } else if (Symbol.asyncIterator in Object(source)) {
                    for await (
                        const chunk of source as AsyncIterable<
                            string | Uint8Array
                        >
                    ) {
                        await w.write(
                            typeof chunk === "string"
                                ? Spawnable.#te.encode(chunk)
                                : chunk,
                        );
                    }
                } else if (Symbol.iterator in Object(source)) {
                    for (
                        const chunk of source as Iterable<string | Uint8Array>
                    ) {
                        await w.write(
                            typeof chunk === "string"
                                ? Spawnable.#te.encode(chunk)
                                : chunk,
                        );
                    }
                }
            } finally {
                await w.close();
            }
        }

        const started = performance.now();
        const { code, success, stdout: stdoutRaw, stderr: stderrRaw } =
            await child.output();
        const durationMs = Math.round(performance.now() - started);

        child.unref();
        if (timeoutId) clearTimeout(timeoutId);

        return {
            command: [bin, ...args] as const,
            code,
            success,
            stdoutRaw,
            stderrRaw,
            stdout: () => Spawnable.#td.decode(stdoutRaw),
            stderr: () => Spawnable.#td.decode(stderrRaw),
            durationMs,
            env: cfg.env as Readonly<Record<string, string>> | undefined,
        } as const;
    }

    async runJson<T = unknown>(overrides?: Parameters<Spawnable["run"]>[0]) {
        const r = await this.run(overrides);
        const text = r.stdout();
        try {
            return JSON.parse(text) as T;
        } catch (e) {
            const msg = (e as Error).message;
            throw new Error(
                `JSON parse error: ${msg}\nOutput was:\n${text.slice(0, 4096)}`,
            );
        }
    }

    static #td = new TextDecoder();
    static #te = new TextEncoder();
}

export const spawnable = Spawnable.from.bind(Spawnable);
