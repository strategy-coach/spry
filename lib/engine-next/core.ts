// core-fs.ts
import z from "jsr:@zod/zod@4";
import {
    AnnotationCatalog,
    extractAnnotationsFromText,
} from "../universal/content/code-comments.ts";
import { LanguageSpec } from "../universal/content/code.ts";
import { Resource, zodParsedResourceAnns } from "./resource.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

export type TextSupplier = {
    readonly text: () => string | Promise<string>;
};

export const isTextSupplier = (o: unknown): o is TextSupplier =>
    o && typeof o === "object" && "text" in o &&
        typeof o.text === "function"
        ? true
        : false;

export type SrcCodeLangSpecSupplier = {
    srcCodeLanguage: LanguageSpec;
};

export const isSrcCodeLangSpecSupplier = (
    o: unknown,
): o is SrcCodeLangSpecSupplier =>
    o && typeof o === "object" && "srcCodeLanguage" in o &&
        typeof o.srcCodeLanguage === "object"
        ? true
        : false;

export type ResourceSupplier<State, R extends Resource> = (
    args: { state: State; signal?: AbortSignal },
) => AsyncIterable<R> | AsyncGenerator<R, void, unknown>;

export interface ResourceContribution<State, R extends Resource> {
    register: (...suppliers: ReadonlyArray<ResourceSupplier<State, R>>) => void;
    list: () => ReadonlyArray<ResourceSupplier<State, R>>;
}

// Utility: add `state` to every payload in a map
type WithState<State, M extends Record<string, object>> = {
    [K in keyof M]: M[K] & { state: State };
};

/* =========================
   Lean Lint infrastructure
   ========================= */

// Severity across all rules
export type LintSeverity = "info" | "warn" | "error";

// A generic catalog shape. Each rule has a codes map; each code has an elaboration type.
export type LintCatalog = Record<
    string, // rule id
    {
        description?: string;
        codes: Record<
            string, // code id
            {
                message: string;
                // Each code can define its own elaboration payload type
                elaboration: unknown;
            }
        >;
    }
>;

// Helpers to extract types out of the catalog
export type LintRuleIds<C extends LintCatalog> = Extract<keyof C, string>;
export type LintCodeIds<C extends LintCatalog, R extends LintRuleIds<C>> =
    Extract<keyof C[R]["codes"], string>;
export type LintElaboration<
    C extends LintCatalog,
    R extends LintRuleIds<C>,
    K extends LintCodeIds<C, R>,
> = C[R]["codes"][K]["elaboration"];

// A strongly-typed lint issue for a given rule+code pair
export type LintIssue<
    C extends LintCatalog,
    R extends LintRuleIds<C>,
    K extends LintCodeIds<C, R>,
> = {
    subsystem: "lint";
    rule: R;
    code: K;
    severity: LintSeverity;
    message?: string; // can override catalog message
    elaboration: LintElaboration<C, R, K>;
    where?: unknown; // optionally tie to context
    cause?: unknown; // optional correlation / causality
};

// Minimal per-event linter facade attached to payloads
export interface Linter<C extends LintCatalog> {
    issue<R extends LintRuleIds<C>, K extends LintCodeIds<C, R>>(
        issue: Omit<LintIssue<C, R, K>, "subsystem">,
    ): void;
}

// Attach a typed linter to every event payload in Ev
type AttachLinter<Ev extends Record<string, unknown>, C extends LintCatalog> = {
    [K in keyof Ev]: Ev[K] & { linter: Linter<C> };
};

/* =========================
   Engine event maps
   ========================= */

// ---------- Event payloads (parameterized by Resource R and Annotation A) ----------
type EngineEventPayloads<R extends Resource> = {
    // Suppliers registration (collectors are specialized with State later)
    "resource:contribute": {
        contribute: ResourceContribution<unknown, R>;
    };

    // Emitted when a resource is yielded by a supplier iteration
    "resource:encountered": {
        resource: R;
        supplier?: ResourceSupplier<unknown, R>;
        annsCatalog?: AnnotationCatalog;
        srcCodeLanguage?: LanguageSpec;
    };

    // "materialize:directive"
    // "materialize:foundry"

    // "build:prepare"
    // "build:prepare:dev"

    // "build:execute"
    // "build:complete"

    // Foundry lifecycle — include related resources when applicable
    "foundry:beforeRun": {
        foundryName: string;
        proposed: { env?: Record<string, string>; args?: string[] };
        resources?: ReadonlyArray<R>;
    };

    "foundry:afterRun": {
        foundryName: string;
        result: { ok: true; durationMs: number } | { ok: false; error: string };
        artifacts: Array<{ relPath: string; hash: string }>;
        resources?: ReadonlyArray<R>;
    };

    // Artifact lifecycle — always tie artifacts to their originating resource
    "artifact:beforeWrite": {
        resource: R;
        artifact: { bytes: Uint8Array; contentType?: string };
        proposed: { relPath: string; contentType?: string };
    };

    "artifact:written": {
        resource: R;
        location: { relPath: string; uri: string; hash: string };
    };

    // Build milestones (summary-level, still carry State via WithState)
    "build:planReady": {
        summary: { resources: number; plugins: number; graphHash: string };
    };

    "build:complete": {
        outcome: "success" | "failed";
        stats: { durationMs: number; wrote: number; cached: number };
    };

    // Diagnostics may reference a specific resource
    "diagnostic": {
        level: "info" | "warn" | "error";
        code: string;
        message: string;
        resource?: R;
        at?: { file?: string; line?: number; column?: number };
    };
};

// Dedicated lint event channel (state-bearing, for aggregation/reporting)
type LintEventMap<State, C extends LintCatalog> = WithState<State, {
    "lint:issue": LintIssue<C, LintRuleIds<C>, Any>;
}>;

// ---------- Public, generic event map ----------
export type EngineEvents<State, R extends Resource> = WithState<
    State,
    Omit<
        EngineEventPayloads<R>,
        "resource:contribute" | "resource:encountered"
    > & {
        "resource:contribute": {
            contribute: ResourceContribution<State, R>;
        };
        "resource:encountered": {
            resource: R;
            supplier?: ResourceSupplier<State, R>;
            annsCatalog?: AnnotationCatalog;
            srcCodeLanguage?: LanguageSpec;
        };
    }
>;

/* =========================
   Event helper types
   ========================= */

export type EngineEventName<E> = Extract<keyof E, string>;
export type EngineEvent<E, N extends EngineEventName<E>> = E[N];

export type EngineDispatchable<E, N extends EngineEventName<E>> = Readonly<{
    identity: N;
    event: EngineEvent<E, N>;
    time: number; // ms since epoch
    cancelable?: boolean;
    defaultPrevented?: boolean;
}>;

export type EngineListener<E, N extends EngineEventName<E>> = (
    ev: EngineDispatchable<E, N>,
) => void | Promise<void>;

/* =========================
   Engine (with per-event linter)
   ========================= */

/* =========================
   Engine (with per-event linter) — FIXED TYPINGS
   ========================= */

type EventMap<S> = EngineEvents<S, Resource>;
type EvRaw<S, C extends LintCatalog> =
    & EventMap<S>
    & LintEventMap<S, C>;
type EvWith<S, C extends LintCatalog> = AttachLinter<EvRaw<S, C>, C>;
type EvName<S, C extends LintCatalog> = Extract<keyof EvWith<S, C>, string>;

export class Engine<State, C extends LintCatalog> {
    constructor(readonly state: State) {}

    private listeners = new Map<
        EvName<State, C>,
        Set<EngineListener<EvWith<State, C>, Any>>
    >();

    on<N extends EvName<State, C>>(
        identity: N,
        listener: EngineListener<EvWith<State, C>, N>,
    ): this {
        const set = (this.listeners.get(identity) as
            | Set<EngineListener<EvWith<State, C>, N>>
            | undefined) ?? new Set();
        set.add(listener);
        this.listeners.set(identity, set as Set<EngineListener<Any, Any>>);
        return this;
    }

    off<N extends EvName<State, C>>(
        identity: N,
        listener: EngineListener<EvWith<State, C>, N>,
    ): this {
        const set = this.listeners.get(identity);
        if (set) set.delete(listener as EngineListener<Any, Any>);
        return this;
    }

    private makeLinter(): Linter<C> {
        return {
            issue: <Rr extends LintRuleIds<C>, Kk extends LintCodeIds<C, Rr>>(
                issue: Omit<LintIssue<C, Rr, Kk>, "subsystem">,
            ) => {
                // Re-dispatch through dedicated lint channel
                this.dispatch("lint:issue" as EvName<State, C>, {
                    subsystem: "lint",
                    ...issue,
                    state: this.state,
                } as unknown as EngineEvent<
                    EvRaw<State, C>,
                    "lint:issue"
                >);
            },
        };
    }

    private async dispatch<N extends EvName<State, C>>(
        identity: N,
        // NOTE: incoming event is the RAW map (no linter); we add linter here
        event: EngineEvent<EvRaw<State, C>, N>,
        cancelable = false,
    ): Promise<void> {
        const set = this.listeners.get(identity) as
            | Set<EngineListener<EvWith<State, C>, N>>
            | undefined;
        if (!set?.size) return;

        const linter = this.makeLinter();

        const dispatchable: EngineDispatchable<EvWith<State, C>, N> = {
            identity,
            event: {
                ...(event as unknown as object),
                linter,
            } as EngineEvent<EvWith<State, C>, N>,
            time: Date.now(),
            cancelable,
            defaultPrevented: false,
        };

        for (const fn of set) {
            await fn(dispatchable);
        }
    }

    /**
     * Fires "resource:contribute", collects suppliers, iterates them,
     * and emits "resource:encountered" for each yielded resource.
     *
     * All dispatched payloads include a typed `linter` for listeners to report issues inline.
     */
    async discover(signal?: AbortSignal): Promise<number> {
        type Raw = EvRaw<State, C>;
        type R = Resource;
        const suppliers: ResourceSupplier<State, R>[] = [];

        const contribution: ResourceContribution<State, R> = {
            register: (...ss) => suppliers.push(...ss),
            list: () => suppliers.slice(),
        };

        // Let listeners register suppliers
        await this.dispatch<"resource:contribute">("resource:contribute", {
            contribute: contribution,
            state: this.state,
        } as EngineEvent<Raw, "resource:contribute">);

        // Drain suppliers and emit encountered events
        let count = 0;
        for (const supplier of suppliers) {
            if (signal?.aborted) break;
            for await (
                const resource of supplier({ state: this.state, signal })
            ) {
                if (signal?.aborted) break;

                let resAnnParseResult:
                    | ReturnType<typeof zodParsedResourceAnns>
                    | undefined;
                let resAnn: Resource | undefined;
                let annsCatalog:
                    | Awaited<ReturnType<typeof extractAnnotationsFromText>>
                    | undefined;
                let srcCodeLanguage: LanguageSpec | undefined;
                if (
                    isTextSupplier(resource) &&
                    isSrcCodeLangSpecSupplier(resource)
                ) {
                    srcCodeLanguage = resource.srcCodeLanguage;
                    annsCatalog = await extractAnnotationsFromText(
                        await resource.text(),
                        srcCodeLanguage,
                        {
                            tags: { multi: true, valueMode: "json" },
                            kv: false,
                            yaml: false,
                            json: false,
                        },
                    );
                    resAnnParseResult = zodParsedResourceAnns(annsCatalog, {
                        isSystemGenerated: false,
                    });
                    resAnn = resAnnParseResult?.success
                        ? resAnnParseResult.data
                        : undefined;
                }

                if (resAnnParseResult?.error) {
                    console.error(
                        "TODO: lint this",
                        z.prettifyError(resAnnParseResult.error),
                    );
                }

                await this.dispatch<"resource:encountered">(
                    "resource:encountered",
                    {
                        resource: { ...resource, ...resAnn },
                        state: this.state,
                        supplier,
                        annsCatalog,
                        srcCodeLanguage,
                    } as EngineEvent<Raw, "resource:encountered">,
                );
                count++;
            }
        }
        return count;
    }
}

export class ResourcesCollection<State> {
    readonly suppliers = new Set<ResourceSupplier<State, Resource>>();
    readonly resources: readonly Resource[] = [];

    constructor() {
        this.listen = this.onEncountered.bind(this);
    }

    /** Pass to engine.on("resource:encountered", collector.listen) */
    readonly listen: EngineListener<
        EngineEvents<State, Resource>,
        "resource:encountered"
    >;

    groupBy<K extends string | number | symbol>(
        keyFn: (r: Resource) => K,
    ) {
        const m = new Map<K, Resource[]>();
        for (const r of this.resources) {
            const k = keyFn(r);
            const arr = m.get(k);
            if (arr) arr.push(r);
            else m.set(k, [r]);
        }
        return m;
    }

    // deno-lint-ignore require-await
    protected async onEncountered(
        ev: Parameters<
            EngineListener<
                EngineEvents<State, Resource>,
                "resource:encountered"
            >
        >[0],
    ) {
        const { resource, supplier } = ev.event;
        if (supplier) {
            this.suppliers.add(
                supplier as ResourceSupplier<State, Resource>,
            );
        }
        (this.resources as Resource[]).push(resource);
    }
}
