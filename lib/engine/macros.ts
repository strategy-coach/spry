import { Command } from "jsr:@cliffy/command@1.0.0-rc.8";
import {
    type CandidateDefn,
    IsCandidate,
    lineCommentDirectiveParser,
    ReplaceStream,
    textToShellArgv,
} from "../universal/macro.ts";
import {
    EncountersSupplier,
    WalkEncounter,
    Walkers,
    WalkSpec,
} from "./walk.ts";
import { Plan } from "./orchestrate.ts";
import { Linter } from "./lint.ts";

export class Macros {
    readonly replaceables: EncountersSupplier;
    readonly sqlIncludeParser = lineCommentDirectiveParser({
        comment: "--", // e.g. -- #include
        directivePrefix: "#", // e.g. #include
    });
    readonly sqlIncludeDirective = new Command()
        .name("#include")
        .description(
            "include one or more files into the source (in-place replacement)",
        )
        .arguments("<block-name:string>")
        .option("-f, --file <path:string>", "include file", {
            collect: true,
            required: true,
        });

    constructor(readonly plan: Plan) {
        this.replaceables = Walkers.builder()
            .addRoot(plan.pp.projectSrcFsPaths, {
                exts: [".sql"],
                includeDirs: false,
                includeFiles: true,
                includeSymlinks: false,
                followSymlinks: true, // important for "src/spry"
                canonicalize: true, // important for "src/spry"
            })
            .build();
    }

    async *sources() {
        yield* this.replaceables.encountered();
    }

    async render(lintr: ReturnType<Linter["lintResults"]>) {
        type IncludeDirective = CandidateDefn<IncludePayload> & {
            blockName: string;
            files: string[];
            srcLineNo: number;
        };
        type IncludePayload = { walkEntry: WalkEncounter<WalkSpec> };

        // const events = new Emitter<ReplaceStreamEvents>();
        // events.on("candidate", (c) => console.log({ c }));
        // events.on("blockStart", (b) => seen.push(`start:${b.identity}`));
        // events.on("blockEnd", (b) => seen.push(`end:${b.identity}`));
        // events.on("error", (_e, ctx) => seen.push(`error:${ctx.phase}`));

        /** Detect `-- #include <name> ...` and pair with `-- #includeEnd <name>`. */
        const isCandidate: IsCandidate<IncludeDirective, IncludePayload> =
            async (line, curLineNo, payload) => {
                const parsed = this.sqlIncludeParser(line);
                if (!parsed) return false;

                const [token, argsText] = parsed;
                let incDirec: IncludeDirective | null = null;
                if (token == "include") {
                    try {
                        await this.sqlIncludeDirective
                            .action(({ file }, blockName) => {
                                incDirec = {
                                    directive: "include",
                                    argsText,
                                    blockName,
                                    files: file,
                                    srcLineNo: curLineNo,
                                    render: (payload, curLineNo) => {
                                        return "test";
                                    },
                                    blockEnd: (probe) => {
                                        const parsedEnd = this.sqlIncludeParser(
                                            probe,
                                        );
                                        if (!parsedEnd) return false;
                                        const [endToken, endRemains] =
                                            parsedEnd;
                                        return endToken == "includeEnd" &&
                                            endRemains == blockName;
                                    },
                                };
                            })
                            .noExit()
                            .parse(textToShellArgv(argsText));
                        return incDirec!;
                    } catch (err) {
                        lintr.add({
                            rule: "invalid-directive",
                            code: "include",
                            content: payload.walkEntry.entry.path,
                            message: `${String(err)} (line ${curLineNo})`,
                            severity: "error",
                            data: {
                                elaboration: this.sqlIncludeDirective.getHelp(),
                            },
                        });
                    }
                }

                return false;
            };

        const engine = new ReplaceStream<IncludeDirective, IncludePayload>(
            isCandidate,
        );

        for await (const we of this.sources()) {
            const original = await Deno.readTextFile(we.entry.path);
            const out = await engine.processToString(original, {
                walkEntry: we,
            });
            if (out.changed) {
                console.log(out);
            }
        }
    }
}
