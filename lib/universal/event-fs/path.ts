import * as path from "jsr:@std/path@1/posix";

export type Brand<K, T extends string> = K & { readonly __brand: T };

export type RootLiteral = `/${string}`;
export type AbsCanonical = Brand<`/${string}`, "abs:canonical">;
export type RelCanonical = Brand<string, "rel:canonical">;

export interface PathPolicy {
    normalizeSeparators?: boolean;
    collapseDotSegments?: boolean;
    blockDotDot?: boolean;
    allowEmpty?: boolean;
    caseSensitive?: boolean;
}

export type Segment<S extends string> = S extends "" | "." | ".." ? never
    : S extends `${string}/${string}` ? never
    : S;

export function parseRel(input: string, policy: PathPolicy = {}): RelCanonical {
    const normalized = normalizeRelInternal(input, policy);
    if (normalized.startsWith("/")) {
        throw new Error("Absolute path not allowed for RelCanonical");
    }
    if ((policy.allowEmpty ?? false) === false && normalized.length === 0) {
        throw new Error("Empty relative path not allowed");
    }
    if (policy.blockDotDot ?? true) {
        const parts = normalized.split("/").filter((p) => p.length > 0);
        if (parts.includes("..")) {
            throw new Error("Relative path may not contain '..'");
        }
    }
    return normalized as RelCanonical;
}

export function parseAbs(input: string): AbsCanonical {
    if (!input.startsWith("/")) {
        throw new Error("Absolute path must start with '/'");
    }
    const n = path.normalize(input);
    const collapsed = collapseDotSegmentsAbs(n);
    return (collapsed === "" ? "/" : collapsed) as AbsCanonical;
}

export type ForbidAbs<S extends string> = S extends `/${string}` ? never : S;
export type ForbidDotDot<S extends string> = S extends `${string}..${string}`
    ? never
    : S extends ".." ? never
    : S;

export function relLit<const S extends string>(
    s: ForbidDotDot<ForbidAbs<S>>,
): RelCanonical {
    return parseRel(s);
}

export function joinRel(
    base: RelCanonical,
    ...kids: RelCanonical[]
): RelCanonical {
    const pieces = [base, ...kids].filter((p) => p.length > 0).join("/");
    return parseRel(pieces);
}

export function child<
    P extends RelCanonical,
    const S extends string,
>(base: P, name: Segment<S>): RelCanonical {
    return parseRel(`${base}/${name}`);
}

export function toAbs(root: RootLiteral, rel: RelCanonical): AbsCanonical {
    // path.join collapses dot-segments; parseAbs ensures canonical absolute
    return parseAbs(path.join(root, rel));
}

export function normalizeAbsInternal(input: string): AbsCanonical {
    return parseAbs(input);
}

export function normalizeRelInternal(
    input: string,
    policy: PathPolicy = {},
): string {
    const sepNorm = policy.normalizeSeparators ?? true;
    const collapse = policy.collapseDotSegments ?? true;
    const s = sepNorm ? input.replaceAll("\\", "/") : input;
    const withLead = s.startsWith("/") ? s : `/${s}`;
    const normalized = path.normalize(withLead);
    const withoutLead = normalized.startsWith("/")
        ? normalized.slice(1)
        : normalized;
    const collapsed = collapse
        ? collapseDotSegmentsRel(withoutLead)
        : withoutLead;
    return collapsed;
}

function collapseDotSegmentsRel(p: string): string {
    const parts = p.split("/").filter((seg) => seg.length > 0);
    const out: string[] = [];
    for (const seg of parts) {
        if (seg === ".") continue;
        if (seg === "..") {
            if (out.length > 0) out.pop();
            else out.push("..");
            continue;
        }
        out.push(seg);
    }
    return out.join("/");
}

function collapseDotSegmentsAbs(p: string): string {
    const parts = p.split("/").filter((seg) => seg.length > 0);
    const out: string[] = [];
    for (const seg of parts) {
        if (seg === "." || seg === "") continue;
        if (seg === "..") {
            if (out.length > 0) out.pop();
            continue;
        }
        out.push(seg);
    }
    return `/${out.join("/")}`;
}

/**
 * Hardened containment check: compares canonicalized absolute paths using
 * posix.relative. True iff `abs` is the same as `root` or inside it.
 */
export function isInsideRoot(
    abs: AbsCanonical,
    root: RootLiteral,
    policy: PathPolicy = {},
): boolean {
    // Canonicalize both sides (ensures ".." are collapsed before compare)
    const A = parseAbs(abs);
    const R = parseAbs(root);
    const rel = path.relative(R, A);
    // If relative is absolute or climbs up, it's outside.
    const outside = rel === ""
        ? false
        : rel.startsWith("..") || rel.startsWith("/");
    if (policy.caseSensitive === false) {
        // Lowercase compare for case-insensitive filesystems
        const relLc = path.relative(
            R.toLowerCase() as RootLiteral,
            A.toLowerCase() as AbsCanonical,
        );
        return !(relLc === ""
            ? false
            : relLc.startsWith("..") || relLc.startsWith("/"));
    }
    return !outside;
}

export function relativeToRoot(
    abs: AbsCanonical,
    root: RootLiteral,
    _policy: PathPolicy = {},
): RelCanonical {
    const A = parseAbs(abs);
    const R = parseAbs(root);
    const rel = path.relative(R, A);
    if (rel === "") return "" as RelCanonical;
    if (rel.startsWith("..") || rel.startsWith("/")) {
        throw new Error(`Path ${A} not inside root ${R}`);
    }
    return parseRel(rel, { allowEmpty: true, blockDotDot: true });
}
