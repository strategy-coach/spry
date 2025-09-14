// walk.ts
import {
  type Encountered as CoreEncountered,
  type Key,
  type SpecSupplier,
  walk as coreWalk,
  type WalkerAdapter,
  type WalkerOptions as CoreWalkerOptions,
} from "../walk/mod.ts"; // re-exports from walk-core.ts & walk-fs.ts

// deno-lint-ignore no-explicit-any
type Any = any;

/* ---------------------------------- */
/*            CapExec types           */
/* ---------------------------------- */

/**
 * Strict CapExec filename grammar (operates on a "name" string — e.g., a filename).
 *
 * <basename>.[<pre-stages>].<nature>[+].[<post-stages>].<domain>
 * - Pre/post lists, when present, MUST be delimited by the literal pairs ".[" and "]."
 * - Stage tokens are separated by whitespace and/or commas.
 * - `+` on nature means multi-file generator.
 *
 * Examples:
 *  - abc.[one two].sql.[min gzip].ts
 *  - abc.sql.ts
 *  - abc.[preA,preB].sql+.[postA].py
 */
export type CapExecParsed = Readonly<{
  basename: string;
  nature: string; // without '+'
  isMulti: boolean; // true iff nature had '+'
  domain: string;
  preStages: readonly string[];
  postStages: readonly string[];
}>;

/** An item discovered from an adapter that successfully parses as a CapExec sink. */
export type CapExecFound<
  SpecNorm extends object = object,
  Item = unknown,
  P = unknown,
> = Readonly<{
  key: Key; // adapter-global unique key (e.g., absolute path)
  spec: SpecNorm; // normalized spec from the adapter
  item: Item; // adapter's raw item (e.g., WalkEntry)
  payload?: P; // optional adapter-provided payload
  name: string; // the parsed "name" string provided by selectName()
  parsed: CapExecParsed; // parsed CapExec components
}>;

/* ---------------------------------- */
/*      Adapter init & options        */
/* ---------------------------------- */

export type WalkCapExecsInit<
  Spec,
  SpecNorm extends object,
  Item,
  P = undefined,
> = Readonly<{
  /** The adapter implementation (FS, DB, API, …). */
  adapter: WalkerAdapter<Spec, SpecNorm, Item, P>;
  /** Specs for this adapter (array/iterable/async iterable or a function returning one). */
  specs: SpecSupplier<Spec>;
  /**
   * Given an encountered item, return a "name" string to parse using the CapExec grammar.
   * Return `null` to skip this item. For FS adapters, this is typically `basename(item.path)`.
   */
  selectName: (enc: CoreEncountered<Item, SpecNorm, P>) => string | null;
  /**
   * Optional additional filter (e.g., "executable bit" for FS, or "has runnable flag" for DB).
   * If provided and returns false, the item is skipped before parsing.
   */
  filter?: (
    enc: CoreEncountered<Item, SpecNorm, P>,
  ) => boolean | Promise<boolean>;
  /** Optional hook for specs the adapter rejects (e.g., non-existent FS root). */
  onInvalidSpec?: CoreWalkerOptions<Any>["onInvalidSpec"];
}>;

/* ---------------------------------- */
/*             Main Walker            */
/* ---------------------------------- */

/**
 * Walk a single adapter/spec set and **yield capturable executables** discovered from that source.
 *
 * The adapter controls how items are enumerated; this wrapper:
 *  1) optionally filters via `init.filter`
 *  2) extracts a candidate name via `init.selectName`
 *  3) parses CapExec grammar
 *  4) yields a strongly-typed `CapExecFound` record
 */
export async function* walkCapExecs<
  Spec = unknown,
  SpecNorm extends object = object,
  Item = unknown,
  P = undefined,
>(
  init: WalkCapExecsInit<Spec, SpecNorm, Item, P>,
): AsyncGenerator<CapExecFound<SpecNorm, Item, P>, void, unknown> {
  const { adapter, specs, selectName, filter, onInvalidSpec } = init;

  const walkerOpts: CoreWalkerOptions<Spec> = {
    specs,
    onInvalidSpec,
  };

  for await (
    const enc of coreWalk<Spec, SpecNorm, Item, P>(
      walkerOpts,
      adapter,
    )
  ) {
    if (filter && !(await filter(enc))) continue;

    const name = selectName(enc);
    if (!name) continue;

    const parsed = parseCapExecName(name);
    if (!parsed) continue;

    yield {
      key: enc.key,
      spec: enc.spec,
      item: enc.item,
      // @ts-ignore payload may be undefined — keep as optional
      payload: (enc as Any).payload,
      name,
      parsed,
    } as CapExecFound<SpecNorm, Item, P>;
  }
}

/* ---------------------------------- */
/*           Parsing helpers          */
/* ---------------------------------- */

/** Split inside a .[ ... ]. block by whitespace and/or commas, trimming empties. */
function splitStages(block: string | undefined): string[] {
  if (!block) return [];
  return block
    .replace(/,/g, " ")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse a CapExec sink name into its components using the strict grammar:
 *   <basename>.[<pre-stages>].<nature>[+].[<post-stages>].<domain>
 *
 * - Pre/post lists are delimited by the literal pairs ".[" and "]."
 * - Stage tokens are separated by whitespace and/or commas.
 * - Nature and domain are alphanumeric with "_" or "-" (no brackets or dots).
 */
export function parseCapExecName(name: string): CapExecParsed | null {
  // NOTE:
  //  - The pre block ends with "]" (no trailing dot inside the group);
  //    the single dot before <nature> is outside the optional group.
  //  - Nature/domain are restricted to [A-Za-z0-9_-]+ to prevent "[]" or "sql.ts".
  const re =
    /^(?<basename>[^.]+)(?:\.\[(?<pre>[^\]]+)\])?\.(?<nature>[A-Za-z0-9][A-Za-z0-9_-]*)(?<plus>\+)?(?:\.\[(?<post>[^\]]+)\])?\.(?<domain>[A-Za-z0-9][A-Za-z0-9_-]*)$/;

  const m = name.match(re);
  if (!m || !m.groups) return null;

  const basename = m.groups["basename"]!;
  const rawNature = m.groups["nature"]!;
  const isMulti = !!m.groups["plus"];
  const domain = m.groups["domain"]!;
  const preStages = splitStages(m.groups["pre"]);
  const postStages = splitStages(m.groups["post"]);

  return {
    basename,
    nature: rawNature,
    isMulti,
    domain,
    preStages,
    postStages,
  };
}
