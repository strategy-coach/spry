import { brightRed, dim } from "jsr:@std/fmt@1/colors";
import {
    basename,
    dirname,
    extname,
    isAbsolute,
    resolve,
} from "jsr:@std/path@1";
import z from "jsr:@zod/zod@4";
import {
    extractAnnotationsFromText,
} from "../universal/content/code-comments.ts";
import { detectLanguageByPath } from "../universal/content/code.ts";
import { Annotations } from "./annotations.ts";
import { SafeCliArgs } from "./cli.ts";
import { Linter } from "./lint.ts";
import { Plan, Workflow } from "./orchestrate.ts";
import {
    EncountersSupplier,
    WalkEncounter,
    Walkers,
    WalkSpec,
} from "./walk.ts";
import { SpryResourceAnnotation } from "./anno/mod.ts";

export type SpryFoundryAnnotation = Extract<
    SpryResourceAnnotation,
    { nature: "foundry" }
>;

export class Foundries {
    readonly candidates: EncountersSupplier;
    readonly contextForEnv: Record<string, unknown>;
    readonly ceSelected: {
        we: WalkEncounter<WalkSpec>;
        ann: SpryFoundryAnnotation;
        pfn: ReturnType<Foundries["parseFileName"]>;
    }[] = [];
    readonly ceMaterialized: {
        workflowStep: Workflow["workflowStep"];
        we: WalkEncounter<WalkSpec>;
        ann: SpryFoundryAnnotation;
    }[] = [];

    constructor(
        readonly plan: Plan,
        readonly lintr: ReturnType<Linter["lintResults"]>,
        readonly init?: {
            readonly cliOpts?: SafeCliArgs;
            readonly mergeCtx?: Record<string, unknown>; // overrides merged into schema defaults
        },
    ) {
        // any executable files in our path(s) can be foundry candidates
        // TODO: restrict it a bit more, though?
        this.candidates = Walkers.builder()
            .addRoot(plan.pp.projectFsPaths, {
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

    env(step: Workflow["workflowStep"], ce: Foundries["ceSelected"][number]) {
        let ceEnv: Record<string, string> = {
            FOUNDRY_PROJECT_HOME: this.plan.pp.projectFsPaths.root,
            FOUNDRY_PROJECT_ID: this.plan.pp.projectFsPaths.identity ?? "",
            FOUNDRY_PROJECT_SRC_HOME: this.plan.pp.projectSrcFsPaths.root,
            FOUNDRY_PROJECT_SPRYD_HOME: this.plan.pp.spryDropIn.fsHome,
            FOUNDRY_PROJECT_SPRYD_AUTO: this.plan.pp.spryDropIn.fsAuto,
            FOUNDRY_SOURCE_JSON: JSON.stringify(ce),
            FOUNDRY_AUTO_MATERIALIZE: ce.pfn.materialize.auto
                ? "TRUE"
                : "FALSE",
            FOUNDRY_MATERIALIZE_BASENAME: ce.pfn.materialize.auto
                ? ce.pfn.materialize.basename ?? ""
                : "",
            FOUNDRY_MATERIALIZE_PATH: ce.pfn.materialize.auto
                ? ce.pfn.materialize.path ?? ""
                : "",
            FOUNDRY_WORKFLOW_STEP: step ?? "unknown",
            FOUNDRY_CONTEXT_JSON: JSON.stringify(this.contextForEnv),
        };
        if (step === "DESTROY_CLEAN") {
            ceEnv.FOUNDRY_WORKFLOW_STEP = "TRUE";
        }
        if (this.init?.cliOpts?.dbName) {
            const dbName = this.init.cliOpts.dbName;
            ceEnv = {
                ...ceEnv,
                FOUNDRY_TARGET_SQLITEDB: isAbsolute(dbName)
                    ? dbName
                    : resolve(Deno.cwd(), dbName),
            };
        }
        return ceEnv;
    }

    static async execute(
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
                | {
                    ignoreOutput: true;
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

    async cleanMaterialized(ce: Foundries["ceSelected"][number]) {
        if (ce.ann.isCleanable && ce.pfn.materialize.auto) {
            try {
                // if ce.pfn.materialize.auto is true then .path! must be set
                await Deno.remove(ce.pfn.materialize.path!);
            } catch (error) {
                console.info(
                    "Error cleaning isCleanable auto-materialized foundry",
                    ce.we.entry.path,
                );
                console.info(ce.pfn.materialize.path!);
                console.error(error);
            }
        }

        if (ce.ann.isCleanable && !ce.pfn.materialize.auto) {
            const { we } = ce;
            await Foundries.execute(we.entry.path, {
                env: this.env("DESTROY_CLEAN", ce),
                cwd: Deno.cwd(),
                ignoreOutput: true,
            });
        }
    }

    parseFileName(supplied: string) {
        const fileName = basename(supplied);
        let extn = extname(fileName);

        const parts = fileName.split(".");
        if (parts.length < 2) {
            return { materialize: { auto: false }, fileName, extn };
        }

        extn = parts.at(-1)!; // final extension
        const nature = parts.length > 2 ? parts.at(-2)! : ""; // second-to-last extension
        const base = parts.slice(0, -2).join(".") || parts[0]; // everything before .nature.ext
        const autoMaterialize = `${base}.auto.${nature}`;
        return {
            materialize: {
                auto: true,
                basename: `${base}.auto.${nature}`,
                path: resolve(dirname(supplied), autoMaterialize),
            },
            fileName,
            base,
            nature,
            extn,
        };
    }

    async catalog() {
        for await (const cec of this.candidates.encountered()) {
            if (Foundries.isExecutable(cec.entry.path)) {
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
                    const resourceAnn = await Annotations
                        .resourceAnnFromCatalog(
                            cec,
                            anns,
                            this.plan.pp.webPaths,
                        );
                    if (
                        resourceAnn.parsed &&
                        resourceAnn.parsed.nature === "foundry"
                    ) {
                        this.ceSelected.push({
                            we: cec,
                            ann: resourceAnn.parsed,
                            pfn: this.parseFileName(cec.entry.path),
                        });
                    }
                    if (resourceAnn.error) {
                        console.info(dim(cec.origin.paths.relative(cec.entry)));
                        console.error(
                            brightRed(z.prettifyError(resourceAnn.error)),
                        );
                    }
                } catch (err) {
                    console.error(cec.origin.paths.relative(cec.entry), err);
                }
            }
        }
    }

    async materialize(step: Workflow["workflowStep"]) {
        const execute = async (
            ce: {
                we: WalkEncounter<WalkSpec>;
                ann: SpryFoundryAnnotation;
                pfn: ReturnType<Foundries["parseFileName"]>;
            },
        ) => {
            const { we, ann, pfn } = ce;
            await Foundries.execute(we.entry.path, {
                env: this.env(step, ce),
                cwd: Deno.cwd(),
                materializeText: async (stdout, _stderr) => {
                    if (pfn.materialize.auto) {
                        try {
                            // if auto materializing, then .path must be defined
                            await Deno.writeTextFile(
                                pfn.materialize.path!,
                                stdout,
                            );
                            this.ceMaterialized.push({
                                workflowStep: step,
                                we,
                                ann,
                            });
                        } catch (error) {
                            this.lintr.add({
                                rule: "invalid-foundry",
                                code: "unable-to-materialize",
                                content: we.origin.paths.relative(we.entry),
                                message:
                                    `Capturable executable materialization failed: ${
                                        JSON.stringify(pfn)
                                    }`,
                                data: { annotation: ann, error },
                                severity: "error",
                            });
                        }
                    } else {
                        this.lintr.add({
                            rule: "invalid-foundry",
                            code: "invalid-file-name-pattern",
                            content: we.origin.paths.relative(we.entry),
                            message:
                                `Capturable executable filename pattern is not abc.<nature>.<exec>: ${pfn.fileName}`,
                            data: { annotation: ann, error: null },
                            severity: "error",
                        });
                    }
                },
            });
        };

        switch (step) {
            case "BEFORE_ANN_CATALOG":
                for await (
                    const ce of this.ceSelected.filter((ce) =>
                        ce.ann.runBeforeAnnCatalog
                    )
                ) {
                    await execute(ce);
                }
                break;
            case "AFTER_ANN_CATALOG":
                for await (
                    const ce of this.ceSelected.filter((ce) =>
                        ce.ann.runAfterAnnCatalog
                    )
                ) {
                    await execute(ce);
                }
                break;
        }
    }
}
