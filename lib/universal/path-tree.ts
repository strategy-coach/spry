// deno-lint-ignore no-explicit-any
type Any = any;

export async function pathTree<Node, Path extends string = string>(
    nodes: AsyncIterable<Node> | Iterable<Node>,
    options: {
        /** Extract the path string from a node */
        nodePath: (n: Node) => Path;
        /** Directory separator. Default: "/" */
        pathDelim?: string;
        /** Create container/folder nodes for missing intermediate directories. Default: true */
        synthesizeContainers?: boolean;
        /** Folder names to treat as "index" files under their container (e.g., 'index.sql', 'index.md'). Default: ['index', 'index.sql', 'index.md', 'index.html'] */
        indexBasenames?: string[];
        /** Put folders before files in sibling ordering (like `tree`). Default: true */
        folderFirst?: boolean;
        /** Optional custom sort for sibling nodes. If omitted, compares by (folderFirst?), then name, then path */
        compare?: (
            a: ReturnType<typeof mkNode>,
            b: ReturnType<typeof mkNode>,
        ) => number;
        /** Ensure paths are normalized as absolute (prepend delim if missing). Default: true */
        forceAbsolute?: boolean;
    },
) {
    // -----------------------------
    // Types local to this function
    // -----------------------------
    type P = Path;
    type N = Node;

    type PathTreeNode<PP extends string, NN> = {
        /** Full normalized path (e.g., "/a/b") */
        path: PP;
        /** Last segment (no delimiter) */
        name: string;
        /** Child nodes */
        children: PathTreeNode<PP, NN>[];
        /** Original nodes at this exact path (files or folders that have a record) */
        payloads?: NN[];
        /** True if synthesized as a container/folder to hold children */
        virtual?: true;
    };

    // -----------------------------
    // Options & defaults
    // -----------------------------
    const delim = options.pathDelim ?? "/";
    const synthesize = options.synthesizeContainers ?? true;
    const folderFirst = options.folderFirst ?? true;
    const forceAbs = options.forceAbsolute ?? true;
    const indexNames = (options.indexBasenames ?? [
        "index",
        "index.sql",
        "index.md",
        "index.html",
    ]).map((s) => s.toLowerCase());

    // -----------------------------
    // Helpers (returned to caller)
    // -----------------------------
    function escapeRegExp(s: string) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    const delimRe = new RegExp(`${escapeRegExp(delim)}+`, "g");

    function normalize(p: string): P {
        if (!p) return (delim as unknown) as P;
        let s = p.trim();

        // unify delimiters (collapse multiple)
        s = s.replace(delimRe, delim);

        // make absolute if desired
        if (forceAbs && !s.startsWith(delim)) s = delim + s;

        // strip trailing delim (except root)
        if (s.length > delim.length && s.endsWith(delim)) {
            s = s.slice(0, -delim.length);
        }

        // special case: empty becomes root
        if (!s.length) s = delim;

        return (s as unknown) as P;
    }

    function splitSegments(p: string): string[] {
        const np = normalize(p);
        // remove leading delim then split
        const body = np.startsWith(delim) ? np.slice(delim.length) : np;
        return body.length ? body.split(delim) : [];
    }

    function joinSegments(segments: string[]): P {
        const s = (forceAbs ? delim : "") + segments.join(delim);
        return (normalize(s) as unknown) as P;
    }

    function dirname(p: string): P {
        const segs = splitSegments(p);
        if (segs.length <= 1) return (delim as unknown) as P;
        return joinSegments(segs.slice(0, -1));
    }

    function basename(p: string): string {
        const segs = splitSegments(p);
        return segs.length ? segs[segs.length - 1] : delim;
        // for root, we use delim as name
    }

    function isContainerPath(p: string): boolean {
        // directory if last segment contains no '.'
        const name = basename(p);
        return name !== delim && !name.includes(".");
    }

    function isIndexFile(p: string): boolean {
        const name = basename(p).toLowerCase();
        return indexNames.includes(name);
    }

    // default comparator
    function defaultCompare(
        a: ReturnType<typeof mkNode>,
        b: ReturnType<typeof mkNode>,
    ) {
        if (folderFirst) {
            const af = isContainerPath(a.path);
            const bf = isContainerPath(b.path);
            if (af !== bf) return af ? -1 : 1;
        }
        // name, then path
        const n = a.name.localeCompare(b.name);
        return n || a.path.localeCompare(b.path);
    }

    const compare = options.compare ?? defaultCompare;

    // -----------------------------
    // Internal data structures
    // -----------------------------
    type NodeBucket = {
        path: P;
        items: N[]; // original nodes for this exact path
    };

    type NodeMap = Map<P, NodeBucket>;
    const buckets: NodeMap = new Map();

    function bucketFor(p: P): NodeBucket {
        let b = buckets.get(p);
        if (!b) {
            b = { path: p, items: [] };
            buckets.set(p, b);
        }
        return b;
    }

    function mkNode(payload: P, virtual?: true): PathTreeNode<P, N> {
        return {
            path: payload,
            name: basename(payload),
            children: [],
            ...(virtual ? { virtual: true as const } : null),
        };
    }

    // Tree node index by path
    const treeByPath = new Map<P, ReturnType<typeof mkNode>>();

    function ensureTreeNode(p: P, virtual?: true) {
        let node = treeByPath.get(p);
        if (!node) {
            node = mkNode(p, virtual);
            treeByPath.set(p, node);
        } else if (virtual && !node.virtual) {
            // keep existing real node preferred
        } else if (virtual && node.virtual) {
            // already virtual; nothing to do
        }
        return node;
    }

    // -----------------------------
    // Ingest nodes (async/sync)
    // -----------------------------
    const it = (nodes as AsyncIterable<N>)[Symbol.asyncIterator]
        ? (nodes as AsyncIterable<N>)
        : (async function* () {
            for (const x of nodes as Iterable<N>) yield x;
        })();

    for await (const item of it) {
        const p = normalize(options.nodePath(item) as unknown as string);
        const b = bucketFor(p);
        b.items.push(item);
    }

    // -----------------------------
    // Synthesize containers (dirs)
    // -----------------------------
    const ROOT = delim as unknown as P;

    if (synthesize) {
        for (const p of buckets.keys()) {
            // ensure parent chain exists
            let cur = dirname(p);
            while (cur !== (delim as unknown as P)) {
                bucketFor(cur); // create empty bucket for the container path
                cur = dirname(cur);
            }
        }

        // For index files, make sure their parent container is present (already handled above,
        // but keep explicit for clarity)
        for (const [p] of buckets) {
            if (isIndexFile(p)) {
                const dir = dirname(p);
                if (dir !== ROOT) bucketFor(dir); // <-- guard against ROOT
            }
        }
    }

    // -----------------------------
    // Build tree
    // -----------------------------
    // Create tree nodes for all paths in buckets
    for (const [p, b] of buckets) {
        const node = ensureTreeNode(
            p,
            (b.items.length === 0) ? (true as const) : undefined,
        );
        if (b.items.length) node.payloads = b.items;
    }

    // Link to parents
    const roots: ReturnType<typeof mkNode>[] = [];
    for (const [p, node] of treeByPath) {
        if (p === ROOT) continue; // <-- skip root node entirely
        const parentPath = dirname(p);
        const isRoot = parentPath === ROOT;
        if (isRoot || !treeByPath.has(parentPath)) {
            roots.push(node);
        } else {
            const parent = treeByPath.get(parentPath)!;
            if (parent !== node) parent.children.push(node);
            else roots.push(node); // defensive
        }
    }

    // Sort recursively
    (function sortRec(arr: ReturnType<typeof mkNode>[]) {
        arr.sort(compare);
        for (const c of arr) sortRec(c.children as Any);
    })(roots);

    /// Maps for fast lookups (you likely already build these nearby)
    const parentMap = new Map<P, P | null>(); // path -> parent container path (or null for roots)
    const itemToNodeMap = new Map<N, PathTreeNode<P, N>>(); // payload item -> owning tree node

    // Build/refresh maps after tree is constructed
    (function buildMaps(nodes: PathTreeNode<P, N>[], parentPath: P | null) {
        for (const node of nodes) {
            parentMap.set(node.path, parentPath);
            if (node.payloads) {
                for (const it of node.payloads) itemToNodeMap.set(it, node);
            }
            buildMaps(node.children, node.path);
        }
    })(roots, null);

    // Canonical path of a container node: prefer its index child if present
    function canonicalOf(node: PathTreeNode<P, N>): P {
        const idx = node.children.find((c) => isIndexFile(c.path));
        return (idx ? idx.path : node.path) as P;
    }

    // Compute the *breadcrumb parent path* for a given path (grandparent's canonical)
    // Returns undefined when there is no grandparent.
    function breadcrumbParentPathOf(path: P): P | undefined {
        const parentPath = parentMap.get(path);
        if (!parentPath) return undefined; // no parent container → no grandparent

        const grandparentPath = parentMap.get(parentPath as P);
        if (!grandparentPath) return undefined; // no grandparent

        const grandparentNode = treeByPath.get(grandparentPath as P);
        if (!grandparentNode) return undefined; // defensive

        return canonicalOf(grandparentNode);
    }

    /**
     * ancestry(item): return breadcrumb ancestry from root → target,
     * following the same rule as tabular.parentPath (grandparent's canonical).
     */
    function ancestry(item: N): PathTreeNode<P, N>[] {
        const start = itemToNodeMap.get(item);
        if (!start) return [];

        // Walk up via breadcrumb (grandparent canonical), collecting nodes
        const trail: PathTreeNode<P, N>[] = [];
        let current: PathTreeNode<P, N> | undefined = start;

        while (current) {
            trail.push(current);

            const nextPath = breadcrumbParentPathOf(current.path as P);
            if (!nextPath) break;

            const nextNode = treeByPath.get(nextPath);
            if (!nextNode || nextNode === current) break; // defensive against loops
            current = nextNode;
        }

        return trail.reverse(); // root → … → target
    }

    // -----------------------------
    // Flatten tree into tabular form (breadcrumb-aware, Node unconstrained)
    // -----------------------------
    function tabular(forest: PathTreeNode<P, N>[] = roots as Any) {
        type Row = {
            name: string;
            path: P;
            breadcrumbPath: P | undefined;
            containerIndexPath: P | null;
            virtual?: true;
            payload?: N;
        };

        const rows: Row[] = [];

        // For any container node, prefer its index child if present; otherwise use the container path.
        function canonicalOf(node: PathTreeNode<P, N>): P {
            const idx = node.children.find((c) => isIndexFile(c.path));
            return (idx ? idx.path : node.path) as P;
        }

        // walk with both parent and grandparent so we can compute breadcrumb parent easily
        function walk(
            node: PathTreeNode<P, N>,
            parent: PathTreeNode<P, N> | null,
            grandparent: PathTreeNode<P, N> | null,
        ) {
            // containerIndexPath: parent's canonical index path (or parent container path). null for roots.
            const containerIndexPath: P | null = parent
                ? (canonicalOf(parent) as P)
                : null;

            // parentPath (breadcrumb): grandparent's canonical index path (or grandparent container path). undefined if no grandparent.
            const parentPath: P | undefined = grandparent
                ? (canonicalOf(grandparent) as P)
                : undefined;

            if (node.payloads && node.payloads.length > 0) {
                // one row per payload item; payload kept under `item` (not flattened)
                for (const item of node.payloads) {
                    rows.push({
                        name: node.name,
                        path: node.path,
                        breadcrumbPath: parentPath,
                        containerIndexPath: containerIndexPath,
                        ...(node.virtual ? { virtual: true as const } : {}),
                        payload: item,
                    });
                }
            } else {
                // container (virtual or explicit) with no payload
                rows.push({
                    name: node.name,
                    path: node.path,
                    breadcrumbPath: parentPath,
                    containerIndexPath: containerIndexPath,
                    ...(node.virtual ? { virtual: true as const } : {}),
                });
            }

            for (const child of node.children) {
                walk(child, node, parent);
            }
        }

        for (const root of forest) {
            walk(root, null, null);
        }

        // Deterministic order: folders first, then by path
        rows.sort((a, b) => {
            const af = isContainerPath(a.path);
            const bf = isContainerPath(b.path);
            if (af !== bf) return af ? -1 : 1;
            return a.path.localeCompare(b.path);
        });

        return rows;
    }

    // -----------------------------
    // Pretty printer (tree-like)
    // -----------------------------
    function toString(
        forest: PathTreeNode<P, N>[] = roots as Any,
        opts: { showPath?: boolean; includeCounts?: boolean } = {},
    ): string {
        const showPath = opts.showPath ?? true;
        const includeCounts = opts.includeCounts ?? false;

        const lines: string[] = [];
        const render = (
            node: PathTreeNode<P, N>,
            prefix: string,
            isLast: boolean,
        ) => {
            const branch = isLast ? "└── " : "├── ";
            const count = includeCounts && node.payloads?.length
                ? ` (${node.payloads.length})`
                : "";
            const label = showPath ? `${node.name} [${node.path}]` : node.name;
            lines.push(`${prefix}${branch}${label}${count}`);
            const nextPrefix = prefix + (isLast ? "    " : "│   ");
            node.children.forEach((child, i, arr) =>
                render(child, nextPrefix, i === arr.length - 1)
            );
        };

        forest.forEach((r, i) => render(r, "", i === forest.length - 1));
        return lines.join("\n");
    }

    // -----------------------------
    // Final API
    // -----------------------------
    return {
        tree: () => (roots as unknown) as PathTreeNode<P, N>[],
        normalize,
        dirname,
        basename,
        isContainerPath,
        isIndexFile,
        ancestry,
        tabular,
        toString,
    };
}
