---
title: Core Fixture 01 (Complex)
tags:
  - demo
  - test
  - complex
presets:
  sqlDefault:
    schema: main
    dryRun: false
---

Intro paragraph line one to establish preface text before any delimiter.

Intro paragraph line two to verify multi-paragraph aggregation into the first
markdown cell.

---

This paragraph appears immediately after a thematic break. It should belong to a
markdown cell that starts at the thematic break delimiter.

## Section A — Patients

This section introduces a SQL example with attributes and info in the fence
meta. The heading must start a new markdown cell and the heading itself should
be included in that cell.

```sql INFO MORE_INFO { id: 1, name: 'patients', dryRun: true }
SELECT id, given_name, family_name
FROM patients
WHERE active = true;
```

After the SQL code fence, this narrative text should form its own markdown cell
up until the next code fence.

```bash run-once { id: , }
# Intentionally malformed JSON5 in the meta to trigger an issue record.
echo "Hello from a bash cell with a meta parse problem."
```

## Section B — Inventory

This section shows JSON and XML code fences separated by narrative text to test
partitioning across multiple code cells.

```json { note: 'ok' }
{ "sku": "ABC-123", "qty": 10, "tags": ["new", "promo"] }
```

The XML export block follows. The narrative is here to ensure a markdown cell is
emitted in between.

```xml { role: 'export' }
<inventory>
  <item id="1" sku="ABC-123" qty="10"/>
  <item id="2" sku="DEF-456" qty="5"/>
</inventory>
```

## Section C — Misc

This section contains CSV and Fish shell examples followed by a raw code block
without a language.

```csv
id,name,qty
1,alpha,10
2,beta,5
```

After the CSV code fence, this paragraph should become its own markdown cell
before the next code fence.

```fish meta
echo "hello from fish"
```

```
This is a raw code block without an explicit language.
It should become a code cell with language "text".
```

---

This trailing paragraph appears after a thematic break and should be included in
a markdown cell that starts at the delimiter and ends at file end.
