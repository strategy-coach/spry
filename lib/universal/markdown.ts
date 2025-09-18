/**
 * @module markdown_store
 *
 * Minimal, dependency-light Markdown authoring toolkit with a fluent, type-safe API.
 * It buffers lines per *document path*, supports **named/reopenable sections**,
 * emits **YAML front matter** via Deno stdlib, and renders through pluggable targets
 * (file system, stdout, or in-memory).
 *
 * ## Why this exists
 * When generating docs from code (build scripts, CLIs, pipelines), you want
 * deterministic structure, composable sections, and zero-surprise formatting.
 * This module gives you that without bringing a full static site generator.
 *
 * ## Highlights
 * - **Named sections you can reopen**: call `section("Intro")` again to append, not duplicate.
 * - **Ordering controls**: `after("Background").section("Findings", ...)` to place sections precisely.
 * - **Front matter**: `frontMatter()` and `frontMatterOnce()` using `@std/yaml`.
 * - **Includes**: pull in another doc (or a single section) with `include()`.
 * - **TOC**: generate a table of contents from captured headings with `toc()`.
 * - **MDX helpers**: optional passthrough for JSX/MDX constructs.
 * - **Renderers**: `FileRenderer`, `StdoutRenderer`, `BufferRenderer`, or bring your own via `MarkdownRenderer`.
 * - **Linter hook**: run a markdown linter before rendering; fail or warn in CI.
 *
 * ## Quick start
 * ```ts
 * import { MarkdownStore, FileRenderer } from "./markdown_store.ts";
 *
 * // Constrain relative paths at the type level
 * type DocPath = `docs/${string}.md`;
 *
 * const md = new MarkdownStore<DocPath>({ anchors: true });
 *
 * // Build a document with reopenable sections
 * md.markdown("docs/readme.md")
 *   .frontMatterOnce({ title: "My Project", tags: ["deno", "md"] })
 *   .section("Introduction", m => m.p("Small description."))
 *   .section("Getting Started", m => m.code("bash", "deno run -A main.ts"))
 *   // Reopen the same section later; content appends
 *   .section("Getting Started", m => m.ul("Install Deno", "Run the script"))
 *   // Control ordering (place Findings after Background)
 *   .after("Background").section("Findings", m => m.p("Key results."))
 *   // Include a section from another doc
 *   .include("docs/other.md", { sectionTitle: "Summary", includeHeading: true })
 *   .toc([1,2,3]); // emit TOC for h1..h3
 *
 * // Render to files (ensures parent directories)
 * await md.render("docs/readme.md", new FileRenderer("/dev/shm/myapp"));
 * ```
 *
 * ## Renderers
 * - `FileRenderer<I>` — writes to a root directory, returns the absolute path.
 * - `StdoutRenderer<I>` — writes content to stdout.
 * - `BufferRenderer<I>` — keeps content in memory; great for tests or further processing.
 *
 * ## Bring-your-own renderer
 * Implement `MarkdownRenderer<I>`: `{ write(path, content): R | Promise<R> }`.
 *
 * ## Notes
 * - Paths are **relative** (type parameter `I extends string` helps you constrain them, e.g. `` `docs/${string}.md` ``).
 * - Output is normalized to include a final POSIX EOL.
 * - Headings can optionally emit stable anchors (`<a id="..."></a>`) for robust intra-doc links.
 */

import { dirname, join, normalize } from "jsr:@std/path@1";
import { ensureDir } from "jsr:@std/fs@1/ensure-dir";
import { stringify as yamlStringify } from "jsr:@std/yaml@1";

/** Render target interface. Implementations return a value R (e.g., written path or content). */
export interface MarkdownRenderer<I extends string, R = unknown> {
    write(path: I, content: string): Promise<R> | R;
}

/** Optional linter hook. */
export interface MarkdownLinter<I extends string> {
    lint(path: I, content: string): Promise<string[]> | string[];
}

/** Collects outputs into memory and returns the content from write(). */
export class BufferRenderer<I extends string>
    implements MarkdownRenderer<I, string> {
    private readonly out = new Map<I, string>();
    // deno-lint-ignore require-await
    async write(path: I, content: string): Promise<string> {
        this.out.set(path, content);
        return content;
    }
    get map(): ReadonlyMap<I, string> {
        return this.out;
    }
}

/** Writes each doc to stdout and returns void. */
export class StdoutRenderer<I extends string>
    implements MarkdownRenderer<I, void> {
    // deno-lint-ignore require-await
    async write(_path: I, content: string): Promise<void> {
        console.log(content);
    }
}

/** Writes to a filesystem root; ensures parent dirs. Returns absolute path. */
export class FileRenderer<I extends string>
    implements MarkdownRenderer<I, string> {
    constructor(readonly destRoot: string) {
        this.root = normalize(destRoot);
    }
    private readonly root: string;
    async write(path: I, content: string): Promise<string> {
        const abs = normalize(join(this.root, path));
        if (!abs.startsWith(this.root)) {
            throw new Error(`Path escapes root: ${path}`);
        }
        await ensureDir(dirname(abs));
        await Deno.writeTextFile(abs, content);
        return abs;
    }
}

type SectionKey = string;
const ROOT_KEY = "__root__";

type SectionBuf = {
    title?: string;
    id?: string;
    level?: 1 | 2 | 3 | 4 | 5 | 6;
    lines: string[];
};

type DocBuf = {
    order: SectionKey[]; // section order (ROOT first)
    sections: Map<SectionKey, SectionBuf>;
    titleToKey: Map<string, SectionKey>; // exact title -> key
    frontMatterEmitted: boolean;
};

/**
 * Main entry point for authoring and assembling Markdown content per **relative path**.
 *
 * The store maintains an in-memory model of each document as an ordered set of sections.
 * You can *start or reopen* a section by title; subsequent calls append to the same section
 * rather than creating duplicates. Finally, render the materialized content via a renderer.
 *
 * @template I Constrains relative paths for documents, e.g. ``type DocPath = `docs/${string}.md` ``.
 *
 * @example Basic usage
 * ```ts
 * type DocPath = `docs/${string}.md`;
 * const md = new MarkdownStore<DocPath>({ anchors: true });
 *
 * md.markdown("docs/guide.md")
 *   .frontMatterOnce({ title: "Guide" })
 *   .section("Intro", m => m.p("Welcome."))
 *   .section("Intro", m => m.p("More context."))  // appends to the same section
 *   .section("Usage", m => m.codeTag("ts")`
 *     export const hello = () => console.log("hi");
 *   `)
 *   .toc();
 *
 * // Serialize without I/O
 * const text = md.markdown("docs/guide.md").write();
 *
 * // Or render to a file
 * await md.render("docs/guide.md", new FileRenderer("/tmp/out"));
 * ```
 *
 * @example Section ordering and includes
 * ```ts
 * md.markdown("docs/report.md")
 *   .after("Background").section("Findings", m => m.p("…"))
 *   .include("docs/appendix.md", { sectionTitle: "Raw Data", includeHeading: true });
 * ```
 *
 * @example Refactors
 * ```ts
 * md.markdown("docs/report.md")
 *   .renameSection("Intro", "Introduction")
 *   .removeSection("Draft Notes");
 * ```
 *
 * @example MDX helpers (opt-in via ctor)
 * ```ts
 * const mdx = new MarkdownStore<DocPath>({ mdx: true });
 * mdx.markdown("docs/mdx.md")
 *   .mdx("<Callout>Heads up</Callout>")
 *   .jsxTag()`<CodeBlock lang="ts">const x=1</CodeBlock>`;
 * ```
 *
 * ### Constructor options
 * - `eol` — `"\n"` (default) or `"\r\n"` line endings.
 * - `anchors` — if `true`, emit `<a id="..."></a>` before headings for stable links.
 * - `mdx` — enable MDX/JSX helpers (`mdx()`, `jsxTag()`).
 * - `linter` — optional `{ lint(path, content): string[] | Promise<string[]> }` hook.
 *
 * ### Fluent builder (selected methods)
 * - **Sections**: `section(title, build?, level=2, { id? })`, `after(title)`, `root()`,
 *   `renameSection(oldTitle, newTitle, { keepId? })`, `removeSection(title)`.
 * - **Structure**: `frontMatter(data)`, `frontMatterOnce(data)`, `toc(levels=[1,2,3])`,
 *   `include(srcPath, { sectionTitle?, includeHeading?, stripFrontMatter? })`.
 * - **Blocks**: `p(text)`, `pTag\`tpl\``, `code(lang, ...lines)`, `codeTag(lang?)\`tpl\``,
 *   `ul(...items)`, `ol(...items)`, `table(headers, rows, align?)`, `quote(...lines)`,
 *   `hr()`, `br()` (soft break), `link(text,url,title?)`, `image(alt,url,title?)`,
 *   `bold/italic/strike/codeInline`.
 *
 * ### Rendering pipeline
 * - `content(path)` — get the assembled Markdown string (no I/O).
 * - `render(path, renderer, { lint?: "off" | "warn" | "error" })` — render and clear buffer.
 * - `renderAll(renderer, { lint })` — render all buffered docs.
 * - `writeAll()` — return `{ [path]: content }` and clear buffers (no I/O).
 *
 * ### Behavior notes
 * - Calling `section("X")` multiple times **appends** to section "X".
 * - `after("Y").section("X")` places section "X" immediately after "Y"; if "Y" doesn’t exist,
 *   it’s created as an empty placeholder (once content is added later, it will render).
 * - `frontMatterOnce()` guarantees only one front matter block per path.
 * - Headings written inside a section (via `title/h1..h6`) are tracked for `toc()`.
 */
export class MarkdownStore<I extends string> {
    constructor(opts?: {
        eol?: "\n" | "\r\n";
        anchors?: boolean; // emit <a id="slug"></a> before headings
        mdx?: boolean; // allow MDX/JSX helpers (raw already works)
        linter?: MarkdownLinter<I>; // optional linter hook
    }) {
        this.eol = opts?.eol ?? "\n";
        this.anchors = opts?.anchors ?? false;
        this.mdxEnabled = opts?.mdx ?? false;
        this.linter = opts?.linter;
    }

    private readonly eol: string;
    private readonly anchors: boolean;
    private readonly mdxEnabled: boolean;
    private readonly linter?: MarkdownLinter<I>;

    /** path -> document buffer (sections + order) */
    private readonly docs = new Map<I, DocBuf>();
    /** captured headings per path (for toc) */
    private readonly headings = new Map<
        I,
        Array<{ level: 1 | 2 | 3 | 4 | 5 | 6; text: string; id: string }>
    >();

    // --------- document/section plumbing (internal) ---------

    private ensureDoc(path: I): DocBuf {
        let doc = this.docs.get(path);
        if (!doc) {
            doc = {
                order: [ROOT_KEY],
                sections: new Map([[ROOT_KEY, { lines: [] }]]),
                titleToKey: new Map(),
                frontMatterEmitted: false,
            };
            this.docs.set(path, doc);
        }
        return doc;
    }

    private getSection(path: I, key: SectionKey): SectionBuf {
        const doc = this.ensureDoc(path);
        const sec = doc.sections.get(key);
        if (!sec) throw new Error(`Unknown section key: ${key}`);
        return sec;
    }

    private makeSlug(text: string): string {
        return text.toLowerCase().trim()
            .replace(/[_~`!@#$%^&*()+={}\[\]|\\;:'",.<>/?]+/g, "")
            .replace(/\s+/g, "-").replace(/^-+|-+$/g, "");
    }

    /** Ensure a named section exists and return its key; reusing the same title re-opens it. */
    protected ensureNamedSection(
        path: I,
        title: string,
        level: 1 | 2 | 3 | 4 | 5 | 6,
        id?: string,
        insertAfterKey?: SectionKey,
    ): SectionKey {
        const doc = this.ensureDoc(path);
        const existing = doc.titleToKey.get(title);
        if (existing) return existing;

        const computedId = id ?? this.makeSlug(title);
        // unique key from slug; disambiguate if needed
        const base = `sec:${computedId}`;
        let key = base;
        let n = 1;
        while (doc.sections.has(key)) key = `${base}-${n++}`;

        doc.titleToKey.set(title, key);
        doc.sections.set(key, { title, id: computedId, level, lines: [] });

        // insert in order
        if (insertAfterKey && doc.order.includes(insertAfterKey)) {
            const idx = doc.order.indexOf(insertAfterKey);
            doc.order.splice(idx + 1, 0, key);
        } else {
            doc.order.push(key);
        }

        // track for toc
        const list = this.headings.get(path) ?? [];
        list.push({ level, text: title, id: computedId });
        this.headings.set(path, list);

        return key;
    }

    /** Move an existing section directly after another section. */
    protected reorderSectionAfter(
        path: I,
        moveKey: SectionKey,
        afterKey: SectionKey,
    ): void {
        const doc = this.ensureDoc(path);
        if (!doc.order.includes(moveKey) || !doc.order.includes(afterKey)) {
            return;
        }
        const curIdx = doc.order.indexOf(moveKey);
        doc.order.splice(curIdx, 1);
        const afterIdx = doc.order.indexOf(afterKey);
        doc.order.splice(afterIdx + 1, 0, moveKey);
    }

    /** Append lines to a section (root by default). */
    protected pushTo(path: I, key: SectionKey, ...lines: string[]) {
        const sec = this.getSection(path, key);
        sec.lines.push(...lines);
    }

    /** Add a soft line-break (two spaces) to the last line of a section. */
    protected softBreak(path: I, key: SectionKey) {
        const sec = this.getSection(path, key);
        if (sec.lines.length === 0) {
            sec.lines.push("");
            return;
        }
        const last = sec.lines[sec.lines.length - 1] ?? "";
        sec.lines[sec.lines.length - 1] = last + "  ";
    }

    // -------------------- public buffer API --------------------

    /** Append raw lines to the root (unnamed) section. */
    storeMd(relPath: I, ...lines: string[]): this {
        this.pushTo(relPath, ROOT_KEY, ...lines);
        return this;
    }

    /** Concatenate all sections (in declared order) into final markdown text. */
    content(relPath: I): string {
        const doc = this.ensureDoc(relPath);
        const out: string[] = [];

        for (const key of doc.order) {
            const sec = doc.sections.get(key)!;
            if (key !== ROOT_KEY && sec.title && sec.level) {
                if (this.anchors && sec.id) out.push(`<a id="${sec.id}"></a>`);
                out.push(`${"#".repeat(sec.level)} ${sec.title}`, ""); // heading + blank line
            }
            if (sec.lines.length) out.push(...sec.lines);
            if (out.length && out[out.length - 1] !== "") out.push(""); // section separator
        }
        while (out.length && out[out.length - 1] === "") out.pop();
        return out.length ? out.join(this.eol) + this.eol : "";
    }

    clear(relPath: I): this {
        this.docs.delete(relPath);
        this.headings.delete(relPath);
        return this;
    }
    clearAll(): this {
        this.docs.clear();
        this.headings.clear();
        return this;
    }
    has(relPath: I): boolean {
        return this.docs.has(relPath);
    }
    size(): number {
        return this.docs.size;
    }
    paths(): I[] {
        return Array.from(this.docs.keys());
    }

    /** Materialize all buffers to a plain object and clear buffers (no I/O). */
    writeAll(): Record<string, string> {
        const out: Record<string, string> = {};
        for (const p of this.docs.keys()) out[p as string] = this.content(p);
        this.clearAll();
        return out;
    }

    /** Render a single path; runs linter if present (configurable). */
    async render<R>(
        relPath: I,
        renderer: MarkdownRenderer<I, R>,
        opts?: { lint?: "off" | "warn" | "error" },
    ): Promise<R> {
        const body = this.content(relPath);
        if (this.linter && opts?.lint !== "off") {
            const warnings = await this.linter.lint(relPath, body);
            if (warnings.length) {
                const msg = `Markdown lint for ${String(relPath)}:\n` +
                    warnings.map((w) => `- ${w}`).join("\n");
                if (opts?.lint === "error") throw new Error(msg);
                else console.warn(msg);
            }
        }
        this.clear(relPath);
        return await renderer.write(relPath, body);
    }

    /** Render all paths; runs linter if present. */
    async renderAll<R>(
        renderer: MarkdownRenderer<I, R>,
        opts?: { lint?: "off" | "warn" | "error" },
    ): Promise<Array<{ path: I; result: R }>> {
        const results: Array<{ path: I; result: R }> = [];
        for (const p of this.paths()) {
            const body = this.content(p);
            if (this.linter && opts?.lint !== "off") {
                const warnings = await this.linter.lint(p, body);
                if (warnings.length) {
                    const msg = `Markdown lint for ${String(p)}:\n` +
                        warnings.map((w) => `- ${w}`).join("\n");
                    if (opts?.lint === "error") throw new Error(msg);
                    else console.warn(msg);
                }
            }
            const result = await renderer.write(p, body);
            results.push({ path: p, result });
            this.clear(p);
        }
        return results;
    }

    // factory: return a fluent markdown builder bound to a path
    markdown(relPath: I): InstanceType<this["Markdown"]> {
        // deno-lint-ignore no-explicit-any
        return new this.Markdown(this, relPath) as any;
    }

    // ---------------- inner class: fluent MD builder ----------------

    Markdown = class Markdown {
        constructor(
            private readonly parent: MarkdownStore<I>,
            private readonly path: I,
        ) {}

        private current: SectionKey = ROOT_KEY; // active section
        private pendingAfterKey?: SectionKey; // for after(...).section(...)

        // section control

        /** Start or re-open a named section; subsequent calls with the same title append. */
        section(
            title: string,
            build?: (m: this) => void,
            level: 1 | 2 | 3 | 4 | 5 | 6 = 2,
            opts?: { id?: string },
        ) {
            const key = this.parent.ensureNamedSection(
                this.path,
                title,
                level,
                opts?.id,
                this.pendingAfterKey,
            );
            this.current = key;
            // if we specified after(...), clear it and ensure order if the section existed before
            if (this.pendingAfterKey) {
                this.parent.reorderSectionAfter(
                    this.path,
                    key,
                    this.pendingAfterKey,
                );
                this.pendingAfterKey = undefined;
            }
            if (build) build(this);
            return this;
        }

        /** Reorder the NEXT created/opened section to be after the given title (placeholder created if needed). */
        after(
            title: string,
            levelForPlaceholder: 1 | 2 | 3 | 4 | 5 | 6 = 2,
            opts?: { id?: string },
        ) {
            const doc = this.parent.ensureDoc(this.path);
            const exists = doc.titleToKey.get(title);
            const afterKey = exists ? exists : this.parent.ensureNamedSection(
                this.path,
                title,
                levelForPlaceholder,
                opts?.id,
            );
            this.pendingAfterKey = afterKey;
            return this;
        }

        /** Rename a section title (keeps or re-slugs id). */
        renameSection(
            oldTitle: string,
            newTitle: string,
            opts?: { keepId?: boolean },
        ) {
            const doc = this.parent.ensureDoc(this.path);
            const key = doc.titleToKey.get(oldTitle);
            if (!key) return this;
            doc.titleToKey.delete(oldTitle);
            doc.titleToKey.set(newTitle, key);
            const sec = doc.sections.get(key)!;
            sec.title = newTitle;
            if (!opts?.keepId) sec.id = this.makeSlug(newTitle);
            // update headings record
            const hs = this.parent.headings.get(this.path) ?? [];
            hs.forEach((h) => {
                if (h.id === sec.id || h.text === oldTitle) {
                    h.text = newTitle;
                    h.id = sec.id ?? h.id;
                }
            });
            this.parent.headings.set(this.path, hs);
            return this;
        }

        /** Remove a section and its content. */
        removeSection(title: string) {
            const doc = this.parent.ensureDoc(this.path);
            const key = doc.titleToKey.get(title);
            if (!key) return this;
            doc.titleToKey.delete(title);
            doc.sections.delete(key);
            doc.order = doc.order.filter((k) => k !== key);
            // remove related heading entries
            const hs = (this.parent.headings.get(this.path) ?? []).filter((h) =>
                h.text !== title
            );
            this.parent.headings.set(this.path, hs);
            if (this.current === key) this.current = ROOT_KEY;
            return this;
        }

        /** Switch back to the root (unnamed) section. */
        root() {
            this.current = ROOT_KEY;
            return this;
        }

        /** Append raw lines to the current section. */
        raw(...lines: string[]) {
            this.parent.pushTo(this.path, this.current, ...lines);
            return this;
        }

        // headings (ad-hoc, within current section)
        title(
            level: 1 | 2 | 3 | 4 | 5 | 6,
            text: string,
            opts?: { id?: string },
        ) {
            const id = opts?.id ?? this.makeSlug(text);
            if (this.parent.anchors) this.raw(`<a id="${id}"></a>`);
            this.rememberHeading(level, text, id);
            return this.raw(`${"#".repeat(level)} ${text}`, "");
        }
        h1(t: string, o?: { id?: string }) {
            return this.title(1, t, o);
        }
        h2(t: string, o?: { id?: string }) {
            return this.title(2, t, o);
        }
        h3(t: string, o?: { id?: string }) {
            return this.title(3, t, o);
        }
        h4(t: string, o?: { id?: string }) {
            return this.title(4, t, o);
        }
        h5(t: string, o?: { id?: string }) {
            return this.title(5, t, o);
        }
        h6(t: string, o?: { id?: string }) {
            return this.title(6, t, o);
        }

        // paragraphs & spacing
        p(text: string) {
            return this.raw(text, "");
        }
        pTag(strings: TemplateStringsArray, ...values: unknown[]) {
            return this.p(this.dedent(strings, ...values));
        }
        br() {
            this.parent.softBreak(this.path, this.current);
            return this;
        }
        hr() {
            return this.raw("---", "");
        }

        // emphasis & inline code
        bold(text: string) {
            return this.raw(`**${text}**`);
        }
        italic(text: string) {
            return this.raw(`*${text}*`);
        }
        strike(text: string) {
            return this.raw(`~~${text}~~`);
        }
        codeInline(text: string) {
            return this.raw("`" + text.replace(/`/g, "\\`") + "`");
        }

        // code blocks
        private fenceFor(lines: string[]): string {
            const max = Math.max(
                3,
                ...lines.map((l) => {
                    const matches = l.match(/`+/g);
                    const longest = matches
                        ? Math.max(...matches.map((s) => s.length))
                        : 0;
                    return longest;
                }),
            ) + 1;
            return "`".repeat(max);
        }
        code(lang: string | undefined, ...lines: string[]) {
            const body = lines.length ? lines : [""];
            const fence = this.fenceFor(body);
            return this.raw(`${fence}${lang ?? ""}`, ...body, fence, "");
        }
        codeTag(lang?: string) {
            return (strings: TemplateStringsArray, ...values: unknown[]) => {
                const body = this.dedent(strings, ...values);
                const lines = body.length ? body.split(/\r?\n/) : [""];
                return this.code(lang, ...lines);
            };
        }

        // MDX helpers (when enabled)
        mdx(expr: string) {
            if (!this.parent.mdxEnabled) return this;
            return this.raw(expr);
        }
        jsxTag() {
            return (strings: TemplateStringsArray, ...values: unknown[]) => {
                if (!this.parent.mdxEnabled) return this;
                const body = this.dedent(strings, ...values);
                return this.raw(body);
            };
        }

        // lists
        ul(...items: string[]) {
            items.forEach((it) => this.raw(`- ${it}`));
            return this.raw("");
        }
        ol(...items: string[]) {
            items.forEach((it, i) => this.raw(`${i + 1}. ${it}`));
            return this.raw("");
        }
        li(text: string, indent = 0, ordered = false, idx = 1) {
            const pad = "  ".repeat(indent);
            const bullet = ordered ? `${idx}.` : "-";
            return this.raw(`${pad}${bullet} ${text}`);
        }
        nested(indent: number, ordered = false, ...items: string[]) {
            items.forEach((it, i) => {
                const pad = "  ".repeat(indent);
                const b = ordered ? `${i + 1}.` : "-";
                this.raw(`${pad}${b} ${it}`);
            });
            return this.raw("");
        }
        checkbox(text: string, checked = false) {
            return this.raw(`- [${checked ? "x" : " "}] ${text}`);
        }

        // quotes
        quote(...lines: string[]) {
            if (!lines.length) return this.raw("> ");
            lines.forEach((l) => this.raw(`> ${l}`));
            return this.raw("");
        }

        // links & images
        link(text: string, url: string, title?: string) {
            return this.raw(
                title ? `[${text}](${url} "${title}")` : `[${text}](${url})`,
            );
        }
        image(alt: string, url: string, title?: string) {
            return this.raw(
                title ? `![${alt}](${url} "${title}")` : `![${alt}](${url})`,
            );
        }

        // tables
        private escCell(s: string) {
            return s.replaceAll("|", "\\|");
        }
        table(
            headers: string[],
            rows: Array<string[]>,
            align?: Array<"left" | "center" | "right" | "-">,
        ) {
            const colCount = headers.length;

            // Escape + normalize to a rectangular matrix (fill missing with "")
            const H = headers.map((c) => this.escCell(c));
            const R = rows.map((r) =>
                Array.from(
                    { length: colCount },
                    (_, i) => this.escCell(r?.[i] ?? ""),
                )
            );

            // Column widths (min 3 so the --- rule looks clean)
            const widths = Array.from(
                { length: colCount },
                (_, i) =>
                    Math.max(
                        3,
                        H[i]?.length ?? 0,
                        ...R.map((row) => row[i]?.length ?? 0),
                    ),
            );

            const aOf = (i: number): "left" | "center" | "right" | "-" =>
                (align && align[i]) ? align[i]! : "-";

            const pad = (
                s: string,
                w: number,
                a: "left" | "center" | "right" | "-",
            ) => {
                const len = s.length;
                if (len >= w) return s;
                const diff = w - len;
                if (a === "right") return " ".repeat(diff) + s;
                if (a === "center") {
                    const l = Math.floor(diff / 2);
                    const r = diff - l;
                    return " ".repeat(l) + s + " ".repeat(r);
                }
                // left or "-" (default)
                return s + " ".repeat(diff);
            };

            // Header line (padded per alignment for better monospace layout)
            const headerLine = H.map((c, i) => pad(c, widths[i], aOf(i))).join(
                " | ",
            );

            // Separator uses widths too, with proper colon placement for MD alignment
            const sepLine = widths.map((w, i) => {
                const a = aOf(i);
                const d = Math.max(3, w);
                if (a === "left") return ":" + "-".repeat(d - 1);
                if (a === "right") return "-".repeat(d - 1) + ":";
                if (a === "center") {
                    return ":" + "-".repeat(Math.max(1, d - 2)) + ":";
                }
                return "-".repeat(d); // "-"
            }).join(" | ");

            this.raw(`| ${headerLine} |`, `| ${sepLine} |`);

            // Body rows
            for (const r of R) {
                const line = r.map((c, i) => pad(c, widths[i], aOf(i))).join(
                    " | ",
                );
                this.raw(`| ${line} |`);
            }

            return this.raw("");
        }

        // front matter via stdlib YAML
        frontMatter(data: Record<string, unknown>) {
            const yaml = yamlStringify(data).trimEnd();
            return this.raw("---", yaml, "---", "");
        }
        /** Emit front matter only once per document (subsequent calls no-op). */
        frontMatterOnce(data: Record<string, unknown>) {
            const doc = this.parent.ensureDoc(this.path);
            if (doc.frontMatterEmitted) return this;
            doc.frontMatterEmitted = true;
            return this.frontMatter(data);
        }

        // toc from captured section/heading metadata (levels default 1..3)
        toc(levels: Array<1 | 2 | 3 | 4 | 5 | 6> = [1, 2, 3]) {
            const items = this.parent.headings.get(this.path) ?? [];
            const wanted = new Set(levels);
            items.filter((h) => wanted.has(h.level))
                .forEach((h) => {
                    const indent = "  ".repeat(h.level - 1);
                    this.raw(`${indent}- [${h.text}](#${h.id})`);
                });
            return this.raw("");
        }

        /** Include content from another path (optionally a single section). */
        include(
            srcPath: I,
            opts?: {
                sectionTitle?: string;
                includeHeading?: boolean;
                stripFrontMatter?: boolean;
            },
        ) {
            const srcDoc = this.parent.ensureDoc(srcPath);
            const lines: string[] = [];

            if (opts?.sectionTitle) {
                const key = srcDoc.titleToKey.get(opts.sectionTitle);
                if (!key) return this;
                const sec = srcDoc.sections.get(key)!;
                if (opts.includeHeading && sec.title && sec.level) {
                    if (this.parent.anchors && sec.id) {
                        lines.push(`<a id="${sec.id}"></a>`);
                    }
                    lines.push(`${"#".repeat(sec.level)} ${sec.title}`, "");
                }
                lines.push(...sec.lines);
            } else {
                // whole doc content
                const raw = this.parent.content(srcPath);
                const whole = opts?.stripFrontMatter
                    ? raw.replace(/^---\n[\s\S]*?\n---\n?/, "")
                    : raw;
                lines.push(...whole.split(/\r?\n/).filter((l) => l.length > 0)); // keep structure; trailing blank handled by raw("")
            }

            lines.forEach((l) => this.raw(l));
            return this.raw(""); // separator
        }

        // write the buffered doc and return its content (no I/O)
        write(): string {
            return this.parent.content(this.path);
        }

        // ---- helpers ----
        private rememberHeading(
            level: 1 | 2 | 3 | 4 | 5 | 6,
            text: string,
            id: string,
        ) {
            const list = this.parent.headings.get(this.path) ?? [];
            list.push({ level, text, id });
            this.parent.headings.set(this.path, list);
        }
        private makeSlug(text: string): string {
            return text.toLowerCase().trim().replace(
                /[_~`!@#$%^&*()+={}\[\]|\\;:'",.<>/?]+/g,
                "",
            ).replace(/\s+/g, "-").replace(/^-+|-+$/g, "");
        }
        private dedent(
            strings: TemplateStringsArray,
            ...values: unknown[]
        ): string {
            const raw = strings.reduce(
                (acc, s, i) =>
                    acc + s + (i < values.length ? String(values[i]) : ""),
                "",
            );
            const lines = raw.replace(/\r\n/g, "\n").split("\n");
            while (lines.length && lines[0].trim() === "") lines.shift();
            while (lines.length && lines[lines.length - 1].trim() === "") {
                lines.pop();
            }
            const indents = lines.filter((l) => l.trim().length > 0).map(
                (l) => (l.match(/^(\s*)/)?.[1].length ?? 0),
            );
            const trim = indents.length ? Math.min(...indents) : 0;
            return lines.map((l) => l.slice(trim)).join("\n");
        }
    };
}
