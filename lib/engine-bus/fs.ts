// core-fs.ts
import { walk, type WalkEntry, type WalkOptions } from "jsr:@std/fs@1/walk";
import { basename, dirname, extname, join, relative } from "jsr:@std/path@1";
import { detectLanguageByPath } from "../universal/content/code.ts";
import {
    isSrcCodeLangSpecSupplier,
    type Resource,
    ResourceSupplier,
    SrcCodeLangSpecSupplier,
    type TextProducer,
    type TextSupplier,
} from "./resource.ts";

export type FsWalkedEncounter = {
    readonly supplier: {
        readonly identity?: string;
        readonly root: string;
    };
    readonly walkEntry: WalkEntry;
};

export const isFsWalkedEncounter = (o: unknown): o is FsWalkedEncounter =>
    o && typeof o === "object" && "walkEntry" in o && "supplier" in o &&
        typeof o.walkEntry === "object" && typeof o.supplier === "object"
        ? true
        : false;

export type FsFileResource = Resource & TextSupplier & TextProducer & {
    readonly absFsPath: string;
    readonly relFsPath: string;
    readonly webPath?: string;
    readonly extensions: ReturnType<typeof pathExtensions>;
};

export const isFsFileResource = (o: unknown): o is FsFileResource =>
    o && typeof o === "object" && "absFsPath" in o && "relFsPath" in o &&
        typeof o.absFsPath === "string" && typeof o.relFsPath == "string"
        ? true
        : false;

export function pathExtensions(path: string) {
    const name = basename(path);
    const parts = name.split(".");
    const exts = parts.slice(1).map((
        e,
        i,
        a,
    ) => (i < a.length - 1 ? `.${e}` : e));
    const terminal = exts[exts.length - 1] ?? "";
    return {
        extensions: exts,
        terminal,
        autoMaterializable: () => {
            if (exts.length < 2) return false;
            const base = parts[0];
            const penultimate = parts[parts.length - 2];
            return join(
                dirname(path),
                `${base}.${
                    penultimate.split(".").slice(0, -1).join(".")
                }auto.${penultimate}`,
            );
        },
    };
}

export type FsFilesContributorInit<Identity extends string> = {
    readonly identity: Identity;
    readonly root: string;
    readonly walkOptions?: WalkOptions;
    readonly relFsPath?: (path: string) => string;
    readonly webPath?: (path: string) => string;
};

export function fsFilesContributor<R extends Resource, Identity extends string>(
    init: FsFilesContributorInit<Identity>,
): ResourceSupplier<R> {
    const { identity, root, walkOptions } = init;
    return async function* ({ signal }) {
        for await (const walkEntry of walk(root, walkOptions)) {
            const { path: absFsPath } = walkEntry;
            if (signal?.aborted) return;
            const srcCodeLanguage = detectLanguageByPath(absFsPath);
            yield {
                nature: "unknown", // will be overwritten when annotations parsed
                absFsPath: absFsPath,
                relFsPath: init.relFsPath?.(absFsPath) ??
                    relative(root, absFsPath),
                webPath: init.webPath?.(absFsPath),
                text: async () => await Deno.readTextFile(absFsPath),
                walkEntry,
                supplier: {
                    identity,
                    root,
                },
                srcCodeLanguage,
                isSystemGenerated: false,
                extensions: pathExtensions(absFsPath),
                writeText: async (text: string) => {
                    await Deno.writeTextFile(absFsPath, text);
                    return text;
                },
            } as unknown as R;
        }
    };
}

export class FsFilesCollection<R extends Resource> {
    readonly resources: readonly R[] = [];
    readonly fsFiles: readonly FsFileResource[] = [];
    readonly walkedFiles: readonly (FsFileResource & FsWalkedEncounter)[] = [];
    readonly walkedSrcFiles: readonly (
        & FsFileResource
        & FsWalkedEncounter
        & SrcCodeLangSpecSupplier
    )[] = [];
    readonly execCandidate = executables();
    readonly isExecutable = this.execCandidate.isExecutable;

    constructor() {
    }

    // deno-lint-ignore require-await
    async register(resource: R) {
        (this.resources as R[]).push(resource);
        if (isFsFileResource(resource)) {
            (this.fsFiles as FsFileResource[]).push(resource);
            if (isFsWalkedEncounter(resource)) {
                (this.walkedFiles as (FsFileResource & FsWalkedEncounter)[])
                    .push(resource);
                if (isSrcCodeLangSpecSupplier(resource)) {
                    (this.walkedSrcFiles as (
                        & FsFileResource
                        & FsWalkedEncounter
                        & SrcCodeLangSpecSupplier
                    )[]).push(resource);
                }
            }
        }
    }
}

/**
 * How to detect executables:
 * - "auto": infer from pathDelim ("\\" => windows, otherwise posix)
 * - "posix": use fs mode x-bits (stat)
 * - "windows": extension in PATHEXT (or a reasonable default set)
 * - "none": skip detection (everything considered non-exec)
 * Default: "auto"
 */
export function executables(
    executableDetection: "posix" | "windows" | "none" = "posix",
) {
    // cache executability by absolute path to avoid repeat stat/env work
    const execCache = new Map<string, boolean>();

    const execute = async (
        path: string,
        init?:
            & {
                args?: string[];
                cwd?: string;
                env?: Record<string, string>;
                onError?: (error: unknown) => unknown | Promise<unknown>;
            }
            & (
                | {
                    materialize: (
                        stdout: Uint8Array,
                        stderr: Uint8Array,
                    ) => unknown | Promise<unknown>;
                }
                | {
                    materializeText: (
                        stdout: string,
                        stderr: string,
                    ) => unknown | Promise<unknown>;
                }
                | {
                    ignoreOutput: true;
                }
            ),
    ) => {
        try {
            const cmd = new Deno.Command(path, {
                args: init?.args ?? [],
                cwd: init?.cwd,
                env: init?.env,
                stdout: "piped",
                stderr: "piped",
            });

            const out = await cmd.output();

            if (!out.success) {
                const err = new Error(`Execution failed (${out.code}).`, {
                    cause: out,
                });
                if (init?.onError) await init?.onError(err);
                return out;
            }

            if (init && "materialize" in init) {
                await init.materialize(out.stdout, out.stderr);
            } else if (init && "materializeText" in init) {
                const dec = new TextDecoder();
                await init?.materializeText(
                    dec.decode(out.stdout),
                    dec.decode(out.stderr),
                );
            }

            return out;
        } catch (error) {
            if (init?.onError) await init.onError(error);
            throw error;
        }
    };

    const isExecutable = async (
        path: string,
        normalizedExt = extname(path),
    ) => {
        // use cache first
        const cached = execCache.get(path);
        if (cached !== undefined) return cached;

        let result = false;

        if (executableDetection === "windows") {
            // Use PATHEXT if available; otherwise a sane default set
            const pathext = (Deno.env.get?.("PATHEXT") ??
                ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.PS1;.PSM1")
                .split(";")
                .map((s) => s.trim().toLowerCase())
                .filter(Boolean);

            result = pathext.includes(normalizedExt.toLowerCase());
        } else if (executableDetection === "posix") {
            try {
                const st = await Deno.stat(path);
                // If it's not a file, treat as non-exec for our purposes
                if (st.isFile && typeof st.mode === "number") {
                    // any x bit (owner/group/other)
                    result = (st.mode & 0o111) !== 0;
                }
            } catch {
                // stat failures => not executable
                result = false;
            }
        } else {
            // "none" => no detection
            result = false;
        }

        execCache.set(path, result);
        return result;
    };

    const materialize = async (
        args: {
            absFsPath: string;
            matAbsFsPath: false | string;
            dryRun?: boolean;
            cwd?: string;
            env?: Record<string, string>;
        },
        onError: (error: unknown) => unknown | Promise<unknown>,
    ) => {
        const { absFsPath, matAbsFsPath, dryRun = false, cwd, env } = args;
        if (dryRun || !await isExecutable(absFsPath)) return;
        if (matAbsFsPath) {
            execute(absFsPath, {
                cwd,
                env,
                onError,
                materialize: async (stdout, _stderr) => {
                    // TODO: figure out what to do with stderr
                    await Deno.writeFile(matAbsFsPath, stdout);
                },
            });
        } else {
            execute(absFsPath, { cwd, env, ignoreOutput: true, onError });
        }
    };

    const cleanMaterialized = async (
        args: {
            absFsPath: string;
            matAbsFsPath: false | string;
            dryRun?: boolean;
        },
        onError: (error: unknown) => unknown | Promise<unknown>,
    ) => {
        const { absFsPath, matAbsFsPath, dryRun = false } = args;
        if (dryRun || !await isExecutable(absFsPath)) return;
        if (matAbsFsPath) {
            try {
                // if ce.pfn.materialize.auto is true then .path! must be set
                await Deno.remove(matAbsFsPath);
            } catch (error) {
                await onError(error);
            }
        }

        // TODO:
        // else {
        //     const { we } = ce;
        //     await Foundries.execute(we.entry.path, {
        //         env: this.env("DESTROY_CLEAN", ce),
        //         cwd: Deno.cwd(),
        //         ignoreOutput: true,
        //     });
        // }
    };

    return { execCache, isExecutable, execute, materialize, cleanMaterialized };
}
