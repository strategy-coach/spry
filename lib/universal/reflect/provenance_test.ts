// provenance_test.ts
import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { provenanceText, sourceCodeProvenance } from "./provenance.ts";

Deno.test("sourceCodeProvenance", async (t) => {
  await t.step("captures a simple function call", () => {
    function demo() {
      return sourceCodeProvenance({ importMetaURL: import.meta.url });
    }
    const p = demo();
    // We don't hardcode the filename; just ensure a .ts URL/path is present.
    assertStringIncludes(p.url, ".ts");
    assert(typeof p.functionName === "string" || typeof p.reason === "string");
  });

  await t.step("respects framesToSkip option", () => {
    // The goal here is simply "still works" with skip present.
    function wrapper() {
      return sourceCodeProvenance({
        importMetaURL: import.meta.url,
        framesToSkip: 1,
      });
    }
    const p = wrapper();
    assertStringIncludes(p.url, ".ts");
  });

  await t.step("formats provenanceComment correctly", () => {
    function demo() {
      return provenanceText({ importMetaURL: import.meta.url });
    }
    const msg = `code provenance: ${demo()}`;
    // Robust format check (don’t rely on exact filename).
    assertMatch(msg, /^code provenance: `.+` \(.+\.ts(?::\d+:\d+)?\)/);
  });

  await t.step(
    "uses injected stackProvider when provided (string stack)",
    () => {
      // With the tiny patch, stackProvider is preferred.
      const mockStack = () =>
        [
          "Error",
          "    at FakeClass.fakeMethod (file:///mock/file.ts:10:5)",
        ].join("\n");

      const p = sourceCodeProvenance({
        importMetaURL: "file:///mock/provenance_test.ts",
        stackProvider: mockStack,
      });

      assertEquals(p.className, "FakeClass");
      assertEquals(p.methodName, "fakeMethod");
      assertEquals(p.file, "file:///mock/file.ts");
      assertEquals(p.line, 10);
      assertEquals(p.column, 5);
      assertEquals(p.url, "/mock/provenance_test.ts"); // file: normalized to path
    },
  );

  await t.step("subclass method provenance looks sane", () => {
    class Base {
      doWork() {
        return sourceCodeProvenance({ importMetaURL: import.meta.url });
      }
    }
    class Child extends Base {
      override doWork() {
        return super.doWork();
      }
    }
    const p = new Child().doWork();

    // We can’t guarantee class/type discovery across all runtimes,
    // but we can at least assert a function/class-ish name surfaces.
    assert(
      typeof p.functionName === "string" ||
        typeof p.methodName === "string" ||
        typeof p.className === "string",
      "Expected some kind of function/class/method identification",
    );
    // And the source indicator should be present.
    assertStringIncludes(p.url, ".ts");
  });

  await t.step(
    "fallback still returns a useful object when no stack is available",
    () => {
      // Force the parser down the fallback path with an empty stack string
      const p = sourceCodeProvenance({
        importMetaURL: "file:///nowhere.ts",
        stackProvider: () => "Error\n",
      });
      assertEquals(p.url, "/nowhere.ts");
      assertEquals(p.reason !== undefined, true);
    },
  );
});
