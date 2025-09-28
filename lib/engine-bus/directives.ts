import { Command } from "jsr:@cliffy/command@1.0.0-rc.8";
import {
    type CandidateDefn,
    Emitter,
    IsCandidate,
    lineCommentDirectiveParser,
    ReplaceStream,
    ReplaceStreamEvents,
    textToShellArgv,
} from "../universal/directive.ts";
import {
    SrcCodeLangSpecSupplier,
    TextProducer,
    TextSupplier,
} from "./resource.ts";

export type IncludeDirective<Payload> = CandidateDefn<Payload> & {
    blockName: string;
    file: string;
    srcLineNo: number;
};

export function includeDirective<Payload>() {
    const command = new Command()
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

    const directive = (
        init: {
            readonly lcdParser: (payload: Payload) => ReturnType<
                typeof lineCommentDirectiveParser
            >;
            readonly onRender: (
                payload: Payload,
                directive: IncludeDirective<Payload>,
            ) => string | Promise<string>;
            readonly onError: (
                payload: Payload,
                err: unknown,
                cmd: typeof command,
                curLineNo: number,
            ) => void | Promise<void>;
        },
    ) => {
        /** Detect `-- #include <name> ...` and pair with `-- #includeEnd <name>`. */
        const handler: IsCandidate<IncludeDirective<Payload>, Payload> = async (
            line,
            curLineNo,
            payload,
        ) => {
            const lcdParser = init.lcdParser(payload);
            const parsed = lcdParser(line);
            if (!parsed) return false;

            const [token, argsText] = parsed;
            let incDirec: IncludeDirective<Payload> | null = null;
            if (token == "include") {
                try {
                    await command.action(({ file }, blockName) => {
                        incDirec = {
                            directive: "include",
                            argsText,
                            blockName,
                            file,
                            srcLineNo: curLineNo,
                            render: async (payload: Payload) =>
                                await init.onRender(payload, incDirec!),
                            blockEnd: (probe: string) => {
                                const parsedEnd = lcdParser(probe);
                                if (!parsedEnd) return false;
                                const [endToken, endRemains] = parsedEnd;
                                const matches = endToken == "includeEnd" &&
                                    endRemains == blockName;
                                return matches;
                            },
                        }; // TODO: why cast required?
                    }).noExit().parse(textToShellArgv(argsText));
                    return incDirec!;
                } catch (err) {
                    await init.onError(payload, err, command, curLineNo);
                }
            }
            return false;
        };
        return handler;
    };
    return { directive, command };
}

export function directives(
    srcFiles: Iterable<
        & TextSupplier
        & SrcCodeLangSpecSupplier
        & { absFsPath: string }
        & TextProducer
    >,
) {
    type ElementOfIterable<I> = I extends Iterable<infer T> ? T : never;
    type SourceFile = {
        resource: ElementOfIterable<typeof srcFiles>;
        contentState: "unmodified" | "modified";
    };

    const incDirective = includeDirective<SourceFile>();

    const lcdParsers = new Map<
        string,
        ReturnType<typeof lineCommentDirectiveParser>
    >();
    const lcdDefaultParser = lineCommentDirectiveParser({
        comment: "--", // e.g. -- #include
        directivePrefix: "#", // e.g. #include
    });

    const replacer = new ReplaceStream(incDirective.directive({
        lcdParser: (payload) => {
            const { srcCodeLanguage: langSpec } = payload.resource;
            let lcdParser = lcdParsers.get(langSpec.id);
            if (lcdParser) return lcdParser;
            if (langSpec.comment.line.length == 0) {
                console.warn(
                    langSpec,
                    "has no line comments, using SQL defaults in",
                    payload.resource.absFsPath,
                );
                return lcdDefaultParser;
            }
            if (langSpec.comment.line.length > 1) {
                console.warn(
                    langSpec,
                    "has multiple line comment styles, using first of",
                    langSpec.comment.line.join(", "),
                    payload.resource.absFsPath,
                );
            }
            lcdParser = lineCommentDirectiveParser({
                comment: langSpec.comment.line[0], // e.g. -- #include
                directivePrefix: "#", // e.g. #include
            });
            lcdParsers.set(langSpec.id, lcdParser);
            return lcdDefaultParser;
        },
        onRender: (payload, directive) => {
            return `-- replace ${payload.resource.absFsPath} with ${directive.file}`;
        },
        onError: (payload, _err, _, curLineNo) => {
            console.error(
                `Include materialization error in ${payload.resource.absFsPath} on line ${curLineNo}`,
            );
        },
    }));

    const dryRun = async () => {
        const modified: {
            resource: SourceFile["resource"];
            directive: IncludeDirective<SourceFile>;
            beginLineNo: number;
            endLineNo: number;
        }[] = [];

        const emitter = new Emitter<
            ReplaceStreamEvents<IncludeDirective<SourceFile>, SourceFile>
        >();
        emitter.on(
            "blockRender",
            (i) =>
                modified.push({
                    resource: i.payload.resource,
                    directive: i.directive,
                    beginLineNo: i.beginLineNo,
                    endLineNo: i.endLineNo,
                }),
        );
        // TODO: emitter.on("error", () => events.push("error"));

        for await (const resource of srcFiles) {
            const original = await resource.text();
            await replacer.processToString(original, {
                resource,
                contentState: "unmodified",
            }, { events: emitter });
        }

        return modified;
    };

    const materialize = async () => {
        for await (const resource of srcFiles) {
            const original = await resource.text();
            const result = await replacer.processToString(original, {
                resource,
                contentState: "unmodified",
            });
            if (result.changed && result.after != result.before) {
                await resource.writeText(result.after);
                console.info("Materialized", resource.absFsPath);
            }
        }
    };

    return { dryRun, materialize };
}
