/**
 * content/mod_test.ts
 * Basic integration tests for FileContent on Deno.
 */

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
    createFileContent,
    type FSGovernance,
    isBinary,
    isText,
} from "./mod.ts";

Deno.test("FileContent: text round-trip via writeText/readText", async () => {
    const path = await Deno.makeTempFile({ suffix: ".txt" });
    try {
        const gov: FSGovernance = {
            policy: { detectTextByExtension: true, defaultEncoding: "utf-8" },
        };
        const fc = createFileContent({
            contentId: path,
            path,
            governance: gov,
        });

        assert(isText(fc), "should detect .txt as text");

        const content = "hello\nworld";
        await fc.writeText(content);
        const readBack = await fc.readText();
        assertEquals(readBack, content);

        await fc.close();
    } finally {
        await Deno.remove(path);
    }
});

Deno.test("FileContent: binary nature by default for unknown extensions", async () => {
    const path = await Deno.makeTempFile({ suffix: ".bin" });
    try {
        const fc = createFileContent({ contentId: path, path });
        // guard works without governance inference issues
        assert(isBinary(fc), "should detect .bin as binary");

        const bytes = new Uint8Array([1, 2, 3, 4, 5]);
        await fc.writeBytes(bytes);
        const roundTrip = await fc.readBytes();
        assertEquals(roundTrip, bytes);
        await fc.close();
    } finally {
        await Deno.remove(path);
    }
});

Deno.test("FileContent: ranged reads work (slice inside stream)", async () => {
    const path = await Deno.makeTempFile({ suffix: ".txt" });
    try {
        const fc = createFileContent({
            contentId: path,
            path,
            governance: { policy: { detectTextByExtension: true } },
        });
        await fc.writeText("ABCDEFGHIJ"); // 10 bytes ASCII

        // read range [2, 7) -> "CDEFG"
        const txt = await fc.readText("utf-8", { range: { start: 2, end: 7 } });
        assertEquals(txt, "CDEFG");

        await fc.close();
    } finally {
        await Deno.remove(path);
    }
});

Deno.test("FileContent: append vs truncate", async () => {
    const path = await Deno.makeTempFile({ suffix: ".log" });
    try {
        const fc = createFileContent({
            contentId: path,
            path,
            governance: { policy: { detectTextByExtension: true } },
        });

        await fc.writeText("one\n", "utf-8", { truncate: true });
        await fc.writeText("two\n", "utf-8", { append: true }); // don't truncate
        const txt = await fc.readText();
        assertEquals(txt, "one\ntwo\n");

        await fc.close();
    } finally {
        await Deno.remove(path);
    }
});

Deno.test("FileContent: close() is idempotent and prevents new opens", async () => {
    const path = await Deno.makeTempFile();
    try {
        const fc = createFileContent({ contentId: path, path });
        await fc.close();
        await fc.close(); // should not throw
        await assertRejects(() => fc.getReadable(), Error, "closed");
    } finally {
        await Deno.remove(path);
    }
});

Deno.test("FileContent: governance annotations are strongly typed (compile-time)", () => {
    // This test is illustrative. Compile-time typing is enforced by TS itself.
    type ReviewAnnotations = {
        reviewer: string;
        status: "pending" | "approved" | "rejected";
        ticketId?: string;
    };
    type Gov = FSGovernance<ReviewAnnotations>;
    const gov: Gov = {
        annotations: { reviewer: "alice", status: "approved" },
        policy: { detectTextByExtension: true },
    };
    // If you uncomment the next line, TypeScript should error (status not allowed):
    // const badGov: Gov = { annotations: { reviewer: "bob", status: "ok" } };

    assert(gov.annotations?.status === "approved");
});
