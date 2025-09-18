// deno-lint-ignore no-explicit-any
type Any = any;

// Omit specific paths during JSON.stringify (paths like ["a","b","c"] or ["users", 3, "password"])
export const omitPathsReplacer = <T extends object>(
    root: T,
    paths: (Array<string | number>)[],
) => {
    const parents = new WeakMap<
        object,
        { parent: object | null; key: string | number | null }
    >();

    // Pre-walk to capture parent/key links for all objects/arrays
    (function walk(
        node: Any,
        parent: object | null,
        key: string | number | null,
    ) {
        if (node && typeof node === "object" && !parents.has(node)) {
            parents.set(node, { parent, key });
            if (Array.isArray(node)) node.forEach((v, i) => walk(v, node, i));
            else {for (const k of Object.keys(node)) {
                    walk((node as Any)[k], node, k);
                }}
        }
    })(root, null, null);

    const targets = paths.map((p) => p.map(String)); // normalize to strings

    return function replacer(this: Any, key: string, value: unknown) {
        if (key === "") return value; // root
        // Reconstruct full path to current property using the parent map
        const segs: string[] = [key];
        // deno-lint-ignore no-this-alias
        let holder: Any = this;
        while (holder && parents.has(holder)) {
            const info = parents.get(holder)!;
            if (info.key != null) segs.push(String(info.key));
            holder = info.parent;
        }
        segs.reverse(); // now root → ... → key

        const shouldOmit = targets.some((p) =>
            p.length === segs.length && p.every((s, i) => s === segs[i])
        );
        return shouldOmit ? undefined : value;
    };
};
