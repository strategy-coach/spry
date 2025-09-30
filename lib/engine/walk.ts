import { walk, WalkEntry, WalkOptions } from "jsr:@std/fs@1/walk";
import { FsPathSupplier } from "./paths.ts";

export type WalkSpec = {
  readonly paths: FsPathSupplier;
  readonly options?: WalkOptions;
};

export type WalkEncounter<S extends WalkSpec> = {
  readonly origin: S;
  readonly entry: WalkEntry;
};

export type EncountersSupplier<
  S extends WalkSpec = WalkSpec,
  E extends WalkEncounter<S> = WalkEncounter<S>,
> = {
  readonly encountered: () => AsyncGenerator<E>;
};

export class Walker<
  S extends WalkSpec = WalkSpec,
  E extends WalkEncounter<S> = WalkEncounter<S>,
> implements EncountersSupplier<S, E> {
  constructor(readonly init: S) {}

  transform(entry: WalkEntry) {
    return { origin: this.init, entry } as E;
  }

  async *encountered() {
    for await (
      const we of walk(this.init.paths.root, this.init?.options)
    ) {
      yield this.transform(we) as E;
    }
  }
}

export class Walkers<
  S extends WalkSpec = WalkSpec,
  E extends WalkEncounter<S> = WalkEncounter<S>,
> implements EncountersSupplier<S, E> {
  readonly walkers: Walker<S, E>[];

  constructor(...walkers: Walker<S, E>[]) {
    this.walkers = walkers;
  }

  /** Builder entrypoint */
  static builder<
    TS extends WalkSpec = WalkSpec,
    TE extends WalkEncounter<TS> = WalkEncounter<TS>,
  >() {
    return new (class {
      private walkers: Walker<TS, TE>[] = [];

      addWalker(w: Walker<TS, TE>) {
        this.walkers.push(w);
        return this;
      }

      addSpec(spec: TS) {
        this.walkers.push(new Walker<TS, TE>(spec));
        return this;
      }

      addRoot(
        paths: FsPathSupplier,
        options?: WalkOptions,
      ) {
        const spec = { paths, options } as TS;
        this.walkers.push(new Walker<TS, TE>(spec));
        return this;
      }

      build() {
        return new Walkers<TS, TE>(...this.walkers);
      }
    })();
  }

  // Sequential merge with dedupe (by entry.path)
  async *encountered() {
    const seen = new Set<string>();

    for (const w of this.walkers) {
      for await (const e of w.encountered()) {
        const key = e.entry.path;
        if (seen.has(key)) continue;
        seen.add(key);
        yield e as E;
      }
    }
  }
}
