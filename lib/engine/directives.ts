import { Command } from "jsr:@cliffy/command@1.0.0-rc.8";
import { dirname, extname, resolve } from "jsr:@std/path@1";
import {
    type CandidateDefn,
    Emitter,
    IsCandidate,
    lineCommentDirectiveParser,
    ReplaceStream,
    ReplaceStreamEvents,
    textToShellArgv,
} from "../universal/directive.ts";
import { Linter } from "./lint.ts";
import { Plan } from "./orchestrate.ts";
import {
    EncountersSupplier,
    WalkEncounter,
    Walkers,
    WalkSpec,
} from "./walk.ts";

type DirectivePayload = {
    walkEntry: WalkEncounter<WalkSpec>;
    contentState: "unmodified" | "modified";
};

type IncludeDirective = CandidateDefn<DirectivePayload> & {
    blockName: string;
    file: string;
    srcLineNo: number;
};

export class Directives {
    readonly replaceables: EncountersSupplier;
    readonly directiveParsers = {
        ".sql": lineCommentDirectiveParser({
            comment: "--", // e.g. -- #include
            directivePrefix: "#", // e.g. #include
        }),
    };
    readonly sqlIncludeDirective = new Command()
        .name("#include")
        .description(
            "include one or more files into the source (in-place replacement)",
        )
        .arguments("<block-name:string>")
        .option(
            "-f, --file <path:string>",
            "include file (relative to source file)",
            {
                // collect: true, TODO: should we allow multiple?
                required: true,
            },
        );

    constructor(readonly plan: Plan) {
        this.replaceables = Walkers.builder()
            .addRoot(plan.pp.projectSrcFsPaths, {
                exts: Object.keys(this.directiveParsers),
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

    includeDirective(lintr?: ReturnType<Linter["lintResults"]>) {
        /** Detect `-- #include <name> ...` and pair with `-- #includeEnd <name>`. */
        const handler: IsCandidate<IncludeDirective, DirectivePayload> = async (
            line,
            curLineNo,
            payload,
        ) => {
            const nature = extname(payload.walkEntry.entry.path);
            if (!(nature in this.directiveParsers)) {
                if (lintr) {
                    lintr.add({
                        rule: "invalid-parser",
                        code: "directive",
                        content: payload.walkEntry.entry.path,
                        message:
                            `Unknown directive parser for '${nature}' (line ${curLineNo})`,
                        severity: "error",
                        data: { elaboration: {} },
                    });
                }
            }
            const directiveParser = this.directiveParsers[
                nature as keyof Directives["directiveParsers"]
            ];
            const parsed = directiveParser(line);
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
                                file,
                                srcLineNo: curLineNo,
                                render: (payload) => {
                                    try {
                                        return Deno.readTextFileSync(
                                            resolve(
                                                dirname(
                                                    payload.walkEntry.entry
                                                        .path,
                                                ),
                                                file,
                                            ),
                                        );
                                    } catch (err) {
                                        if (lintr) {
                                            lintr.add({
                                                rule: "invalid-directive",
                                                code: "include",
                                                content: payload.walkEntry.entry
                                                    .path,
                                                message:
                                                    `Error reading ${file} (at line ${curLineNo})`,
                                                severity: "error",
                                                data: {
                                                    elaboration: err &&
                                                            typeof err ===
                                                                "object"
                                                        ? err
                                                        : {},
                                                },
                                            });
                                        }
                                        return String(err);
                                    }
                                },
                                blockEnd: (probe) => {
                                    const parsedEnd = directiveParser(probe);
                                    if (!parsedEnd) return false;
                                    const [endToken, endRemains] = parsedEnd;
                                    const matches = endToken == "includeEnd" &&
                                        endRemains == blockName;
                                    return matches;
                                },
                            };
                        })
                        .noExit()
                        .parse(textToShellArgv(argsText));
                    return incDirec!;
                } catch (err) {
                    const message = `${String(err)} (line ${curLineNo})`;
                    if (lintr) {
                        lintr.add({
                            rule: "invalid-directive",
                            code: "include",
                            content: payload.walkEntry.entry.path,
                            message,
                            severity: "error",
                            data: {
                                elaboration: this.sqlIncludeDirective.getHelp(),
                            },
                        });
                    }
                }
            }

            return false;
        };

        return handler;
    }

    // list (and execute) directives but don't materialize
    async directives(lintr?: ReturnType<Linter["lintResults"]>) {
        const incDirHandler = this.includeDirective(lintr);
        const engine = new ReplaceStream(incDirHandler);

        const modified: {
            walkEntry: WalkEncounter<WalkSpec>;
            directive: IncludeDirective;
            beginLineNo: number;
            endLineNo: number;
        }[] = [];

        const emitter = new Emitter<
            ReplaceStreamEvents<IncludeDirective, DirectivePayload>
        >();
        emitter.on(
            "blockRender",
            (i) =>
                modified.push({
                    walkEntry: i.payload.walkEntry,
                    directive: i.directive,
                    beginLineNo: i.beginLineNo,
                    endLineNo: i.endLineNo,
                }),
        );
        // TODO: emitter.on("error", () => events.push("error"));

        for await (const we of this.sources()) {
            const original = await Deno.readTextFile(we.entry.path);
            const payload: DirectivePayload = {
                walkEntry: we,
                contentState: "unmodified",
            };
            await engine.processToString(original, payload, {
                events: emitter,
            });
        }

        return { modified };
    }

    async *materialize(lintr: ReturnType<Linter["lintResults"]>) {
        const incDirHandler = this.includeDirective(lintr);
        const engine = new ReplaceStream(incDirHandler);
        for await (const we of this.sources()) {
            const original = await Deno.readTextFile(we.entry.path);
            const payload: DirectivePayload = {
                walkEntry: we,
                contentState: "unmodified",
            };
            const result = await engine.processToString(original, payload);
            if (result.changed && result.after != result.before) {
                await Deno.writeTextFile(we.entry.path, result.after);
                yield { we, result };
            }
        }
    }
}
