// File: lister-tree-ui.ts
// Deno: >= 2.0
//
// TreeLister: composable tree planner that wraps a ListerBuilder from lister-tui.ts
// and injects tree glyphs (│ ├── └──) as a prefix to your chosen column —
// without creating a separate "tree" column.
//
// Usage pattern (see examples at bottom):
//   import { ListerBuilder, SmartListerBuilder } from "./lister-tui.ts";
//   const base = new ListerBuilder<Row>()...;
//   await TreeLister.wrap(base)
//     .from(rows)
//     .byPath({ pathKey: "path" })
//     .treeOn("name")        // make "name" the first column with .select(...)
//     .dirFirst(true)
//     .ls(true);

import { gray } from "jsr:@std/fmt@1/colors";
import {
    humanSize,
    type Iterish,
    ListerBuilder,
    ObjectLister,
    SmartListerBuilder,
} from "./lister-tui.ts";

/* ------------------------------------------------------------------------------------------------
 * Types & helpers
 * ----------------------------------------------------------------------------------------------*/

type OrderMode = "preorder" | "postorder";

type ParentChildSpec<T, Id extends keyof T, ParentId extends keyof T> = {
    idKey: Id;
    parentIdKey: ParentId;
};

type PathSpec<T, K extends keyof T> = {
    pathKey: K;
    separator?: string; // default "/"
    isDir?: (row: T) => boolean; // optional dir hint used by dirFirst
};

type ResolverSpec<T> = {
    getId: (t: T) => PropertyKey;
    getParentId: (t: T) => PropertyKey | null | undefined;
};

type TreeGlyphs = {
    tee: string; // "├── "
    elbow: string; // "└── "
    pipe: string; // "│   "
    space: string; // "    "
};

const DEFAULT_GLYPHS = {
    tee: "├─ ",
    elbow: "└─ ",
    pipe: "│  ",
    space: "   ",
};

type Edge<T> = {
    node: T;
    depth: number;
    isLast: boolean;
    parentsLast: boolean[];
};

function isAsyncIterable<X>(i: Iterish<X>): i is AsyncIterable<X> {
    return typeof (i as { [Symbol.asyncIterator]?: () => AsyncIterator<X> })[
        Symbol.asyncIterator
    ] === "function";
}
const toAsync = async function* <X>(it: Iterish<X>) {
    if (isAsyncIterable(it)) {
        for await (const v of it) yield v;
    } else {
        for (const v of it as Iterable<X>) yield v;
    }
};

/* ------------------------------------------------------------------------------------------------
 * TreeLister
 * ----------------------------------------------------------------------------------------------*/

export class TreeLister<
    T,
    C extends Record<string, unknown>,
    I extends string = string,
> {
    private rows?: Iterish<T>;
    private spec:
        | { kind: "parentChild"; idKey: keyof T; parentIdKey: keyof T }
        | {
            kind: "path";
            pathKey: keyof T;
            separator: string;
            isDir?: (t: T) => boolean;
        }
        | {
            kind: "resolver";
            getId: (t: T) => PropertyKey;
            getParentId: (t: T) => PropertyKey | null | undefined;
        }
        | undefined;

    private mode: OrderMode = "preorder";
    private glyphs: TreeGlyphs = { ...DEFAULT_GLYPHS };
    private siblingSort?: (a: T, b: T) => number;
    private folderFirst = false;
    private maxDepth?: number;
    private expandFn?: (t: T, depth: number, pathIds: PropertyKey[]) => boolean;
    private orphanPolicy: "asRoot" | "drop" | "error" = "asRoot";
    private requireUnique = true;

    private treeColumnId?: I & string;
    private prefixColor = gray;

    // computed per render
    private prefix = new Map<T, string>();

    private constructor(
        private readonly builder: ListerBuilder<T, C, I>,
    ) {}

    /** Wrap your configured (but unbuilt) ListerBuilder. */
    static wrap<
        T,
        C extends Record<string, unknown>,
        I extends string = string,
    >(
        builder: ListerBuilder<T, C, I>,
    ) {
        return new TreeLister<T, C, I>(builder);
    }

    /** Provide the data to render. */
    from(rows: Iterish<T>) {
        this.rows = rows;
        return this;
    }

    /** Use (idKey, parentIdKey) to define hierarchy. */
    byParentChild<Id extends keyof T, ParentId extends keyof T>(
        spec: ParentChildSpec<T, Id, ParentId>,
    ) {
        this.spec = {
            kind: "parentChild",
            idKey: spec.idKey,
            parentIdKey: spec.parentIdKey,
        };
        return this;
    }

    /** Use string paths "a/b/c" with a separator (default "/"). */
    byPath<K extends keyof T>(spec: PathSpec<T, K>) {
        this.spec = {
            kind: "path",
            pathKey: spec.pathKey,
            separator: spec.separator ?? "/",
            isDir: spec.isDir,
        };
        return this;
    }

    /** Advanced: custom id/parentId resolver. */
    byResolver(spec: ResolverSpec<T>) {
        this.spec = {
            kind: "resolver",
            getId: spec.getId,
            getParentId: spec.getParentId,
        };
        return this;
    }

    /** Which column should the glyphs visually precede? (Make that column first via .select(...).) */
    treeOn(columnId: I & string) {
        this.treeColumnId = columnId;
        return this;
    }

    /** Show folders before files among siblings. */
    dirFirst(on = true) {
        this.folderFirst = on;
        return this;
    }

    /** Custom sibling sort, after any dir-first logic. */
    nodeSort(fn: (a: T, b: T) => number) {
        this.siblingSort = fn;
        return this;
    }

    /** Limit traversal depth (like `tree -L n`). */
    max(n: number) {
        this.maxDepth = n;
        return this;
    }

    /** Fine-grained expand rule (return false to collapse a node). */
    expand(fn: (t: T, depth: number, pathIds: PropertyKey[]) => boolean) {
        this.expandFn = fn;
        return this;
    }

    /** Unicode/ASCII glyph customization. */
    glyphsAs(g: Partial<TreeGlyphs>) {
        this.glyphs = { ...this.glyphs, ...g };
        return this;
    }

    /** Orphan handling for missing parents. */
    onOrphan(policy: "asRoot" | "drop" | "error") {
        this.orphanPolicy = policy;
        return this;
    }

    /** Duplicate id safety. */
    requireUniqueIds(on = true) {
        this.requireUnique = on;
        return this;
    }

    /** Color function for the prefix glyphs (default: gray). */
    colorizePrefix(fn: (s: string) => string) {
        this.prefixColor = fn;
        return this;
    }

    /** Preorder or postorder traversal. */
    order(mode: OrderMode) {
        this.mode = mode;
        return this;
    }

    /** Build and render using the wrapped builder. */
    async ls(print = true) {
        const l = await this.build();
        return await l.ls(print);
    }

    /** Build an ObjectLister that will render glyphs before the *first* visible column. */
    async build(): Promise<ObjectLister<T, C>> {
        if (!this.rows) throw new Error("[tree] .from(rows) is required.");
        if (!this.spec) {
            throw new Error(
                "[tree] call byPath(...), byParentChild(...), or byResolver(...) first.",
            );
        }

        // Materialize and compute ordering + prefixes
        const items: T[] = [];
        for await (const r of toAsync(this.rows)) items.push(r);

        const ordered = this.computeOrder(items); // fills this.prefix

        // NOTE: The glyphs are rendered via the builder's "icon" hook,
        // which appears to the left of the first visible column.
        // To place glyphs by a specific column, make that column first via builder.select(...).
        this.builder
            .from(ordered as Iterable<T>)
            .icon((row) => this.prefixColor(this.prefix.get(row) ?? ""));

        // (Optional) Warn if a tree column was specified but likely not first.
        if (this.treeColumnId) {
            // We can't introspect selection state from ListerBuilder (intentionally private),
            // so we provide a gentle runtime note if that id isn't commonly used as first.
            // Users should ensure .select(treeColumnId, ...) themselves.
            // (No-op here to keep the builder decoupled.)
        }

        return this.builder.build();
    }

    /* --------------------------- hierarchy & prefix --------------------------- */

    private computeOrder(items: T[]): T[] {
        // Build id / parentId / isDir resolution functions based on spec
        let getId: (t: T) => PropertyKey;
        let getParentId: (t: T) => PropertyKey | null | undefined;
        let isDirHint: ((t: T) => boolean) | undefined;

        if (this.spec?.kind === "parentChild") {
            const { idKey, parentIdKey } = this.spec;
            getId = (t) => t[idKey] as unknown as PropertyKey;
            getParentId = (t) =>
                t[parentIdKey] as unknown as PropertyKey | null | undefined;
        } else if (this.spec?.kind === "path") {
            const { pathKey, separator, isDir } = this.spec;
            getId = (t) => t[pathKey] as unknown as PropertyKey;
            getParentId = (t) => {
                const raw = t[pathKey] as unknown;
                const p = raw == null ? "" : String(raw);
                const idx = p.lastIndexOf(separator);
                if (idx <= 0) return ""; // treat as root child
                return p.slice(0, idx);
            };
            isDirHint = isDir;
        } else {
            getId = this.spec!.getId;
            getParentId = this.spec!.getParentId;
        }

        // Map ids and children
        const byId = new Map<PropertyKey, T>();
        for (const t of items) {
            const id = getId(t);
            if (this.requireUnique && byId.has(id)) {
                throw new Error(`[tree] Duplicate id detected: ${String(id)}`);
            }
            byId.set(id, t);
        }

        const children = new Map<PropertyKey, T[]>();
        const roots: T[] = [];
        for (const t of items) {
            const pid = getParentId(t);
            if (pid == null || pid === "" || !byId.has(pid)) {
                if (pid && !byId.has(pid)) {
                    if (this.orphanPolicy === "error") {
                        throw new Error(
                            `[tree] Orphan ${
                                String(getId(t))
                            } → missing parent ${String(pid)}`,
                        );
                    }
                    if (this.orphanPolicy === "drop") continue;
                }
                roots.push(t);
            } else {
                const arr = children.get(pid) ?? [];
                arr.push(t);
                children.set(pid, arr);
            }
        }

        // Sibling comparator
        const cmp = (a: T, b: T) => {
            if (this.folderFirst && isDirHint) {
                const da = !!isDirHint(a), db = !!isDirHint(b);
                if (da !== db) return da ? -1 : 1;
            }
            return this.siblingSort ? this.siblingSort(a, b) : 0;
        };

        // DFS with prefix building
        const out: T[] = [];
        this.prefix = new Map<T, string>();

        const walk = (
            node: T,
            depth: number,
            isLast: boolean,
            parentsLast: boolean[],
            pathIds: PropertyKey[],
        ) => {
            if (this.maxDepth != null && depth > this.maxDepth) return;

            // prefix for this node
            const edge: Edge<T> = { node, depth, isLast, parentsLast };
            this.prefix.set(node, this.renderPrefix(edge));

            if (this.mode === "preorder") out.push(node);

            // children
            const id = getId(node);
            const kids = (children.get(id) ?? []).slice().sort(cmp);
            const shouldExpand = this.expandFn
                ? this.expandFn(node, depth, pathIds)
                : true;
            if (shouldExpand) {
                const nextPath = pathIds.concat(getId(node));
                for (let i = 0; i < kids.length; i++) {
                    const k = kids[i];
                    const childIsLast = i === kids.length - 1;
                    const nextAnc = parentsLast.concat(childIsLast);
                    walk(k, depth + 1, childIsLast, nextAnc, nextPath);
                }
            }

            if (this.mode === "postorder") out.push(node);
        };

        roots.sort(cmp);
        for (let i = 0; i < roots.length; i++) {
            const r = roots[i];
            walk(r, 0, i === roots.length - 1, [], []);
        }

        return out;
    }

    private renderPrefix(e: Edge<T>) {
        if (e.depth === 0) return "";
        const parts: string[] = [];
        // ancestors (all but current level)
        for (let i = 0; i < e.parentsLast.length - 1; i++) {
            parts.push(e.parentsLast[i] ? this.glyphs.space : this.glyphs.pipe);
        }
        // current connector
        parts.push(e.isLast ? this.glyphs.elbow : this.glyphs.tee);
        return parts.join("");
    }
}

/* ------------------------------------------------------------------------------------------------
 * Examples (run this file directly)
 * ----------------------------------------------------------------------------------------------*/

type Doc = {
    id: string;
    title: string;
    kind: "report" | "note" | "spec";
    path: string; // e.g. "docs/2025/roadmap.md"
    bytes: number;
    updatedAt: Date | string | number;
    isDir?: boolean;
};

const docsData: Doc[] = [
    {
        id: "1",
        title: "docs",
        kind: "note",
        path: "docs",
        bytes: 0,
        isDir: true,
        updatedAt: "2025-09-18T09:30:00Z",
    },
    {
        id: "2",
        title: "2025",
        kind: "note",
        path: "docs/2025",
        bytes: 0,
        isDir: true,
        updatedAt: "2025-09-19T10:00:00Z",
    },
    {
        id: "3",
        title: "roadmap.md",
        kind: "report",
        path: "docs/2025/roadmap.md",
        bytes: 128_000,
        isDir: false,
        updatedAt: "2025-09-19T10:05:00Z",
    },
    {
        id: "4",
        title: "specs",
        kind: "spec",
        path: "docs/specs",
        bytes: 0,
        isDir: true,
        updatedAt: "2025-09-20T10:00:00Z",
    },
    {
        id: "5",
        title: "lister.md",
        kind: "spec",
        path: "docs/specs/lister.md",
        bytes: 7_321,
        isDir: false,
        updatedAt: "2025-09-21T11:25:00Z",
    },
];

if (import.meta.main) {
    // -------------------- 1) Plain ListerBuilder --------------------
    console.log(
        "\n" + "—".repeat(6) + " Plain ListerBuilder (flat) " + "—".repeat(6),
    );
    {
        type ColId = "name" | "kind" | "size" | "updated" | "path";
        const base = new ListerBuilder<Doc>()
            .declareColumns<ColId>("name", "kind", "size", "updated", "path")
            .from(docsData)
            .header(true)
            .compact(false);

        base
            .field("name", "title", { header: "NAME" })
            .field("kind", "kind", { header: "TYPE" })
            .numeric("size", (d) => d.bytes, {
                header: "SIZE",
                format: humanSize,
            })
            .date("updated", (d) => d.updatedAt, {
                header: "MODIFIED",
                format: (v) =>
                    new Date(v).toISOString().replace("T", " ").slice(0, 19),
            })
            .field("path", "path", { header: "PATH" })
            .select("name", "kind", "size", "updated", "path")
            .sortBy("name")
            .sortDir("asc");

        await base.build().ls(true);
    }

    // -------------------- 2) SmartListerBuilder --------------------
    console.log(
        "\n" + "—".repeat(6) + " SmartListerBuilder (auto) " + "—".repeat(6),
    );
    {
        const smart = SmartListerBuilder.fromRows(docsData);
        const b = await smart.toBuilder();
        // refine: put 'title' (auto-id "title") first, and show a few cols
        await b.select("title", "bytes", "updatedAt", "path").build().ls(true);
    }

    // -------------------- 3) TreeLister (by path, glyphs at NAME) --------------------
    console.log(
        "\n" + "—".repeat(6) + " TreeLister (by path) " + "—".repeat(6),
    );
    {
        type ColId = "name" | "size" | "updated" | "path";
        const base = new ListerBuilder<Doc>()
            .declareColumns<ColId>("name", "size", "updated", "path")
            .from(docsData)
            .header(true)
            .compact(false);

        base
            .field("name", "title", { header: "NAME" })
            .numeric("size", (d) => d.bytes, {
                header: "SIZE",
                format: humanSize,
            })
            .date("updated", (d) => d.updatedAt, {
                header: "MODIFIED",
                format: (v) =>
                    new Date(v).toISOString().replace("T", " ").slice(0, 19),
            })
            .field("path", "path", { header: "PATH" })
            // IMPORTANT: make the tree column first so glyphs appear next to it
            .select("name", "size", "updated", "path");

        const tree = TreeLister
            .wrap(base)
            .from(docsData)
            .byPath({
                pathKey: "path",
                separator: "/",
                isDir: (d) => !!d.isDir,
            })
            .treeOn("name") // designate which column the glyphs visually precede
            .dirFirst(true)
            .glyphsAs({
                tee: "├─ ",
                elbow: "└─ ",
                pipe: "│  ",
                space: "   ",
            });

        await tree.ls(true);
    }
}
