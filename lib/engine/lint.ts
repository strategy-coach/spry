import { defineRegistry, defineRule, LintResults } from "../universal/lint.ts";

export class Linter {
    lintRegistry() {
        return defineRegistry(
            {
                "invalid-annotation": defineRule({
                    code: ["region", "entry", "route"] as const,
                    data: { annotation: {} },
                    defaultSeverity: "error",
                }),
                "invalid-cap-exec": defineRule({
                    code: [
                        "not-executable",
                        "invalid-file-name-pattern",
                        "unable-to-materialize",
                    ] as const,
                    data: {
                        annotation: {},
                        error: {} as
                            | string
                            | Error
                            | unknown
                            | undefined
                            | null,
                    },
                    defaultSeverity: "warn",
                }),
            } as const,
        );
    }

    lintResults() {
        return new LintResults({
            registry: this.lintRegistry(),
            contentMetaFor: (
                id,
            ) => (id.endsWith(".sql") ? { lang: "sql" } : {}),
            runMeta: { tool: "spry" },
        });
    }
}
