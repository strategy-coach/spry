// deno-lint-ignore no-explicit-any
type Any = any;

export async function pathTree<Node, Path extends string = string>(
  payloadsSupplier: AsyncIterable<Node> | Iterable<Node>,
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
    basename: string;
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
    const n = a.basename.localeCompare(b.basename);
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
      basename: basename(payload),
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
  const payloads = (payloadsSupplier as AsyncIterable<N>)[Symbol.asyncIterator]
    ? (payloadsSupplier as AsyncIterable<N>)
    : (async function* () {
      for (const x of payloadsSupplier as Iterable<N>) yield x;
    })();

  for await (const payload of payloads) {
    const p = normalize(options.nodePath(payload) as unknown as string);
    const b = bucketFor(p);
    b.items.push(payload);
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

  // -----------------------------
  // Final API
  // -----------------------------
  return {
    roots,
    normalize,
    dirname,
    basename,
    isContainerPath,
    isIndexFile,
    treeByPath,
    parentMap,
    itemToNodeMap,
    canonicalOf,
  };
}

// If JSON schema was provided by ZOD then there are $defs in the wrong
// place for custom payload JSON schema. This hoists every non-root
// $defs up to schema.$defs (root wins on key collisions) and deletes
// the nested $defs. Also removes any non-root $schema keys.
export function fixupZodSchemaMerges(candidate: Any) {
  return ((s: Any) => {
    const r = (o: Any, root: boolean) => {
      if (o && typeof o === "object") {
        if (!root && o.$schema) delete o.$schema;
        if (!root && o.$defs) {
          s.$defs = { ...(s.$defs || {}), ...o.$defs };
          delete o.$defs;
        }
        (Array.isArray(o) ? o : Object.values(o)).forEach((v) => r(v, false));
      }
    };
    r(s, true);
    return s;
  })(candidate);
}

export function pathTreeNavigation<Node, Path extends string = string>(
  forest: Awaited<ReturnType<typeof pathTree<Node, Path>>>,
) {
  /**
   * Compute a breadcrumb trail for a given route payload by walking
   * container-to-container from the item’s owning node up to the root.
   *
   * How it works:
   * - Starts at the node that owns `item` and coerces it to its container path
   *   if it’s a file (so crumbs are always folder/container nodes).
   * - Climbs parents using `forest.parentMap`, collecting nodes until there is
   *   no parent. Order is root → … → container that owns `item`.
   * - Each crumb includes three link variants to support different routing styles:
   *   - `hrefs.canonical`: the container path as-is.
   *   - `hrefs.index`: the first index child path if present
   *     (matches `forest.isIndexFile`, e.g. index, index.sql, index.md, index.html),
   *     otherwise omitted.
   *   - `hrefs.trailingSlash`: the container path with a trailing slash added
   *     (never duplicates “//”, root stays “/”).
   *
   * Why container nodes:
   * - Container nodes own `children`, files do not. Returning containers ensures
   *   `node.children` is populated for each breadcrumb level.
   *
   * Usage to render breadcrumbs:
   * - Prefer `hrefs.index` when present (link to the index page).
   * - Otherwise choose between `hrefs.canonical` or `hrefs.trailingSlash`
   *   depending on your router’s expectations.
   *
   * Edge cases:
   * - If `item` is not found in `forest.itemToNodeMap`, returns an empty array.
   * - Root-level breadcrumb uses “/” as both `canonical` and `trailingSlash`.
   *
   * Complexity: O(tree depth) for a single item.
   *
   * @param item The route payload whose container ancestry is used to build breadcrumbs.
   * @returns An array of crumbs from root to the item’s owning container. Each element:
   *   {
   *     node: PathTreeNode;               // container-level node (has children)
   *     hrefs: {
   *       canonical: string;              // container path as-is
   *       index?: string;                 // index child path if available
   *       trailingSlash: string;          // container path with trailing slash
   *     };
   *   }
   *
   * @example
   * // Build breadcrumb links (label = folder name, href prefers index)
   * const crumbs = ancestors(routeItem);
   * const links = crumbs.map(({ node, hrefs }) => ({
   *   label: node.basename,
   *   href: hrefs.index ?? hrefs.canonical, // or hrefs.trailingSlash for slash-terminated routing
   * }));
   * // Render links in UI...
   */
  function ancestors(item: Node) {
    const asContainer = (p: string) =>
      (forest.isContainerPath(p) ? p : forest.dirname(p)) as Path;
    const withSlash = (p: string) =>
      (p === "/" || p.endsWith("/")) ? p : `${p}/`;

    const start = forest.itemToNodeMap.get(item);
    if (!start) return [];

    const crumbs: Array<{
      node: (typeof forest)["roots"][number];
      hrefs: { canonical: string; index?: string; trailingSlash: string };
    }> = [];

    let curPath: Path | undefined = asContainer(start.path);

    while (curPath) {
      const curNode = forest.treeByPath.get(curPath) as
        | (typeof forest)["roots"][number]
        | undefined;
      if (!curNode) break;

      // pick any configured index child if present
      const idxChild = curNode.children.find((c) => forest.isIndexFile(c.path));

      crumbs.push({
        node: curNode,
        hrefs: {
          canonical: curNode.path, // as-is container path
          index: idxChild?.path, // index file path (if available)
          trailingSlash: withSlash(curNode.path), // container path with trailing slash
        },
      });

      const parentContainerPath = (forest.parentMap.get(curPath) as
        | string
        | null
        | undefined) as Path;
      if (!parentContainerPath) break;
      curPath = parentContainerPath;
    }

    return crumbs.reverse();
  }

  /**
   * Emit a JSON Schema (Draft 2020-12) describing the structure returned by `ancestors(...)`.
   *
   * By default the schema represents an array of crumbs:
   *   [ { node, hrefs }, ... ]
   *
   * If `options.outerIsMap === true`, the outer container is an object whose values
   * are arrays of crumbs, e.g.:
   *   {
   *     "/docs/page": [ { node, hrefs }, ... ],
   *     "/about":     [ { node, hrefs }, ... ]
   *   }
   *
   * Options:
   *  - includePayloads?: boolean       Include `payloads` in the node schema (default false)
   *  - payloadItemSchema?: unknown     JSON Schema for each payload item when included (default {})
   *  - title?: string                  Optional schema title
   *  - outerIsMap?: boolean            If true, outer schema is an object mapping to arrays of crumbs
   */
  function ancestorsJsonSchema(options?: {
    includePayloads?: boolean;
    payloadItemSchema?: unknown;
    title?: string;
    outerIsMap?: boolean;
  }): Record<string, unknown> {
    const includePayloads = options?.includePayloads ?? false;
    const payloadItemSchema = options?.payloadItemSchema ?? {};
    const title = options?.title ??
      (options?.outerIsMap
          ? "PathTree Breadcrumbs Map"
          : "PathTree Breadcrumbs") +
        ` (TODO: review this JSON Schema, it's actually broken and not working)`;

    // Recursive TreeNode schema (container-level node)
    const treeNodeSchema: Any = {
      $id: "#/$defs/TreeNode",
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        basename: { type: "string" },
        virtual: { const: true },
        children: {
          type: "array",
          items: { $ref: "#/$defs/TreeNode" },
        },
      },
      required: ["path", "basename", "children"],
    };

    if (includePayloads) {
      treeNodeSchema.properties.payloads = {
        type: "array",
        items: payloadItemSchema,
      };
    }

    const crumbSchema = {
      $id: "#/$defs/Crumb",
      type: "object",
      additionalProperties: false,
      properties: {
        node: { $ref: "#/$defs/TreeNode" },
        hrefs: {
          type: "object",
          additionalProperties: false,
          properties: {
            canonical: { type: "string" },
            index: { type: "string" },
            trailingSlash: { type: "string" },
          },
          required: ["canonical", "trailingSlash"],
        },
      },
      required: ["node", "hrefs"],
    };

    // Choose outer container: array of crumbs vs. map<string, array of crumbs>
    const root = options?.outerIsMap
      ? {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        title,
        type: "object",
        additionalProperties: {
          type: "array",
          items: { $ref: "#/$defs/Crumb" },
        },
        $defs: { TreeNode: treeNodeSchema, Crumb: crumbSchema },
      }
      : {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        title,
        type: "array",
        items: { $ref: "#/$defs/Crumb" },
        $defs: { TreeNode: treeNodeSchema, Crumb: crumbSchema },
      };

    return fixupZodSchemaMerges(root);
  }

  return { ancestors, ancestorsJsonSchema };
}

export function pathTreeSerializers<Node, Path extends string = string>(
  forest: Awaited<ReturnType<typeof pathTree<Node, Path>>>,
) {
  function asciiTreeText(
    opts: { showPath?: boolean; includeCounts?: boolean } = {},
  ) {
    const showPath = opts.showPath ?? true;
    const includeCounts = opts.includeCounts ?? false;

    const lines: string[] = [];
    const render = (
      node: (typeof forest.roots)[number],
      prefix: string,
      isLast: boolean,
    ) => {
      const branch = isLast ? "└── " : "├── ";
      const count = includeCounts && node.payloads?.length
        ? ` (${node.payloads.length})`
        : "";
      const label = showPath
        ? `${node.basename} [${node.path}]`
        : node.basename;
      lines.push(`${prefix}${branch}${label}${count}`);
      const nextPrefix = prefix + (isLast ? "    " : "│   ");
      node.children.forEach((child, i, arr) =>
        render(child, nextPrefix, i === arr.length - 1)
      );
    };

    forest.roots.forEach((r, i) =>
      render(r, "", i === forest.roots.length - 1)
    );
    return lines.join("\n");
  }

  /**
   * Serialize the full forest or a subtree to JSON text.
   *
   * options:
   *  - path?: Path                   -> if provided, returns that subtree (or null if not found)
   *  - space?: number | string       -> pretty-print spacing
   *  - includePayloads?: boolean     -> include payload arrays (default true)
   *  - payloadMapper?: (p: Node) => unknown
   *       Per-item transform; applied to each payload if provided.
   *  - payloadsSerializer?: (arr: Node[]) => unknown
   *       Whole-array transform; takes precedence over payloadMapper if both are set.
   */
  function jsonText(options?: {
    path?: Path;
    space?: number | string;
    includePayloads?: boolean;
    payloadMapper?: (p: Node) => unknown;
    payloadsSerializer?: (arr: Node[]) => unknown;
  }) {
    const includePayloads = options?.includePayloads ?? true;

    const serializePayloads = (arr?: Node[]) => {
      if (!includePayloads || !arr) return undefined;
      if (options?.payloadsSerializer) {
        return options.payloadsSerializer(arr);
      }
      if (options?.payloadMapper) {
        return arr.map(options.payloadMapper);
      }
      return arr; // default: raw payloads (JSON does the rest)
    };

    const toJson = (n: {
      path: Path;
      basename: string;
      virtual?: true;
      children: Any[];
      payloads?: Node[];
    }): Any => ({
      path: n.path,
      basename: n.basename,
      ...(n.virtual ? { virtual: true as const } : null),
      ...(serializePayloads(n.payloads) !== undefined
        ? { payloads: serializePayloads(n.payloads) }
        : null),
      children: (n.children as typeof n[]).map(toJson),
    });

    if (options?.path) {
      const key = forest.normalize(
        options.path as unknown as string,
      ) as Path;
      const node = forest.treeByPath.get(key);
      return JSON.stringify(
        node ? toJson(node as Any) : null,
        null,
        options?.space,
      );
    }

    const rootsJson = (forest.roots as Any[]).map((r) => toJson(r));
    return JSON.stringify(rootsJson, null, options?.space);
  }

  /**
   * Emit a JSON Schema (Draft 2020-12) describing the structure produced by jsonText().
   *
   * options:
   *  - path?: Path                    -> schema for a single subtree (object|null) instead of array
   *  - includePayloads?: boolean      -> whether "payloads" appears (default true)
   *  - payloadItemSchema?: unknown    -> JSON Schema for each payload item (default: {})
   *  - title?: string                 -> optional schema title
   */
  function jsonSchemaText(options?: {
    path?: Path;
    includePayloads?: boolean;
    payloadItemSchema?: unknown;
    title?: string;
  }): string {
    const includePayloads = options?.includePayloads ?? true;
    const payloadItemSchema = options?.payloadItemSchema ?? {};

    const treeNodeSchema: Any = {
      $id: "#/$defs/TreeNode",
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        basename: { type: "string" },
        virtual: { const: true },
        children: {
          type: "array",
          items: { $ref: "#/$defs/TreeNode" },
        },
      },
      required: ["path", "basename", "children"],
    };

    if (includePayloads) {
      treeNodeSchema.properties.payloads = {
        type: "array",
        items: payloadItemSchema, // caller can describe payloads precisely
      };
    }

    const rootSchema = options?.path
      ? {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        title: options?.title ?? "PathTree Subtree",
        type: ["object", "null"],
        oneOf: [{ $ref: "#/$defs/TreeNode" }, { type: "null" }],
        $defs: { TreeNode: treeNodeSchema },
      }
      : {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        title: options?.title ?? "PathTree Forest",
        type: "array",
        items: { $ref: "#/$defs/TreeNode" },
        $defs: { TreeNode: treeNodeSchema },
      };

    const canonicalSchema = fixupZodSchemaMerges(rootSchema);

    return JSON.stringify(canonicalSchema, null, 2);
  }

  return { asciiTreeText, jsonText, jsonSchemaText };
}

/**
 * Convert a forest (with multiple roots) into a flat edge list.
 * - Each edge uses canonical route paths like "spry/console/index.sql" (no leading slash).
 * - For a directory node, its "own index route" is taken from a child whose basename === "index.sql".
 * - Edges:
 *   1) parentDirIndex → dirIndex (for the child whose basename is "index.sql")
 *   2) dirIndex       → other child payload routes in that directory
 */
export function forestToEdges<Node, Path extends string = string>(
  forest: Awaited<ReturnType<typeof pathTree<Node, Path>>>,
) {
  const edges: { parent: string; child: string }[] = [];
  const seen = new Set<string>(); // dedupe using `${parent}→${child}`

  const norm = (p?: string | null) => (p ?? "").replace(/^\/+/, ""); // drop any leading '/'

  // Extract the root index route if present (e.g., "index.sql")
  const rootIndexRoute = (() => {
    const roots = Array.isArray(forest?.roots) ? forest.roots : [];
    for (const n of roots) {
      if (
        typeof n?.basename === "string" &&
        n.basename.toLowerCase() === "index.sql"
      ) {
        const pp = n?.path;
        if (typeof pp === "string") return norm(pp);
      }
    }
    return null as string | null;
  })();

  // Return the canonical "index" route for a node (directory or file), or null
  const getIndexRoute = (node: Any): string | null => {
    // If the node itself is an index.sql (file node)
    if (
      typeof node?.basename === "string" &&
      node.basename.toLowerCase() === "index.sql"
    ) {
      const pp = node?.payloads?.[0]?.path;
      return typeof pp === "string" ? norm(pp) : null;
    }
    // Else, look for a child that is index.sql and use its payload path
    const kids = Array.isArray(node?.children) ? node.children : [];
    for (const k of kids) {
      if (
        typeof k?.basename === "string" &&
        k.basename.toLowerCase() === "index.sql"
      ) {
        const pp = k?.payloads?.[0]?.path;
        if (typeof pp === "string") return norm(pp);
      }
    }
    return null;
  };

  // Collect all payload route paths for a node (usually 0 or 1; can be more)
  const getPayloadRoutes = (node: Any): string[] => {
    const ps = Array.isArray(node?.payloads) ? node.payloads : [];
    const out: string[] = [];
    for (const p of ps) {
      if (typeof p?.path === "string") out.push(norm(p.path));
    }
    return out;
  };

  const addEdge = (parent: string | null, child: string | null) => {
    if (!parent || !child) return;
    if (parent === child) return; // avoid self-edges
    const key = `${parent}→${child}`;
    if (!seen.has(key)) {
      seen.add(key);
      edges.push({ parent, child });
    }
  };

  // Depth-first traversal
  const walk = (node: Any, parentIndex: string | null) => {
    const ownIndex = getIndexRoute(node);
    const children = Array.isArray(node?.children) ? node.children : [];

    // emit edges for each child node's payloads
    for (const childNode of children) {
      const childIndex = getIndexRoute(childNode);
      const childPayloads = getPayloadRoutes(childNode);

      // Case 1: child is the directory index (basename === "index.sql")
      //         Link it upward to *this* node's parentIndex.
      if (childIndex) {
        addEdge(parentIndex, childIndex);
      }

      // Case 2: other child payload routes link from this directory's own index
      for (const ch of childPayloads) {
        if (childIndex && ch === childIndex) {
          // Already linked upward in Case 1
        } else {
          addEdge(ownIndex ?? parentIndex, ch);
        }
      }

      // Recurse: the child's own index becomes the parent for its subtree
      walk(childNode, childIndex ?? ownIndex ?? parentIndex);
    }
  };

  // Kick off from each root; top-level parent is the root index route (if any)
  const roots = Array.isArray(forest?.roots) ? forest.roots : [];
  for (const root of roots) {
    // If the root is itself an index.sql (a file), it has no parent; skip linking it upward.
    const isRootIndex = typeof root?.basename === "string" &&
      root.basename.toLowerCase() === "index.sql";

    // For directory roots, link their index.sql up to the global root index (if present)
    // The generic walk logic handles this via parentIndex passed down.
    walk(root, isRootIndex ? null : rootIndexRoute);
  }

  return edges;
}
