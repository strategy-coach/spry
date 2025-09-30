// macro_test.ts
import {
  assert,
  assertEquals,
  assertMatch,
  assertStrictEquals,
} from "jsr:@std/assert@1";
import {
  CandidateDefn,
  Emitter,
  includeStream,
  lineCommentDirectiveParser,
  ReplaceStream,
  ReplaceStreamEvents,
  streamToString,
  textToShellArgv,
} from "./directive.ts";

type Payload = { contentState: "unmodified" | "modified" };

// ———————————————————————————————————————————
// Small helpers for tests
// ———————————————————————————————————————————
function rsFromStrings(...parts: string[]): ReadableStream<string> {
  return new ReadableStream<string>({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

Deno.test("Emitter basics", async (t) => {
  type Ev = { ping: (n: number) => void; oncey: () => void };
  const em = new Emitter<Ev>();
  const got: number[] = [];
  let onceCount = 0;

  await t.step("on/off", () => {
    const off = em.on("ping", (n) => got.push(n));
    em.emit("ping", 1);
    em.emit("ping", 2);
    off();
    em.emit("ping", 3);
    assertEquals(got, [1, 2]);
  });

  await t.step("once", () => {
    em.once("oncey", () => onceCount++);
    em.emit("oncey");
    em.emit("oncey");
    assertEquals(onceCount, 1);
  });
});

Deno.test("lineCommentDirectiveParser", async (t) => {
  const parse = lineCommentDirectiveParser({
    comment: "--",
    directivePrefix: "#",
  });

  await t.step("comment + prefix + token", () => {
    assertEquals(parse("--   #include  libs  x y"), [
      "include",
      "libs  x y",
      "#",
    ]);
  });

  await t.step("comment + token (no prefix)", () => {
    assertEquals(parse("--   hello   world  x"), ["hello", "world  x", ""]);
  });

  await t.step("no comment = first word split", () => {
    assertEquals(parse("hi there you"), ["hi", "there you", ""]);
  });

  await t.step("marker only returns false", () => {
    assertEquals(parse("--      "), false);
  });

  await t.step("prefix but no directive returns false", () => {
    assertEquals(parse("-- #    "), false);
  });
});

Deno.test("textToShellArgv", async (t) => {
  await t.step("whitespace tokenization", () => {
    assertEquals(textToShellArgv("a b   c"), ["a", "b", "c"]);
  });
  await t.step("single quotes literal", () => {
    assertEquals(textToShellArgv("cmd 'a b' c"), ["cmd", "a b", "c"]);
  });
  await t.step("double quotes escapes", () => {
    assertEquals(textToShellArgv(`x "c \\"d\\"" end`), [
      "x",
      `c "d"`,
      "end",
    ]);
  });
  await t.step("backslash outside quotes", () => {
    assertEquals(textToShellArgv("a\\ b \\$HOME"), ["a b", "$HOME"]);
  });
  await t.step("trailing backslash outside quotes", () => {
    assertEquals(textToShellArgv("a \\"), ["a", "\\"]);
  });
  await t.step("double-quote final backslash special-case", () => {
    // Match current parser behavior: \" before the final " yields a literal "
    assertEquals(textToShellArgv(`"a\\""`), [`a"`]);
  });
  await t.step("unclosed quotes throws", () => {
    try {
      textToShellArgv("'oops");
      assert(false, "should have thrown");
    } catch (e) {
      assertMatch(String(e), /Unclosed quote/);
    }
  });
});

Deno.test("streamToString", async () => {
  const rs = rsFromStrings("a", "b", "c");
  const s = await streamToString(rs);
  assertEquals(s, "abc");
});

Deno.test("ReplaceStream inline replacement", async () => {
  type P = Payload & { x: number };
  type C = CandidateDefn<P>;

  const isCandidate = (line: string, _n: number, _p: P): C | false => {
    if (!line.startsWith("=sum")) return false;
    const argsText = line.slice(4).trim();
    return {
      directive: "sum",
      argsText,
      render: (p) => {
        const parts = argsText.split(/\s+/).map(Number);
        const val = parts.reduce((a, b) => a + b, 0) + p.x;
        return String(val);
      },
    };
  };

  const engine = new ReplaceStream<C, P>(isCandidate);
  const input = "=sum 1 2 3\nother\n";
  const out = await engine.processToString(input, {
    x: 4,
    contentState: "unmodified",
  });
  assertEquals(out.after, "10\nother\n");
});

Deno.test("ReplaceStream inline preserves existing EOL or infers", async (t) => {
  type P = Payload;
  type C = CandidateDefn<P>;
  const isCandidate = (line: string): C | false =>
    line.startsWith("=x")
      ? {
        directive: "x",
        argsText: "",
        render: () => "Z",
      }
      : false;

  await t.step("LF preserved", async () => {
    const eng = new ReplaceStream<C, P>(isCandidate);
    const res = await eng.processToString("=x\n", {
      contentState: "unmodified",
    });
    assertEquals(res.after, "Z\n");
  });

  await t.step("CRLF preserved", async () => {
    const eng = new ReplaceStream<C, P>(isCandidate);
    const res = await eng.processToString("=x\r\n", {
      contentState: "unmodified",
    });
    assertEquals(res.after, "Z\r\n");
  });

  await t.step("no EOL on input line → inferred LF", async () => {
    const eng = new ReplaceStream<C, P>(isCandidate);
    const res = await eng.processToString("=x", {
      contentState: "unmodified",
    });
    assertEquals(res.after, "Z\n");
  });
});

Deno.test("ReplaceStream block replacement with markers preserved", async () => {
  type P = Payload & { word: string };
  type C = CandidateDefn<P>;
  const isCandidate = (line: string): C | false => {
    if (line.trim() === "BEGIN") {
      return {
        directive: "B",
        argsText: "",
        blockEnd: (probe) => probe.trim() === "END",
        render: (p) => [`A:${p.word}`, "B:ok"],
      };
    }
    return false;
  };
  const engine = new ReplaceStream<C, P>(isCandidate);
  const input = ["x", "BEGIN", "old1", "old2", "END", "y"].join("\n") + "\n";
  const out = await engine.processToString(input, {
    word: "W",
    contentState: "unmodified",
  });
  assertEquals(
    out.after,
    ["x", "BEGIN", "A:W", "B:ok", "END", "y", ""].join("\n"),
  );
});

Deno.test("ReplaceStream render returning ReadableStream", async () => {
  type P = Payload;
  type C = CandidateDefn<P>;

  const isCandidate = (line: string): C | false =>
    line.startsWith("=rs")
      ? {
        directive: "rs",
        argsText: "",
        render: () => rsFromStrings("hello", " ", "world"),
      }
      : false;

  const eng = new ReplaceStream<C, P>(isCandidate);
  const out = await eng.processToString("=rs\n", {
    contentState: "unmodified",
  });
  assertEquals(out.after, "hello world\n");
});

Deno.test("ReplaceStream events fire in expected order (inline)", async () => {
  type P = Payload;
  type C = CandidateDefn<P>;
  const events: string[] = [];

  const emitter = new Emitter<ReplaceStreamEvents<C, P>>();
  emitter.on("line", (i) => events.push(`line#${i.lineNo}`));
  emitter.on("candidate", (i) => events.push(`cand:${i.identity}`));
  emitter.on("inlineRender", (i) => events.push(`ir:${i.identity}`));
  emitter.on(
    "emitChunk",
    (i) => events.push(`chunk:${JSON.stringify(i.chunk)}`),
  );
  emitter.on("error", () => events.push("error"));

  const isCandidate = (line: string): C | false =>
    line.startsWith("=x")
      ? { directive: "x", argsText: "", render: () => "Z" }
      : false;

  const eng = new ReplaceStream<C, P>(isCandidate, {
    events: emitter,
    startLine: 10,
  });

  const res = await eng.processToString("=x\n", {
    contentState: "unmodified",
  });
  assertEquals(res.after, "Z\n");
  assertEquals(events, [
    "line#10",
    "cand:x",
    "ir:x",
    `chunk:"Z\\n"`,
  ]);
});

Deno.test("Error policy: candidate throws → continue preserves text", async () => {
  type P = Payload;
  type C = CandidateDefn<P>;

  const isCandidate = (_line: string, _n: number): C | false => {
    throw new Error("bad detect");
  };

  const errors: string[] = [];
  const emitter = new Emitter<
    {
      error: (e: unknown, _ctx: unknown) => void;
      emitChunk: (i: { chunk: string; anchorLineNo: number }) => void;
    }
  >();
  emitter.on("error", (e) => errors.push(String(e)));

  const eng = new ReplaceStream<C, P>(isCandidate, {
    events: emitter as unknown as Emitter<ReplaceStreamEvents<C, P>>,
    onError: () => "continue",
  });
  const input = "plain\n";
  const out = await eng.processToString(input, {
    contentState: "unmodified",
  });
  assertEquals(out.after, input);
  assertMatch(errors[0], /bad detect/);
});

Deno.test("Error policy: blockEnd predicate throws → continue keeps inner", async () => {
  type P = Payload;
  type C = CandidateDefn<P>;

  const isCandidate = (line: string): C | false => {
    if (line.trim() === "BEGIN") {
      return {
        directive: "B",
        argsText: "",
        blockEnd: (_probe) => {
          throw new Error("oops probe");
        },
        render: () => ["new"],
      };
    }
    return false;
  };

  const eng = new ReplaceStream<C, P>(isCandidate, {
    onError: () => "continue",
  });

  const input = "BEGIN\n1\n2\nEND\n";
  const out = await eng.processToString(input, {
    contentState: "unmodified",
  });
  assertMatch(out.after, /^BEGIN\n1\n2\nEND\n$/);
});

Deno.test("Unterminated block → continue policy best-effort passthrough", async () => {
  type P = Payload;
  type C = CandidateDefn<P>;
  const isCandidate = (line: string): C | false =>
    line.trim() === "BEGIN"
      ? {
        directive: "B",
        argsText: "",
        blockEnd: (probe) => probe.trim() === "END",
        render: () => ["SHOULD-NOT-BE-USED"],
      }
      : false;

  const eng = new ReplaceStream<C, P>(isCandidate, {
    onError: () => "continue",
  });

  const out = await eng.processToString("BEGIN\nx\n", {
    contentState: "unmodified",
  });
  assertEquals(out.after, "BEGIN\nx\n");
});

Deno.test("CRLF inference for inserted lines within block", async () => {
  type P = Payload;
  type C = CandidateDefn<P>;

  const isCandidate = (line: string): C | false =>
    line.trim() === "BEGIN"
      ? {
        directive: "B",
        argsText: "",
        blockEnd: (p) => p.trim() === "END",
        render: () => ["a", "b"],
      }
      : false;

  const eng = new ReplaceStream<C, P>(isCandidate);
  const input = "X\r\nBEGIN\r\nOLD\r\nEND\r\nY\r\n";
  const res = await eng.processToString(input, {
    contentState: "unmodified",
  });
  assertEquals(res.after, "X\r\nBEGIN\r\na\r\nb\r\nEND\r\nY\r\n");
});

Deno.test("includeStream: basic happy path with two regions", async () => {
  const input = [
    "-- #include A",
    "will be replaced",
    "-- #includeEnd A",
    "-- #include B arg1 arg2",
    "old",
    "-- #includeEnd B",
  ].join("\n");

  const rs = includeStream(
    input,
    {
      render: (name, cand) => {
        if (name === "A") return ["X"];
        if (name === "B") {
          assertStrictEquals(cand.argsText, "arg1 arg2");
          return ["Y1", "Y2"];
        }
        return ["?"];
      },
      startLine: 1,
    },
    { contentState: "unmodified" },
  );

  const out = await streamToString(rs);
  // Normalize EOLs and compare line-by-line (more robust than one big string)
  const lines = out.replace(/\r\n/g, "\n").split("\n");
  assertEquals(lines, [
    "-- #include A",
    "X",
    "-- #includeEnd A",
    "-- #include B arg1 arg2",
    "Y1",
    "Y2",
    "-- #includeEnd B",
  ]);
});

Deno.test("includeStream: ensure end matches same name", async () => {
  const input = [
    "-- #include name-1",
    "wrong",
    "-- #includeEnd name-2",
  ].join("\n");

  const rs = includeStream(
    input,
    {
      render: () => ["X"],
      onError: () => "continue",
    },
    { contentState: "unmodified" },
  );
  const out = await streamToString(rs);
  assertEquals(out, input);
});

Deno.test("ReplaceStream accepts ReadableStream input", async () => {
  type P = Payload;
  type C = CandidateDefn<P>;
  const isCandidate = (line: string): C | false =>
    line.startsWith("=hi")
      ? { directive: "hi", argsText: "", render: () => "yo" }
      : false;

  const eng = new ReplaceStream<C, P>(isCandidate);
  const input = rsFromStrings("=hi", "\n", "plain\n");
  const out = await eng.processToString(input, {
    contentState: "unmodified",
  });
  assertEquals(out.after, "yo\nplain\n");
});

Deno.test("Inline render returns empty string → engine appends EOL", async () => {
  type P = Payload;
  type C = CandidateDefn<P>;
  const isCandidate = (line: string): C | false =>
    line === "=empty"
      ? {
        directive: "empty",
        argsText: "",
        render: () => "",
      }
      : false;
  const eng = new ReplaceStream<C, P>(isCandidate);
  const out = await eng.processToString("=empty\n", {
    contentState: "unmodified",
  });
  assertEquals(out.after, "\n");
});

Deno.test("Block render returns empty array → single EOL inserted", async () => {
  type P = Payload;
  type C = CandidateDefn<P>;
  const isCandidate = (line: string): C | false =>
    line.trim() === "BEGIN"
      ? {
        directive: "B",
        argsText: "",
        blockEnd: (p) => p.trim() === "END",
        render: () => [],
      }
      : false;

  const eng = new ReplaceStream<C, P>(isCandidate);
  const out = await eng.processToString("BEGIN\nOLD\nEND\n", {
    contentState: "unmodified",
  });
  assertEquals(out.after, "BEGIN\n\nEND\n");
});

Deno.test("startLine offsets event line numbers", async () => {
  type P = Payload;
  type C = CandidateDefn<P>;

  const ev: number[] = [];
  const emitter = new Emitter<ReplaceStreamEvents<C, P>>();
  emitter.on("line", (i) => ev.push(i.lineNo));

  const isCandidate = (_l: string): C | false => false;

  const eng = new ReplaceStream<C, P>(isCandidate, {
    events: emitter,
    startLine: 5,
  });

  const out = await eng.processToString("a\nb\n", {
    contentState: "unmodified",
  });
  assertEquals(out.after, "a\nb\n");
  assertEquals(ev, [5, 6]);
});

// (Optional) tiny delay to flush microtasks
await delay(1);
