// deno-lint-ignore no-explicit-any
type Any = any;

// lint.ts
/* Lightweight, dependency-free, strongly-typed lint results store */

export type Severity = "error" | "warn" | "info" | "hint" | "off";
export type NonOffSeverity = Exclude<Severity, "off">;

export interface TextRange {
    start: number;
    end: number;
}
export interface ContentRef<Meta = unknown> {
    id: string; // path, URL, DB key, etc.
    uri?: string;
    hash?: string;
    version?: string;
    meta?: Meta;
}

/* ─────────────────────────  Registry helpers (literal-safe)  ───────────────────────── */

export type RuleDef<C extends string = string, D = unknown, F = unknown> = {
    code: readonly C[] | C; // unions via array or single string literal
    data?: D; // rule-specific "data" type
    fix?: F; // rule-specific "fix" type
    defaultSeverity?: Severity;
};

/** Preserve literal unions at declaration sites. */
export const defineRule = <
    const C extends string,
    D = unknown,
    F = unknown,
>(spec: RuleDef<C, D, F>) => spec;

/** Preserve literal keys and inferred unions for the whole registry. */
export const defineRegistry = <
    const R extends Record<string, RuleDef<Any, Any, Any>>,
>(reg: R) => reg;

/** Single, simple constraint used everywhere else. */
export type Registry = Record<string, RuleDef<Any, Any, Any>>;
export type RuleIds<R extends Registry> = Extract<keyof R, string>;

/* —— Key fix: extract generics directly from RuleDef via infer — */
type _CodeOfRule<T> = T extends RuleDef<infer C, Any, Any> ? C : never;
type _DataOfRule<T> = T extends RuleDef<Any, infer D, Any> ? D : unknown;
type _FixOfRule<T> = T extends RuleDef<Any, Any, infer F> ? F : unknown;

export type CodeOf<R extends Registry, K extends RuleIds<R>> = _CodeOfRule<
    R[K]
>;
export type DataOf<R extends Registry, K extends RuleIds<R>> = _DataOfRule<
    R[K]
>;
export type FixOf<R extends Registry, K extends RuleIds<R>> = _FixOfRule<R[K]>;

/* ─────────────────────────  Core shapes (TS-only)  ───────────────────────── */

export interface FindingInput<
    R extends Registry,
    K extends RuleIds<R> = RuleIds<R>,
    Tag extends string = string,
    Payload = Record<string, unknown>,
> {
    rule: K;
    code: CodeOf<R, K>;
    severity: Severity; // "off" accepted on input (ignored during add)
    content: string; // canonical identifier (file path, URL, etc.)
    message: string;
    range?: TextRange;
    data?: DataOf<R, K>;
    fix?: FixOf<R, K>;
    tags?: readonly Tag[];
    payload?: Payload; // flexible extension bag
}

/** Stored findings always have a non-"off" severity. */
export interface FindingStored<
    R extends Registry,
    K extends RuleIds<R> = RuleIds<R>,
    Tag extends string = string,
    ContentMeta = unknown,
    RunMeta = unknown,
    Payload = Record<string, unknown>,
> extends Omit<FindingInput<R, K, Tag, Payload>, "content" | "severity"> {
    id: string; // deterministic
    content: string;
    severity: NonOffSeverity;
    runId: string;
    contentRef?: ContentRef<ContentMeta>;
    runMeta?: RunMeta;
}

export type NarrowFinding<
    R extends Registry,
    K extends RuleIds<R>,
    Tag extends string = string,
    ContentMeta = unknown,
    RunMeta = unknown,
    Payload = Record<string, unknown>,
> = FindingStored<R, K, Tag, ContentMeta, RunMeta, Payload>;

/* ─────────────────────────  Utilities  ───────────────────────── */

function fnv1a32(s: string) {
    let h = 0x811c9dc5 >>> 0;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
}

const defaultId = (
    i: {
        rule: string;
        code: string;
        content: string;
        range?: TextRange;
        message: string;
    },
) => fnv1a32(
    `${i.rule}#${i.code}#${i.content}#${
        i.range ? `${i.range.start}-${i.range.end}` : "-"
    }#${i.message}`,
);

/* ─────────────────────────  Tiny predicate DSL (optional)  ───────────────────────── */

export type Predicate<R extends Registry, Tag extends string, CM, RM, P> = (
    f: FindingStored<R, Any, Tag, CM, RM, P>,
) => boolean;

export const where = {
    rule:
        <R extends Registry, Tag extends string, CM, RM, P>(id: string) =>
        (f: FindingStored<R, Any, Tag, CM, RM, P>) => f.rule === id,
    content:
        <R extends Registry, Tag extends string, CM, RM, P>(cid: string) =>
        (f: FindingStored<R, Any, Tag, CM, RM, P>) => f.content === cid,
    severity: <R extends Registry, Tag extends string, CM, RM, P>(
        s: NonOffSeverity,
    ) =>
    (f: FindingStored<R, Any, Tag, CM, RM, P>) => f.severity === s,
    code:
        <R extends Registry, Tag extends string, CM, RM, P>(c: string) =>
        (f: FindingStored<R, Any, Tag, CM, RM, P>) => String(f.code) === c,
    and: <R extends Registry, Tag extends string, CM, RM, P>(
        ...ps: Predicate<R, Tag, CM, RM, P>[]
    ) =>
    (f: FindingStored<R, Any, Tag, CM, RM, P>) => ps.every((p) => p(f)),
    or: <R extends Registry, Tag extends string, CM, RM, P>(
        ...ps: Predicate<R, Tag, CM, RM, P>[]
    ) =>
    (f: FindingStored<R, Any, Tag, CM, RM, P>) => ps.some((p) => p(f)),
    not: <R extends Registry, Tag extends string, CM, RM, P>(
        p: Predicate<R, Tag, CM, RM, P>,
    ) =>
    (f: FindingStored<R, Any, Tag, CM, RM, P>) => !p(f),
};

/* ─────────────────────────  LintResults core  ───────────────────────── */

export interface LintResultsOptions<
    R extends Registry,
    ContentMeta = unknown,
    RunMeta = unknown,
> {
    registry: R; // created via defineRegistry(...) at call site
    runMeta?: RunMeta;
    contentMetaFor?: (id: string) => ContentMeta | undefined;
    idFor?: (
        i: {
            rule: string;
            code: string;
            content: string;
            range?: TextRange;
            message: string;
        },
    ) => string;
    sortOnRead?: boolean;
}

export class LintResults<
    R extends Registry,
    Tag extends string = string,
    ContentMeta = unknown,
    RunMeta = unknown,
    Payload = Record<string, unknown>,
> {
    private readonly registry: R;
    private readonly idFor: NonNullable<
        LintResultsOptions<R, ContentMeta, RunMeta>["idFor"]
    >;
    private readonly metaFor?: (id: string) => ContentMeta | undefined;
    private readonly sortOnRead: boolean;

    private readonly all: FindingStored<
        R,
        Any,
        Tag,
        ContentMeta,
        RunMeta,
        Payload
    >[] = [];
    private readonly byContent = new Map<
        string,
        FindingStored<R, Any, Tag, ContentMeta, RunMeta, Payload>[]
    >();
    private readonly byRule = new Map<
        string,
        FindingStored<R, Any, Tag, ContentMeta, RunMeta, Payload>[]
    >();
    private readonly bySeverity: Record<
        NonOffSeverity,
        FindingStored<R, Any, Tag, ContentMeta, RunMeta, Payload>[]
    > = {
        error: [],
        warn: [],
        info: [],
        hint: [],
    };

    private readonly runs = new Map<
        string,
        { meta: RunMeta | undefined; contents: Set<string> }
    >();
    private currentRunId = "run-1";
    private readonly sorted = new Set<string>(); // per-content lazy sort marker

    constructor(opts: LintResultsOptions<R, ContentMeta, RunMeta>) {
        this.registry = opts.registry;
        this.idFor = opts.idFor ?? defaultId;
        this.metaFor = opts.contentMetaFor;
        this.sortOnRead = opts.sortOnRead ?? true;
        this.openRun(opts.runMeta);
    }

    openRun(meta?: RunMeta) {
        const id = `run-${this.runs.size + 1}`;
        this.runs.set(id, { meta, contents: new Set() });
        this.currentRunId = id;
        return id;
    }

    closeRun(runId: string, patch?: Partial<RunMeta>) {
        const r = this.runs.get(runId);
        if (!r) return;
        r.meta = typeof r.meta === "object" && r.meta
            ? { ...(r.meta as Any), ...patch }
            : (patch as RunMeta ?? r.meta);
    }

    /** Add one or many findings. If severity === "off", it is ignored. */
    add<K extends RuleIds<R>>(
        input:
            | FindingInput<R, K, Tag, Payload>
            | readonly FindingInput<R, K, Tag, Payload>[],
    ) {
        const list = Array.isArray(input) ? input : [input];
        for (const dto of list) {
            if (dto.severity === "off") continue;

            // Deterministic ID + de-dupe
            const id = this.idFor({
                rule: dto.rule,
                code: String(dto.code),
                content: dto.content,
                range: dto.range,
                message: dto.message,
            });
            if (this.hasId(id)) continue;

            const run = this.runs.get(this.currentRunId)!;
            const stored: FindingStored<
                R,
                K,
                Tag,
                ContentMeta,
                RunMeta,
                Payload
            > = {
                ...dto,
                severity: dto.severity as NonOffSeverity, // stored findings never have "off"
                id,
                runId: this.currentRunId,
                contentRef: this.metaFor
                    ? { id: dto.content, meta: this.metaFor(dto.content) }
                    : { id: dto.content },
                runMeta: run.meta,
            };

            this.all.push(stored);

            // byContent
            let bc = this.byContent.get(stored.content);
            if (!bc) {
                bc = [];
                this.byContent.set(stored.content, bc);
            }
            bc.push(stored);
            if (this.sortOnRead) this.sorted.delete(stored.content);

            // byRule
            let br = this.byRule.get(stored.rule);
            if (!br) {
                br = [];
                this.byRule.set(stored.rule, br);
            }
            br.push(stored);

            // bySeverity (now safe: key is NonOffSeverity)
            this.bySeverity[stored.severity].push(stored);

            // runs
            run.contents.add(stored.content);
        }
        return this;
    }

    /** Typed convenience adder for a specific rule id. */
    addForRule<K extends RuleIds<R>>(
        rule: K,
        payload: Omit<FindingInput<R, K, Tag, Payload>, "rule">,
    ) {
        return this.add({ rule, ...payload } as Any);
    }

    /** Curried adder for loops / tests. */
    forRuleAdder<K extends RuleIds<R>>(rule: K) {
        return (p: Omit<FindingInput<R, K, Tag, Payload>, "rule">) =>
            this.addForRule(rule, p);
    }

    /* Accessors */
    allFindings() {
        return this.all as readonly FindingStored<
            R,
            Any,
            Tag,
            ContentMeta,
            RunMeta,
            Payload
        >[];
    }
    contents() {
        return [...this.byContent.keys()] as readonly string[];
    }
    rulesSeen() {
        return [...this.byRule.keys()] as readonly string[];
    }

    forContent(id: string) {
        const b = this.byContent.get(id) ?? [];
        if (!this.sortOnRead) return b;
        if (!this.sorted.has(id)) {
            b.sort((a, b2) => {
                const aStart = a.range
                    ? a.range.start
                    : Number.POSITIVE_INFINITY;
                const bStart = b2.range
                    ? b2.range.start
                    : Number.POSITIVE_INFINITY;
                const aEnd = a.range ? a.range.end : Number.POSITIVE_INFINITY;
                const bEnd = b2.range ? b2.range.end : Number.POSITIVE_INFINITY;
                return (aStart - bStart) || (aEnd - bEnd);
            });
            this.sorted.add(id);
        }
        return b;
    }

    forRule<K extends RuleIds<R>>(rule: K) {
        return (this.byRule.get(rule) ?? []) as readonly NarrowFinding<
            R,
            K,
            Tag,
            ContentMeta,
            RunMeta,
            Payload
        >[];
    }

    bySeverityLevel(s: NonOffSeverity) {
        return this.bySeverity[s];
    }

    query(
        pred: (
            f: FindingStored<R, Any, Tag, ContentMeta, RunMeta, Payload>,
        ) => boolean,
    ) {
        return this.all.filter(pred);
    }

    first(
        n: number,
        pred?: (
            f: FindingStored<R, Any, Tag, ContentMeta, RunMeta, Payload>,
        ) => boolean,
    ) {
        if (!pred) return this.all.slice(0, n);
        const out: typeof this.all = [];
        for (const f of this.all) {
            if (pred(f)) out.push(f);
            if (out.length >= n) break;
        }
        return out;
    }

    /* Summaries */
    counts() {
        const bySeverity: Record<NonOffSeverity, number> = {
            error: 0,
            warn: 0,
            info: 0,
            hint: 0,
        };
        const byRule: Record<string, number> = {};
        const byContent: Record<string, number> = {};
        for (const f of this.all) {
            bySeverity[f.severity]++;
            byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
            byContent[f.content] = (byContent[f.content] ?? 0) + 1;
        }
        return { total: this.all.length, bySeverity, byRule, byContent };
    }

    /* Merge & JSON round-trip (lightweight; caller ensures registry compatibility) */
    merge(other: LintResults<R, Tag, ContentMeta, RunMeta, Payload>) {
        this.add(other.allFindings() as Any);
        return this;
    }

    toJSON() {
        return {
            $schema: "lint-results/v1",
            // Cast to satisfy Object.keys' overload with a generic:
            rulesKeys: Object.keys(this.registry as Record<string, unknown>),
            runs: [...this.runs.entries()].map(([id, r]) => ({
                id,
                meta: r.meta,
                contents: [...r.contents],
            })),
            findings: this.all,
        } as const;
    }

    static fromJSON<
        R extends Registry,
        Tag extends string = string,
        ContentMeta = unknown,
        RunMeta = unknown,
        Payload = Record<string, unknown>,
    >(registry: R, json: {
        $schema: "lint-results/v1";
        rulesKeys: readonly string[];
        runs: readonly {
            id: string;
            meta?: RunMeta;
            contents: readonly string[];
        }[];
        findings: readonly FindingStored<
            R,
            Any,
            Tag,
            ContentMeta,
            RunMeta,
            Payload
        >[];
    }) {
        const inst = new LintResults<R, Tag, ContentMeta, RunMeta, Payload>({
            registry,
        });
        (inst as Any).runs.clear();
        for (const r of json.runs) {
            (inst as Any).runs.set(r.id, {
                meta: r.meta,
                contents: new Set(r.contents),
            });
        }
        (inst as Any).currentRunId = json.runs.at(-1)?.id ?? "run-1";
        for (const f of json.findings) {
            (inst as Any).all.push(f);
            let bc = (inst as Any).byContent.get(f.content);
            if (!bc) {
                bc = [];
                (inst as Any).byContent.set(f.content, bc);
            }
            bc.push(f);
            let br = (inst as Any).byRule.get(f.rule);
            if (!br) {
                br = [];
                (inst as Any).byRule.set(f.rule, br);
            }
            br.push(f);
            (inst as Any).bySeverity[f.severity].push(f);
        }
        return inst;
    }

    private hasId(id: string) {
        for (let i = this.all.length - 1; i >= 0; i--) {
            if (this.all[i].id === id) return true;
        }
        return false;
    }
}

/* ─────────────────────────  Minimal usage (example)  ─────────────────────────

const registry = defineRegistry({
  "no-console": defineRule({
    code: ["disallow", "restricted"] as const,
    data: { allowed: [] as string[] },
    defaultSeverity: "warn",
  }),
  "eqeqeq": defineRule({
    code: "expected-strict-eq",
    data: { actual: "==" as "==" | "!=", expected: "===" as "===" | "!==" },
  }),
} as const);

type Reg = typeof registry;

const results = new LintResults<Reg, "security" | "style", { lang?: string }, { tool: string }, { owner?: string }>({
  registry,
  contentMetaFor: (id) => id.endsWith(".ts") ? { lang: "ts" } : {},
  runMeta: { tool: "my-linter@1.0.0" },
});

results.addForRule("eqeqeq", {
  code: "expected-strict-eq",
  data: { actual: "==", expected: "===" },
  severity: "error",
  content: "src/app.ts",
  message: "Use === instead of ==",
  payload: { owner: "team-web" },
});

const eq = results.forRule("eqeqeq");
const c  = results.counts();
const json = results.toJSON();
const rt = LintResults.fromJSON<Reg>(registry, json);

───────────────────────── */
