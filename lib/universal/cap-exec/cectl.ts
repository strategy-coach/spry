#!/usr/bin/env -S deno run -A

import { Command } from "jsr:@cliffy/command@1.0.0-rc.8";
import * as colors from "jsr:@std/fmt@1/colors";
import { resolve } from "jsr:@std/path@^1.0.0";
import { prepareCapExecsFs } from "./fs.ts"; // your FS adapter wrapper
import { type PrepareMode } from "./mod.ts";
import { z } from "jsr:@zod/zod@^4";

export const buildCtxSchema = z.object({
    cliOptions: z.json().optional(),
});

export type BuildContext = z.infer<typeof buildCtxSchema>;

async function runOnce(opts: {
    roots: string[];
    include?: string[];
    exclude?: string[];
    mode: PrepareMode; // "build" | "watch" | "dry-run"
    ctxInline?: Partial<BuildContext>; // overrides merged into schema defaults
}) {
    // 1) Prepare typed context
    const ctxDefaults: BuildContext = buildCtxSchema.parse({}); // defaults
    const ctx: BuildContext = buildCtxSchema.parse({
        ...ctxDefaults,
        ...(opts.ctxInline ?? {}),
    });

    // 2) Walk specs
    const specs = opts.roots.map((root) => ({
        root,
        baseDir: resolve("."), // current project root
        include: opts.include,
        exclude: opts.exclude,
    }));

    // 3) Project env to every process (pre/sink/post)
    const projectEnv = () => ({
        CAPEXEC_MODE: opts.mode,
        CAPEXEC_CONTEXT_JSON: JSON.stringify(ctx),
    });

    // 5) Execute
    const logger = (
        e: {
            level: "debug" | "info" | "warn" | "error";
            msg: string;
            meta?: Record<string, unknown>;
        },
    ) => {
        const tag = e.level.toUpperCase().padEnd(5);
        const line = `${colors.bold(colors.gray(`[${tag}]`))} ${e.msg} ${
            e.meta ? colors.gray(JSON.stringify(e.meta)) : ""
        }`;
        console.log(line);
    };

    for await (
        const ev of prepareCapExecsFs<BuildContext>({
            specs,
            mode: opts.mode,
            run: true,
            context: ctx,
            logger,
            adapter: {
                projectEnv, // inject CAPEXEC_* and context vars
                // (Optional) override resolvers/materializers here if desired
                // resolveStage: async (...) => ({ argv: ["sh","-c","..."], cwd: "..." }),
                // resolveSink: async  (...) => ({ argv: ["deno","run","-A", "script.ts"], cwd: "..." }),
                // materializeSingle: async (...args) => {...},
                // materializeMulti: async  (...args) => {...},
            },
        })
    ) {
        if (ev.phase === "prepared") {
            logger({
                level: "info",
                msg: "prepared",
                meta: { name: ev.prepared.source.name },
            });
        } else {
            logger({
                level: "info",
                msg: "executed",
                meta: { name: ev.prepared.source.name },
            });
        }
    }
}

await new Command()
    .name("cecpctl")
    .version("0.1.0")
    .description(
        "CapExec Content Preparation (CECP): discover, prepare, and execute capturable executables.",
    )
    .command("build")
    .description("Discover and build once.")
    .option("-r, --root <path:string>", "Root to walk (repeatable).", {
        collect: true,
    })
    .option("-I, --include <glob:string>", "Include glob(s).", {
        collect: true,
    })
    .option("-X, --exclude <glob:string>", "Exclude glob(s).", {
        collect: true,
    })
    .action(async (opts) => {
        const roots = (opts.root?.length ? opts.root : ["."]) as string[];
        await runOnce({
            roots,
            include: opts.include,
            exclude: opts.exclude,
            mode: "build",
            ctxInline: {
                cliOptions: opts,
            },
        });
    })
    .command("dry-run")
    .description("Run pipelines but do not write outputs.")
    .option("-r, --root <path:string>", "Root to walk (repeatable).", {
        collect: true,
    })
    .option("-I, --include <glob:string>", "Include glob(s).", {
        collect: true,
    })
    .option("-X, --exclude <glob:string>", "Exclude glob(s).", {
        collect: true,
    })
    .action(async (opts) => {
        const roots = (opts.root?.length ? opts.root : ["."]) as string[];
        await runOnce({
            roots,
            include: opts.include,
            exclude: opts.exclude,
            mode: "dry-run",
        });
    })
    .command("watch")
    .description("Rebuild on change (edge-triggered; basic).")
    .option("-r, --root <path:string>", "Root to watch (repeatable).", {
        collect: true,
    })
    .option("-I, --include <glob:string>", "Include glob(s).", {
        collect: true,
    })
    .option("-X, --exclude <glob:string>", "Exclude glob(s).", {
        collect: true,
    })
    .action(async (opts) => {
        const roots = (opts.root?.length ? opts.root : ["."]) as string[];
        const debounceMs = 150;
        let timer: number | null = null;

        // First build
        await runOnce({
            roots,
            include: opts.include,
            exclude: opts.exclude,
            mode: "build",
        });

        // Basic FS watch (use your own watcher if you need cross-platform globs)
        const watcher = Deno.watchFs(roots);
        for await (const ev of watcher) {
            if (!["modify", "create", "remove"].includes(ev.kind)) continue;
            if (timer) clearTimeout(timer);
            timer = setTimeout(async () => {
                console.log(colors.cyan("⟳ change detected, rebuilding…"));
                await runOnce({
                    roots,
                    include: opts.include,
                    exclude: opts.exclude,
                    mode: "build",
                });
            }, debounceMs) as unknown as number;
        }
    })
    .parse(Deno.args);
