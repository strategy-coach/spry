import {
    basename,
    dirname,
    extname,
    isAbsolute,
    resolve,
} from "jsr:@std/path@1";
import {
    extractAnnotationsFromText,
} from "../universal/content/code-comments.ts";
import { detectLanguageByPath } from "../universal/content/code.ts";
import { Annotations, SpryEntryAnnotation } from "./annotations.ts";
import { SafeCliArgs } from "./cli.ts";
import { Linter } from "./lint.ts";
import { FsPathSupplier } from "./paths.ts";
import {
    EncountersSupplier,
    WalkEncounter,
    Walkers,
    WalkSpec,
} from "./walk.ts";

export type SpryCapExecEntryAnnotation = Extract<
    SpryEntryAnnotation,
    { nature: "cap-exec" }
>;

export class CapExecs {
    readonly candidates: EncountersSupplier;
    readonly contextForEnv: Record<string, unknown>;
    readonly ceSelected: {
        we: WalkEncounter<WalkSpec>;
        ann: SpryCapExecEntryAnnotation;
    }[] = [];
    readonly ceMaterialized: {
        phase: SpryCapExecEntryAnnotation["materialize"];
        we: WalkEncounter<WalkSpec>;
        ann: SpryCapExecEntryAnnotation;
    }[] = [];

    constructor(
        readonly projectModule: FsPathSupplier,
        readonly lintr: ReturnType<Linter["lintResults"]>,
        readonly init?: {
            readonly cliOpts?: SafeCliArgs;
            readonly mergeCtx?: Record<string, unknown>; // overrides merged into schema defaults
        },
    ) {
        // any executable files in our path(s) can be capexec candidates
        // TODO: restrict it a bit more, though?
        this.candidates = Walkers.builder()
            .addRoot(projectModule, {
                includeDirs: false,
                includeFiles: true,
                includeSymlinks: false,
                followSymlinks: true, // important for "src/spry"
                canonicalize: true, // important for "src/spry"
            })
            .build();
        this.contextForEnv = {
            cliOpts: init?.cliOpts ?? JSON.stringify(init?.cliOpts),
            ...init?.mergeCtx,
        };
    }

    env() {
        let ceEnv: Record<string, string> = {
            CAPEXEC_CONTEXT_JSON: JSON.stringify(this.contextForEnv),
        };
        if (this.init?.cliOpts?.dbName) {
            const dbName = this.init.cliOpts.dbName;
            ceEnv = {
                ...ceEnv,
                CAPEXEC_TARGET_SQLITEDB: isAbsolute(dbName)
                    ? dbName
                    : resolve(Deno.cwd(), dbName),
            };
        }
        return ceEnv;
    }

    static async captureExecutable(
        path: string,
        init?:
            & {
                args?: string[];
                cwd?: string;
                env?: Record<string, string>;
                stdin?:
                    | "inherit"
                    | "null"
                    | Uint8Array
                    | ReadableStream<Uint8Array>
                    | "piped";
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
            ),
    ) {
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
            } else {
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
    }

    static isExecutable(path: string) {
        try {
            // lstat first so we know if it's a symlink
            const lst = Deno.lstatSync(path);
            if (lst.isSymlink) {
                try {
                    // resolve symlink to its real target for accurate checks
                    path = Deno.realPathSync(path);
                } catch {
                    return false; // dangling / inaccessible target
                }
            }

            const info = Deno.statSync(path);
            if (!info.isFile) return false;

            const mode = info.mode ?? 0;
            // POSIX: any of user/group/other execute bits
            if (mode) return (mode & 0o111) !== 0;

            // Windows / filesystems without mode: check the TARGET's extension
            const lower = path.toLowerCase();
            return [".exe", ".cmd", ".bat", ".com", ".ps1"].some((ext) =>
                lower.endsWith(ext)
            );
        } catch {
            return false;
        }
    }

    async catalog() {
        for await (const cec of this.candidates.encountered()) {
            if (CapExecs.isExecutable(cec.entry.path)) {
                try {
                    const anns = await extractAnnotationsFromText(
                        await Deno.readTextFile(cec.entry.path),
                        detectLanguageByPath(cec.entry.path)!, // TODO: give sane default
                        {
                            tags: { multi: true, valueMode: "json" },
                            kv: false,
                            yaml: false,
                            json: false,
                        },
                    );
                    const entryAnn = await Annotations.entryAnnFromCatalog(
                        cec,
                        anns,
                    );
                    if (
                        entryAnn.parsed && entryAnn.parsed.nature === "cap-exec"
                    ) {
                        this.ceSelected.push({ we: cec, ann: entryAnn.parsed });
                    }
                } catch (err) {
                    console.error(cec.origin.paths.relative(cec.entry), err);
                }
            }
        }
    }

    parseFileName(supplied: string) {
        const fileName = basename(supplied);
        let extn = extname(fileName);

        const parts = fileName.split(".");
        if (parts.length < 2) return { valid: false, fileName, extn };

        extn = parts.at(-1)!; // final extension
        const nature = parts.length > 2 ? parts.at(-2)! : ""; // second-to-last extension
        const base = parts.slice(0, -2).join(".") || parts[0]; // everything before .nature.ext
        return { valid: true, fileName, base, nature, extn };
    }

    async materialize(phase: SpryCapExecEntryAnnotation["materialize"]) {
        const execute = async ({ we, ann }: {
            we: WalkEncounter<WalkSpec>;
            ann: SpryCapExecEntryAnnotation;
        }) => {
            await CapExecs.captureExecutable(we.entry.path, {
                env: this.env(),
                cwd: Deno.cwd(),
                materializeText: async (stdout, _stderr) => {
                    const pfn = this.parseFileName(we.entry.path);
                    if (pfn.valid) {
                        await Deno.writeTextFile(
                            resolve(
                                dirname(we.entry.path),
                                `${pfn.base}.auto.${pfn.nature}`,
                            ),
                            stdout,
                        );
                        this.ceMaterialized.push({ phase, we, ann });
                    } else {
                        this.lintr.add({
                            rule: "invalid-cap-exec",
                            code: "invalid-file-name-pattern",
                            content: we.origin.paths.relative(we.entry),
                            message:
                                `Capturable executable filename pattern is not abc.<nature>.<exec>: ${pfn.fileName}`,
                            data: { annotation: ann },
                            severity: "error",
                        });
                    }
                },
            });
        };

        switch (phase) {
            case "before-sqlpage-files":
                for await (
                    const ce of this.ceSelected.filter((ce) =>
                        ce.ann.materialize === "before-sqlpage-files" ||
                        ce.ann.materialize === "both"
                    )
                ) {
                    await execute(ce);
                }
                break;
            case "after-sqlpage-files":
                for await (
                    const ce of this.ceSelected.filter((ce) =>
                        ce.ann.materialize === "after-sqlpage-files" ||
                        ce.ann.materialize === "both"
                    )
                ) {
                    await execute(ce);
                }
                break;
        }
    }
}
