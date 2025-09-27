import { Command } from "jsr:@cliffy/command@1.0.0-rc.8";
import {
    type CandidateDefn,
    IsCandidate,
    lineCommentDirectiveParser,
    textToShellArgv,
} from "../universal/directive.ts";

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
