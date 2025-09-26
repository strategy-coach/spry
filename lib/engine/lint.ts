import { defineRegistry, defineRule, LintResults } from "../universal/lint.ts";

export class Linter {
    lintRegistry() {
        return defineRegistry(
            {
                "invalid-annotation": defineRule({
                    code: ["resource", "route"] as const,
                    data: { annotation: {} },
                    defaultSeverity: "error",
                }),
                "invalid-foundry": defineRule({
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
                "invalid-directive": defineRule({
                    code: ["include"] as const,
                    data: { elaboration: {} },
                    defaultSeverity: "error",
                }),
                "invalid-parser": defineRule({
                    code: ["directive"] as const,
                    data: { elaboration: {} },
                    defaultSeverity: "error",
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
