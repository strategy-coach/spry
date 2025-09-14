/**
 * governance.ts
 * Fluent, type-safe builders for GovernanceBase and FS policies.
 *
 * Zod example (for typed annotations):
 *   import { z } from "zod";
 *   const ReviewAnnoZ = z.object({
 *     reviewer: z.string(),
 *     status: z.enum(["pending","approved","rejected"]),
 *     ticketId: z.string().optional(),
 *   });
 *   type ReviewAnnotations = z.infer<typeof ReviewAnnoZ>;
 *
 *   const gov = governance<ReviewAnnotations>()
 *     .annotations({ reviewer: "alice", status: "approved" })
 *     .provenance({ source: "fs", agent: "walker@1.2.3", collectedAt: new Date() })
 *     .tags("internal", "exportable")
 *     .done();
 *
 *   // Optionally validate before .done():
 *   const safe = ReviewAnnoZ.safeParse(gov.annotations);
 *   if (!safe.success) { /* handle error * }
 */

import {
    type DefaultPermissions,
    type DefaultProvenance,
    type GovernanceBase,
} from "./core.ts";
import { type FSGovernance } from "./fs.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

// ---------- Generic Governance builder ----------

export class GovernanceBuilder<
    A = Record<string, unknown>,
    Prov = DefaultProvenance,
    Perm = DefaultPermissions,
    TTags extends readonly string[] = readonly string[],
> {
    private _tags?: TTags;
    private _annotations?: A;
    private _provenance?: Prov;
    private _permissions?: Perm;

    /** Supply strongly-typed annotations. */
    annotations(anno: A) {
        this._annotations = anno;
        return this;
    }

    /** Supply provenance meta (e.g., lineage, source, commit). */
    provenance(p: Prov) {
        this._provenance = p;
        return this;
    }

    /** Supply permissions (e.g., IAM-like shape). */
    permissions(p: Perm) {
        this._permissions = p;
        return this;
    }

    /** Add tags; when TTags is a literal union array, TypeScript checks each tag. */
    tags(...t: TTags extends readonly (infer U)[] ? U[] : string[]) {
        // When TTags is not a concrete tuple/union, we accept string[]
        this._tags = (t as unknown) as TTags;
        return this;
    }

    /** Finish and return a GovernanceBase<A,Prov,Perm,TTags>. */
    done(): GovernanceBase<A, Prov, Perm, TTags> {
        const out: GovernanceBase<A, Prov, Perm, TTags> = {};
        if (this._tags) (out as Any).tags = this._tags;
        if (this._annotations) (out as Any).annotations = this._annotations;
        if (this._provenance) (out as Any).provenance = this._provenance;
        if (this._permissions) (out as Any).permissions = this._permissions;
        return out;
    }
}

/** Start a governance builder with desired type parameters. */
export function governance<
    A = Record<string, unknown>,
    Prov = DefaultProvenance,
    Perm = DefaultPermissions,
    TTags extends readonly string[] = readonly string[],
>(): GovernanceBuilder<A, Prov, Perm, TTags> {
    return new GovernanceBuilder<A, Prov, Perm, TTags>();
}

// ---------- FS Governance helpers ----------

type Policy = NonNullable<FSGovernance["policy"]>;

export class FsPolicyBuilder {
    private _policy: Policy = {
        detectTextByExtension: true,
        defaultEncoding: "utf-8",
    };

    detectTextByExtension(v: boolean) {
        (this._policy as Any).detectTextByExtension = v;
        return this;
    }

    defaultEncoding(enc: string) {
        (this._policy as Any).defaultEncoding = enc;
        return this;
    }

    done(): Policy {
        return { ...this._policy };
    }
}

/** Build a full FSGovernance by composing GovernanceBase + FS policy fields. */
export class FsGovernanceBuilder<
    A = Record<string, unknown>,
    Prov = DefaultProvenance,
    Perm = DefaultPermissions,
    TTags extends readonly string[] = readonly string[],
> {
    private _g = governance<A, Prov, Perm, TTags>();
    private _baseDir?: string;
    private _rel?: string;
    private _policy?: Policy;

    annotations(anno: A) {
        this._g.annotations(anno);
        return this;
    }
    provenance(p: Prov) {
        this._g.provenance(p);
        return this;
    }
    permissions(p: Perm) {
        this._g.permissions(p);
        return this;
    }
    tags(...t: TTags extends readonly (infer U)[] ? U[] : string[]) {
        this._g.tags(...(t as Any));
        return this;
    }

    baseDir(b: string) {
        this._baseDir = b;
        return this;
    }
    rel(r: string) {
        this._rel = r;
        return this;
    }

    policy(init?: (p: FsPolicyBuilder) => void) {
        const pb = new FsPolicyBuilder();
        if (init) init(pb);
        this._policy = pb.done();
        return this;
    }

    done(): FSGovernance<A, Prov, Perm, TTags> {
        const base = this._g.done();
        const out: FSGovernance<A, Prov, Perm, TTags> = { ...base };
        if (this._baseDir) (out as Any).baseDir = this._baseDir;
        if (this._rel) (out as Any).rel = this._rel;
        if (this._policy) (out as Any).policy = this._policy;
        return out;
    }
}

/** Start FS governance builder with desired type parameters. */
export function fsGovernance<
    A = Record<string, unknown>,
    Prov = DefaultProvenance,
    Perm = DefaultPermissions,
    TTags extends readonly string[] = readonly string[],
>(): FsGovernanceBuilder<A, Prov, Perm, TTags> {
    return new FsGovernanceBuilder<A, Prov, Perm, TTags>();
}
