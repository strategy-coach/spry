import { z } from "jsr:@zod/zod@4";
import type {
  CodeCell,
  DocumentedCodeCell,
  DocumentedNotebook,
  Issue,
  Notebook,
} from "./core.ts";

export type Asyncish<T> = AsyncIterable<T> | Iterable<T>;

export function isAsyncIterable<T>(obj: unknown): obj is AsyncIterable<T> {
  return (
    typeof obj === "object" &&
    obj !== null &&
    typeof (obj as { [Symbol.asyncIterator]?: () => AsyncIterator<unknown> })[
        Symbol.asyncIterator
      ] === "function"
  );
}

export function toAsync<T>(it: Asyncish<T>): AsyncIterable<T> {
  if (isAsyncIterable<T>(it)) return it;
  return (async function* () {
    for (const x of it as Iterable<T>) yield x;
  })();
}

/**
 * Validate frontmatter (Zod 4, safeParse). Mutates `nb.issues`.
 * Carries a custom issue shape `I` that extends base `Issue` (defaults to `Issue`).
 *
 * DX:
 * - Juniors: just call safeFrontmatter(schema, notebooks(...)).
 * - Seniors: provide a custom `I` with extra fields (e.g., origin) and type your stream as Notebook<..., I>.
 */
export async function* safeFrontmatter<
  Provenance,
  FM extends Record<string, unknown>,
  Attrs extends Record<string, unknown>,
  I extends Issue<Provenance> = Issue<Provenance>,
>(
  fmSchema: z.ZodSchema<FM>,
  input: Asyncish<Notebook<Provenance, FM, Attrs, I>>,
) {
  for await (const nb of toAsync(input)) {
    const zodParseResult = fmSchema.safeParse(nb.fm);

    if (!zodParseResult.success) {
      for (const zi of zodParseResult.error.issues ?? []) {
        const pathStr = zi.path?.join(".") ?? "";
        const message = pathStr ? `${pathStr}: ${zi.message}` : zi.message;

        const errPayload: {
          code: string;
          path: PropertyKey[];
          expected?: unknown;
          received?: unknown;
        } = { code: zi.code, path: zi.path };

        if (zi.code === "invalid_type") {
          const maybe = zi as {
            code: "invalid_type";
            expected?: unknown;
            received?: unknown;
          };
          if ("expected" in maybe) errPayload.expected = maybe.expected;
          if ("received" in maybe) errPayload.received = maybe.received;
        }

        const issueBase: Issue<Provenance> = {
          kind: "frontmatter-parse",
          provenance: nb.provenance,
          disposition: "error",
          message,
          raw: nb.fm,
          error: errPayload,
        };

        // Cast to I so callers who extend Issue can still store their shape.
        nb.issues.push(issueBase as unknown as I);
      }
    }

    yield { notebook: nb, zodParseResult };
  }
}

/**
 * Enrich each code cell via callback; mutate in place; register issues.
 * Supports custom issue shape `I` on the target notebook (extends base Issue).
 */
export async function* mutateCodeCells<
  Provenance,
  FM extends Record<string, unknown>,
  Attrs extends Record<string, unknown>,
  I extends Issue<Provenance> = Issue<Provenance>,
>(
  callback: (
    cell: CodeCell<Provenance, Attrs>,
    ctx: {
      nb: Notebook<Provenance, FM, Attrs, I>;
      cellIndex: number;
      registerIssue: (issue: I) => void;
    },
  ) => void | Promise<void>,
  input: Asyncish<Notebook<Provenance, FM, Attrs, I>>,
) {
  for await (const nb of toAsync(input)) {
    const registerIssue = (issue: I) => nb.issues.push(issue);

    for (let i = 0; i < nb.cells.length; i++) {
      const c = nb.cells[i];
      if (c.kind !== "code") continue;
      await callback(c as CodeCell<Provenance, Attrs>, {
        nb,
        cellIndex: i,
        registerIssue,
      });
    }

    yield nb;
  }
}

/**
 * Enrich each documented code cell via callback; mutate in place; register
 * issues. Supports custom issue shape `I` on the target notebook (extends
 * base Issue).
 */
export async function* mutateDocCodeCells<
  Provenance,
  FM extends Record<string, unknown>,
  Attrs extends Record<string, unknown>,
  I extends Issue<Provenance> = Issue<Provenance>,
>(
  callback: (
    cell: DocumentedCodeCell<Provenance, Attrs>,
    ctx: {
      nb: DocumentedNotebook<Provenance, FM, Attrs, I>;
      cellIndex: number;
      registerIssue: (issue: I) => void;
    },
  ) => void | Promise<void>,
  input: Asyncish<DocumentedNotebook<Provenance, FM, Attrs, I>>,
) {
  for await (const nb of toAsync(input)) {
    const registerIssue = (issue: I) => nb.notebook.issues.push(issue);

    for (let i = 0; i < nb.cells.length; i++) {
      const c = nb.cells[i];
      if (c.kind !== "code") continue;
      await callback(c, { nb, cellIndex: i, registerIssue });
    }

    yield nb;
  }
}

export type DocCodeCellMutator<Provenance> = Parameters<
  typeof mutateDocCodeCells<
    Provenance,
    Record<string, unknown>,
    Record<string, unknown>
  >
>[0];

/**
 * Create a mutator from a list of mutators
 * @param mutators the iteratable of mutators
 * @returns a single mutator which loops through the list
 */
export function pipedDocCodeCellMutators<Provenance>(
  mutators: Iterable<DocCodeCellMutator<Provenance>>,
): DocCodeCellMutator<Provenance> {
  return async (cell, ctx) => {
    for await (const e of mutators) {
      e(cell, ctx);
    }
  };
}
