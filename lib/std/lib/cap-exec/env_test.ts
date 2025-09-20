// env_test.ts
// Run: deno test --allow-env env_test.ts

import {
    assert,
    assertEquals,
    assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import { CapExecEnvAide, EnvAide } from "./env.ts";

// ---------- Test utilities ----------

function snapshotEnv(): Record<string, string> {
    return Deno.env.toObject();
}

function restoreEnv(snapshot: Record<string, string>) {
    // Clear current env
    for (const k of Object.keys(Deno.env.toObject())) {
        Deno.env.delete(k);
    }
    // Restore
    for (const [k, v] of Object.entries(snapshot)) {
        Deno.env.set(k, v);
    }
}

// ---------- Tests ----------

Deno.test("EnvAide & CapExecEnvAide (composition)", async (t) => {
    const snap = snapshotEnv();
    try {
        // Arrange a clean, controlled environment
        for (const k of Object.keys(Deno.env.toObject())) Deno.env.delete(k);

        Deno.env.set("PATH", "/usr/bin");
        Deno.env.set("HOME", "/home/test");
        Deno.env.set("OTHER_URL", "https://example.com");

        Deno.env.set("CAPEXEC_TARGET_SQLITE_DB", "/tmp/db.sqlite");
        Deno.env.set("CAPEXEC_DB_URL", "sqlite:///tmp/db.sqlite");
        Deno.env.set(
            "CAPEXEC_CONTEXT",
            JSON.stringify({ runId: "abc123", n: 2 }),
        );

        await t.step(
            "EnvAide: dynamic lookup maps camelCase → SNAKE_CASE",
            () => {
                const env = new EnvAide();
                // @ts-ignore dynamic trap
                assertEquals(env.path(), "/usr/bin"); // PATH
                // @ts-ignore dynamic trap
                assertEquals(env.otherUrl(), "https://example.com"); // OTHER_URL
            },
        );

        await t.step("EnvAide: get/require/has/keys/toObject", () => {
            const env = new EnvAide();
            assertEquals(env.get("HOME"), "/home/test");
            assert(env.has("PATH"));
            assertThrows(
                () => env.require("MISSING_VAR"),
                "Missing MISSING_VAR",
            );

            const keys = env.keys();
            assert(keys.includes("PATH"));
            assert(keys.includes("CAPEXEC_TARGET_SQLITE_DB"));

            const all = env.toObject();
            assertEquals(all.PATH, "/usr/bin");
            assertEquals(all.CAPEXEC_DB_URL, "sqlite:///tmp/db.sqlite");

            const onlyHome = env.toObject((k) => k === "HOME");
            assertEquals(Object.keys(onlyHome), ["HOME"]);
            assertEquals(onlyHome.HOME, "/home/test");
        });

        await t.step("CapExecEnvAide: dynamic lookup prefixes CAPEXEC_", () => {
            const cap = new CapExecEnvAide(new EnvAide());
            // @ts-ignore dynamic trap
            assertEquals(cap.targetSqliteDb(), "/tmp/db.sqlite"); // CAPEXEC_TARGET_SQLITE_DB
            // @ts-ignore dynamic trap (consecutive capitals)
            assertEquals(cap.dbURL(), "sqlite:///tmp/db.sqlite"); // CAPEXEC_DB_URL
        });

        await t.step("CapExecEnvAide: get/require/has/keys", () => {
            const cap = new CapExecEnvAide(new EnvAide());
            // De-prefixed
            assertEquals(cap.get("TARGET_SQLITE_DB"), "/tmp/db.sqlite");
            // Prefixed
            assertEquals(cap.get("CAPEXEC_DB_URL"), "sqlite:///tmp/db.sqlite");

            assert(cap.has("TARGET_SQLITE_DB"));
            assert(cap.has("CAPEXEC_DB_URL"));

            assertThrows(
                () => cap.require("MISSING"),
                "Missing CAPEXEC_MISSING",
            );

            const keys = cap.keys(); // de-prefixed
            assert(keys.includes("TARGET_SQLITE_DB"));
            assert(keys.includes("DB_URL"));
            assert(!keys.includes("CAPEXEC_TARGET_SQLITE_DB"));
        });

        await t.step("CapExecEnvAide: toObject default & filter", () => {
            const cap = new CapExecEnvAide(new EnvAide());
            const obj = cap.toObject();
            // Default: only CAPEXEC_* (prefixed)
            assertEquals(obj.CAPEXEC_TARGET_SQLITE_DB, "/tmp/db.sqlite");
            assertEquals(obj.CAPEXEC_DB_URL, "sqlite:///tmp/db.sqlite");
            // Not included by default
            assertEquals(Object.hasOwn(obj, "HOME"), false);

            const obj2 = cap.toObject((k) => k === "HOME");
            assertEquals(obj2.HOME, "/home/test"); // included by filter
            assertEquals(obj2.CAPEXEC_TARGET_SQLITE_DB, "/tmp/db.sqlite"); // still present
        });

        await t.step(
            "CapExecEnvAide: context() JSON parsing & schema validation",
            async (t2) => {
                const cap = new CapExecEnvAide(new EnvAide());

                await t2.step("returns parsed JSON when no schema", () => {
                    const ctx = cap.context<{ runId: string; n: number }>();
                    assertEquals(ctx, { runId: "abc123", n: 2 });
                });

                await t2.step("uses schema.parse when provided", () => {
                    const schema = {
                        parse(value: unknown) {
                            const v = value as { runId?: unknown; n?: unknown };
                            if (
                                typeof v?.runId !== "string" ||
                                typeof v?.n !== "number"
                            ) {
                                throw new Error("Invalid shape");
                            }
                            return { runId: v.runId, n: v.n };
                        },
                    };
                    const ctx = cap.context(schema);
                    assertEquals(ctx, { runId: "abc123", n: 2 });
                });

                await t2.step("throws on invalid JSON", () => {
                    const snap2 = snapshotEnv();
                    try {
                        Deno.env.set("CAPEXEC_CONTEXT", "{not json}");
                        const cap2 = new CapExecEnvAide(new EnvAide());
                        assertThrows(
                            () => cap2.context(),
                            "Invalid JSON in CAPEXEC_CONTEXT",
                        );
                    } finally {
                        restoreEnv(snap2);
                    }
                });

                await t2.step(
                    "returns undefined when CAPEXEC_CONTEXT missing/empty",
                    () => {
                        const snap2 = snapshotEnv();
                        try {
                            Deno.env.delete("CAPEXEC_CONTEXT");
                            const cap2 = new CapExecEnvAide(new EnvAide());
                            const ctx = cap2.context();
                            assertEquals(ctx, undefined);
                        } finally {
                            restoreEnv(snap2);
                        }
                    },
                );
            },
        );

        await t.step("CapExecEnvAide: prefixedKeys()", () => {
            const cap = new CapExecEnvAide(new EnvAide());
            const pk = cap.prefixedKeys();
            // Should include the exact prefixed names
            assert(pk.includes("CAPEXEC_TARGET_SQLITE_DB"));
            assert(pk.includes("CAPEXEC_DB_URL"));
            // And not include non-CAPEXEC envs
            assert(!pk.includes("HOME"));
        });
    } finally {
        restoreEnv(snap);
    }
});
