import { assert, assertArrayIncludes, assertEquals } from "jsr:@std/assert@1";
import { defineRegistry, defineRule, LintResults, where } from "./lint.ts";

// ----- Typed registry used across tests -----
const registry = defineRegistry(
    {
        "no-console": defineRule({
            code: ["disallow", "restricted"] as const,
            data: { allowed: [] as string[] },
            defaultSeverity: "warn",
        }),
        "eqeqeq": defineRule({
            code: "expected-strict-eq",
            data: {
                actual: "==" as "==" | "!=",
                expected: "===" as "===" | "!==",
            },
        }),
        "no-dead-code": defineRule({
            code: ["unreachable", "unused-var"] as const,
        }),
    } as const,
);

type Reg = typeof registry;

Deno.test("LintResults - end-to-end", async (t) => {
    const results = new LintResults<
        Reg,
        "security" | "style",
        { lang?: string },
        { tool: string; sha?: string },
        { owner?: string }
    >({
        registry,
        contentMetaFor: (id) => (id.endsWith(".ts") ? { lang: "ts" } : {}),
        runMeta: { tool: "my-linter@1.0.0", sha: "abc123" },
    });

    await t.step(
        "addForRule() - typed insert, deterministic ID, indexes update",
        () => {
            results.addForRule("eqeqeq", {
                code: "expected-strict-eq",
                data: { actual: "==", expected: "===" },
                severity: "error",
                content: "src/a.ts",
                message: "Use === instead of ==",
                payload: { owner: "team-web" },
                range: { start: 10, end: 12 },
                tags: ["style"],
            });

            const all = results.allFindings();
            assertEquals(all.length, 1);
            assertEquals(all[0].rule, "eqeqeq");
            assertEquals(all[0].severity, "error");
            assertEquals(all[0].contentRef?.meta?.lang, "ts");
            assert(all[0].id.length >= 8); // looks like a hash
        },
    );

    await t.step("forRule() - narrowed read by rule id", () => {
        const eq = results.forRule("eqeqeq");
        assertEquals(eq.length, 1);
        // runtime checks
        assertEquals(eq[0].data?.actual, "==");
        assertEquals(eq[0].payload?.owner, "team-web");
    });

    await t.step("add() multiple - mixed rules and contents", () => {
        results.add([
            {
                rule: "no-console",
                code: "restricted",
                severity: "warn",
                content: "src/log.ts",
                message: "console is restricted here",
                payload: { owner: "platform" },
            },
            {
                rule: "no-dead-code",
                code: "unreachable",
                severity: "info",
                content: "src/a.ts",
                message: "Unreachable code detected",
            },
        ]);

        assertEquals(results.allFindings().length, 3);
        assertEquals(results.forContent("src/a.ts").length, 2);
        assertEquals(results.forRule("no-console").length, 1);
        assertEquals(results.bySeverityLevel("warn").length, 1);
    });

    await t.step("ignores severity 'off'", () => {
        const before = results.allFindings().length;
        results.add({
            rule: "no-console",
            code: "disallow",
            severity: "off",
            content: "src/a.ts",
            message: "should be ignored",
        });
        assertEquals(results.allFindings().length, before);
    });

    await t.step("counts() - totals by severity, rule, content", () => {
        const c = results.counts();
        assertEquals(c.total, 3);
        assertEquals(c.bySeverity.error, 1);
        assertEquals(c.bySeverity.warn, 1);
        assertEquals(c.bySeverity.info, 1);
        assertArrayIncludes(Object.keys(c.byRule), [
            "eqeqeq",
            "no-console",
            "no-dead-code",
        ]);
        assertArrayIncludes(Object.keys(c.byContent), [
            "src/a.ts",
            "src/log.ts",
        ]);
    });

    await t.step("where DSL - filter by rule + severity", () => {
        const filtered = results.query(
            where.and(
                where.rule("eqeqeq"),
                where.severity("error"),
            ),
        );
        assertEquals(filtered.length, 1);
        assertEquals(filtered[0].rule, "eqeqeq");
    });

    await t.step("lazy sort by range - stable ordering within content", () => {
        // Insert more findings out of order for the same content
        results.add([
            {
                rule: "no-dead-code",
                code: "unused-var",
                severity: "hint",
                content: "src/a.ts",
                message: "Unused variable x",
                range: { start: 1, end: 2 },
            },
            {
                rule: "no-dead-code",
                code: "unused-var",
                severity: "hint",
                content: "src/a.ts",
                message: "Unused variable y",
                range: { start: 100, end: 101 },
            },
        ]);
        const ordered = results.forContent("src/a.ts"); // triggers lazy sort
        assert(ordered[0].range && ordered[1].range && ordered[2].range);
        assert(ordered[0].range!.start <= ordered[1].range!.start);
        assert(ordered[1].range!.start <= ordered[2].range!.start);
    });

    await t.step("first() with predicate and without", () => {
        const firstTwo = results.first(2);
        assertEquals(firstTwo.length, 2);

        const onlyWarn = results.first(10, where.severity("warn"));
        assertEquals(onlyWarn.length, 1);
        assertEquals(onlyWarn[0].rule, "no-console");
    });

    await t.step("rulesSeen() & contents()", () => {
        const seen = results.rulesSeen();
        const contents = results.contents();
        assertArrayIncludes(seen, ["no-dead-code", "no-console", "eqeqeq"]);
        assertArrayIncludes(contents, ["src/a.ts", "src/log.ts"]);
    });

    await t.step("toJSON() / fromJSON() - roundtrip preserves data", () => {
        const json = results.toJSON();
        assertEquals(json.$schema, "lint-results/v1");
        const hydrated = LintResults.fromJSON<Reg>(registry, json);
        assertEquals(
            hydrated.allFindings().length,
            results.allFindings().length,
        );
        assertEquals(hydrated.counts(), results.counts());
    });
});

Deno.test("LintResults - de-duplication and merge behavior", async (t) => {
    // Create two shards capturing similar/identical findings
    const left = new LintResults<Reg>({ registry, runMeta: { tool: "left" } });
    const right = new LintResults<Reg>({
        registry,
        runMeta: { tool: "right" },
    });

    await t.step("seed shards with overlapping findings", () => {
        left.addForRule("no-console", {
            code: "disallow",
            severity: "warn",
            content: "src/x.ts",
            message: "console disallowed",
            range: { start: 5, end: 6 },
        });

        // Exactly the same finding → identical deterministic id
        right.addForRule("no-console", {
            code: "disallow",
            severity: "warn",
            content: "src/x.ts",
            message: "console disallowed",
            range: { start: 5, end: 6 },
        });

        // Slightly different (message) → different id
        right.addForRule("no-console", {
            code: "disallow",
            severity: "warn",
            content: "src/x.ts",
            message: "console disallowed elsewhere",
            range: { start: 5, end: 6 },
        });

        assertEquals(left.allFindings().length, 1);
        assertEquals(right.allFindings().length, 2);
    });

    await t.step("merge - duplicates collapse by id, distinct remain", () => {
        const merged = new LintResults<Reg>({ registry });
        merged.merge(left).merge(right);

        const all = merged.allFindings();
        assertEquals(all.length, 2); // 1 duplicate collapsed → total should be 2

        const counts = merged.counts();
        assertEquals(counts.byContent["src/x.ts"], 2);
        assertEquals(counts.byRule["no-console"], 2);
    });

    await t.step(
        "id stability - identical inputs produce identical ids",
        () => {
            const a = new LintResults<Reg>({ registry });
            const b = new LintResults<Reg>({ registry });

            a.addForRule("eqeqeq", {
                code: "expected-strict-eq",
                severity: "error",
                content: "src/y.ts",
                message: "Use === instead of ==",
                range: { start: 1, end: 2 },
                data: { actual: "==", expected: "===" },
            });

            b.addForRule("eqeqeq", {
                code: "expected-strict-eq",
                severity: "error",
                content: "src/y.ts",
                message: "Use === instead of ==",
                range: { start: 1, end: 2 },
                data: { actual: "==", expected: "===" },
            });

            assertEquals(a.allFindings()[0].id, b.allFindings()[0].id);
        },
    );
});
