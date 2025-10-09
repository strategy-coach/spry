import {
  assert,
  assertEquals,
  assertGreater,
  assertMatch,
} from "jsr:@std/assert@^1";
import {
  type Cell,
  type CodeCell,
  DocumentedCodeCell,
  type DocumentedNotebook,
  documentedNotebooks,
  Issue,
  type MarkdownCell,
  type Notebook,
  notebooks,
} from "./core.ts";

// Generic, attrs-preserving type guards
function isCode<T extends Record<string, unknown>>(
  c: Cell<string, T>,
): c is CodeCell<string, T> {
  return c.kind === "code";
}

function isMarkdown<T extends Record<string, unknown>>(
  c: Cell<string, T>,
): c is MarkdownCell<string> {
  return c.kind === "markdown";
}

async function loadFixture(): Promise<string> {
  const url = new URL("./mod_test-fixture-01.md", import.meta.url);
  return await Deno.readTextFile(url);
}

Deno.test("Markdown Notebook core - complex fixture", async (t) => {
  // Load the complex fixture
  const md = await loadFixture();

  // Parse with the core — pass a single string (valid Source)
  const out: Notebook<string>[] = [];
  for await (const nb of notebooks({ provenance: "prime", content: md })) {
    out.push(nb);
  }

  assertEquals(out.length, 1, "expected exactly one notebook");
  const nb = out[0];

  await t.step("frontmatter parsed", () => {
    const fm = nb.fm as Record<string, unknown>;
    assertEquals(fm.title, "Core Fixture 01 (Complex)");
    assertEquals(fm.tags, ["demo", "test", "complex"]);
    assertEquals((fm.presets as Record<string, unknown>)?.["sqlDefault"], {
      schema: "main",
      dryRun: false,
    });
  });

  await t.step("cell partitioning and kinds sequence", () => {
    const kinds = nb.cells.map((c) => c.kind);
    assertEquals(kinds, [
      "markdown",
      "markdown",
      "markdown",
      "code",
      "markdown",
      "code",
      "markdown",
      "code",
      "markdown",
      "code",
      "markdown",
      "code",
      "markdown",
      "code",
      "code",
      "markdown",
    ]);
  });

  await t.step("sql code cell - language, info, attrs, and content", () => {
    const cell = nb.cells[3];
    assert(isCode(cell as Cell<string, Record<string, unknown>>));
    if (isCode(cell)) {
      assertEquals(cell.language, "sql");
      assertEquals(cell.info, "INFO MORE_INFO");
      assertEquals(cell.attrs, { id: 1, name: "patients", dryRun: true });
      assertMatch(cell.source, /SELECT\s+id/i);
      assert(
        typeof cell.startLine === "number" && typeof cell.endLine === "number",
      );
    }
  });

  await t.step("markdown after sql - narrative preserved", () => {
    const cell = nb.cells[4];
    assert(isMarkdown(cell));
    assertMatch(cell.text, /After the SQL code fence/);
    assert(
      typeof cell.startLine === "number" && typeof cell.endLine === "number",
    );
  });

  await t.step(
    "bash code cell - malformed JSON5 yields empty attrs and warning issue",
    () => {
      const cell = nb.cells[5];
      assert(isCode(cell));
      assertEquals(cell.language, "bash");
      assertEquals(cell.attrs, {}, "malformed meta should yield empty attrs");
      assertMatch(cell.source, /echo "Hello from a bash cell/);
      const warnings = nb.issues.filter((i) =>
        i.kind === "fence-attrs-json5-parse"
      );
      assertGreater(warnings.length, 0, "expected at least one warning issue");
    },
  );

  await t.step("json code cell - language and payload", () => {
    const cell = nb.cells[7];
    assert(isCode(cell));
    assertEquals(cell.language, "json");
    assertMatch(cell.source, /"sku":\s*"ABC-123"/);
  });

  await t.step("xml code cell - language and structure", () => {
    const cell = nb.cells[9];
    assert(isCode(cell));
    assertEquals(cell.language, "xml");
    assertMatch(cell.source, /<inventory>/);
    assertMatch(cell.source, /<item id="2"/);
  });

  await t.step("csv code cell - language and header line", () => {
    const cell = nb.cells[11];
    assert(isCode(cell));
    assertEquals(cell.language, "csv");
    assertMatch(cell.source, /^id,name,qty/m);
  });

  await t.step("fish code cell - info meta and content", () => {
    const cell = nb.cells[13];
    assert(isCode(cell));
    assertEquals(cell.language, "fish");
    assertEquals(cell.info, "meta");
    assertMatch(cell.source, /echo "hello from fish"/);
  });

  await t.step("raw text code cell - treated as language 'text'", () => {
    const cell = nb.cells[14];
    assert(isCode(cell));
    assertEquals(cell.language, "text");
    assertMatch(cell.source, /raw code block without an explicit language/);
  });

  await t.step("final markdown cell - trailing paragraph after HR", () => {
    const cell = nb.cells[15];
    assert(isMarkdown(cell));
    assertMatch(cell.text, /trailing paragraph/);
  });
});

Deno.test("documentedNotebooks — default delimiter (H2 headings)", async () => {
  const md = await loadFixture();

  // Parse with core (generic defaults OK: FM/Attrs inferred, Issue = base Issue)
  const parsed: Notebook<string>[] = [];
  for await (const nb of notebooks({ provenance: "prime", content: md })) {
    parsed.push(nb);
  }

  assertEquals(parsed.length, 1);
  const nb = parsed[0];

  // Sanity: mdast cache exists & looks consistent
  assert(Array.isArray(nb.ast.mdastByCell));
  assert(Array.isArray(nb.ast.codeCellIndices));
  assertGreater(nb.ast.mdastByCell.length, 0);

  // Enrich with documented notebooks (default delimiter: { kind: "heading", level: 2 })
  const outs: DocumentedNotebook<
    string,
    Record<string, unknown>,
    Record<string, unknown>,
    Issue<string>
  >[] = [];
  for await (const out of documentedNotebooks(parsed)) outs.push(out);

  assertEquals(outs.length, 1);
  const doc = outs[0];

  // ---------- Notebook-level header instructions ----------
  // Should include everything after FM up to first code fence:
  // - Intro paragraphs (2)
  // - The HR and the paragraph right after it
  // - The H2 "Section A" and the section intro paragraph
  assert(doc.instructions);
  const headerText = doc.instructions?.text ?? "";
  assertMatch(headerText, /Intro paragraph line one/i);
  assertMatch(headerText, /Intro paragraph line two/i);
  assertMatch(
    headerText,
    /This paragraph appears immediately after a thematic break/i,
  );
  assertMatch(headerText, /Section A/i);
  assertMatch(headerText, /This section introduces a SQL example/i);

  // ---------- Notebook-level appendix ----------
  // Should include the trailing paragraph after the final thematic break
  assert(doc.appendix);
  const appendixText = doc.appendix?.text ?? "";
  assertMatch(appendixText, /trailing paragraph/i);

  // Helper to pick code cells by language in order
  const code = (lang: string, idx = 0) => {
    const all = doc.cells.filter((c): c is DocumentedCodeCell<string> =>
      c.kind === "code" && c.language === lang
    );
    return all[idx];
  };

  // Cells by expected order from existing core_test.ts:
  // 3: sql, 5: bash, 7: json, 9: xml, 11: csv, 13: fish, 14: text (raw)
  const sql = code("sql")!;
  const bash = code("bash")!;
  const json = code("json")!;
  const xml = code("xml")!;
  const csv = code("csv")!;
  const fish = code("fish")!;
  const plainTextCell = doc.cells.find(
    (c): c is DocumentedCodeCell<string> =>
      c.kind === "code" && c.language === "text",
  )!;

  // ---------- Per-code-cell instructions with H2 delimiter ----------

  // SQL code: buffer should include H2 "Section A" + its intro paragraph
  assert(sql.instructions, "expected SQL cell to have instructions");
  assertMatch(sql.instructions!.text, /Section A/i);
  assertMatch(sql.instructions!.text, /This section introduces a SQL example/i);

  // Bash code: buffer should be only the narrative after SQL (no heading in between)
  assert(bash.instructions, "expected bash cell to have instructions");
  assertMatch(bash.instructions!.text, /After the SQL code fence/i);

  // JSON code: buffer should include H2 "Section B" + its intro paragraph
  assert(json.instructions, "expected json cell to have instructions");
  assertMatch(json.instructions!.text, /Section B/i);
  assertMatch(
    json.instructions!.text,
    /This section shows JSON and XML code fences/i,
  );

  // XML code: buffer should be the short narrative "The XML export block follows..."
  assert(xml.instructions, "expected xml cell to have instructions");
  assertMatch(xml.instructions!.text, /The XML export block follows/i);

  // CSV code: includes H2 "Section C" + its intro sentence
  assert(csv.instructions, "expected csv cell to have instructions");
  assertMatch(csv.instructions!.text, /Section C/i);
  assertMatch(csv.instructions!.text, /contains CSV and Fish shell examples/i);

  // FISH code: buffer should be narrative after CSV ("After the CSV code fence...")
  assert(fish.instructions, "expected fish cell to have instructions");
  assertMatch(fish.instructions!.text, /After the CSV code fence/i);

  // Raw text code (the triple-backtick without lang): occurs right after fish with no intervening markdown;
  // buffer should be empty -> no instructions
  assertEquals(plainTextCell.instructions, undefined);
});

Deno.test("documentedNotebooks — alternative delimiter (thematic breaks / hr)", async () => {
  const md = await loadFixture();

  const parsed: Notebook<string>[] = [];
  for await (const nb of notebooks({ provenance: "prime", content: md })) {
    parsed.push(nb);
  }
  assertEquals(parsed.length, 1);

  const outs: DocumentedNotebook<
    string,
    Record<string, unknown>,
    Record<string, unknown>,
    Issue<string>
  >[] = [];
  for await (const out of documentedNotebooks(parsed, { kind: "hr" })) {
    outs.push(out);
  }

  assertEquals(outs.length, 1);
  const doc = outs[0];

  // With HR delimiters, the pre-Section-A HR will clear buffer, so SQL instructions
  // should still include the H2 "Section A" heading and its intro paragraph (since they are
  // after that HR). This ensures behavior remains sensible with HR-based delimiting.
  const sql = doc.cells.find(
    (c): c is DocumentedCodeCell<string> =>
      c.kind === "code" && c.language === "sql",
  )!;
  assert(
    sql.instructions,
    "expected SQL cell to have instructions under HR delimiter",
  );
  const sqlText = sql.instructions?.text ?? "";
  assertMatch(sqlText, /Section A/i);
  assertMatch(sqlText, /This section introduces a SQL example/i);

  // Appendix should be the same regardless of delimiter
  assert(doc.appendix);
  assertMatch(doc.appendix!.text, /trailing paragraph/i);
});
