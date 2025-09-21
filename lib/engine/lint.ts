import { defineRegistry, defineRule, LintResults } from "../universal/lint.ts";

export class Linter {
    lintRegistry() {
        return defineRegistry(
            {
                "invalid-annotation": defineRule({
                    code: ["entry", "route"] as const,
                    data: { annotation: {} },
                    defaultSeverity: "error",
                }),
                "invalid-cap-exec": defineRule({
                    code: [
                        "not-executable",
                        "invalid-file-name-pattern",
                    ] as const,
                    data: { annotation: {} },
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
