import { eventBus } from "../event-bus.ts";
import {
  AbsCanonical,
  Brand,
  isInsideRoot,
  parseRel,
  PathPolicy,
  relativeToRoot,
  RelCanonical,
  RootLiteral,
  toAbs,
} from "./path.ts";

// ----------------------------- Driver Contracts -----------------------------

export interface FsStat {
  readonly exists: boolean;
  readonly isFile: boolean;
  readonly isDir: boolean;
  readonly size?: number;
  readonly mtimeMs?: number;
}

export interface FsDriver {
  readonly provider: string;
  read(
    abs: AbsCanonical,
    opts?: { as?: "text" | "bytes" },
  ): Promise<string | Uint8Array>;
  write(
    abs: AbsCanonical,
    data: Uint8Array | string,
    opts?: { overwrite?: boolean },
  ): Promise<number>;
  mkdir(abs: AbsCanonical, opts?: { recursive?: boolean }): Promise<void>;
  rm(abs: AbsCanonical, opts?: { recursive?: boolean }): Promise<void>;
  move(
    fromAbs: AbsCanonical,
    toAbs: AbsCanonical,
    opts?: { overwrite?: boolean },
  ): Promise<void>;
  copy(
    fromAbs: AbsCanonical,
    toAbs: AbsCanonical,
    opts?: { overwrite?: boolean },
  ): Promise<void>;
  list(absDir: AbsCanonical): Promise<AbsCanonical[]>;
  stat(abs: AbsCanonical): Promise<FsStat>;
}

// ----------------------------- Rooted Driver -------------------------------

export type RootedAbs<R extends RootLiteral> = Brand<AbsCanonical, `root:${R}`>;

export interface RootedDriver<R extends RootLiteral> {
  readonly provider: string;
  readonly root: R;
  resolveAbs(rel: RelCanonical): RootedAbs<R>;
  read(
    rel: RelCanonical,
    opts?: { as?: "text" | "bytes" },
  ): Promise<string | Uint8Array>;
  write(
    rel: RelCanonical,
    data: Uint8Array | string,
    opts?: { overwrite?: boolean },
  ): Promise<number>;
  mkdir(rel: RelCanonical, opts?: { recursive?: boolean }): Promise<void>;
  rm(rel: RelCanonical, opts?: { recursive?: boolean }): Promise<void>;
  move(
    from: RelCanonical,
    to: RelCanonical,
    opts?: { overwrite?: boolean },
  ): Promise<void>;
  copy(
    from: RelCanonical,
    to: RelCanonical,
    opts?: { overwrite?: boolean },
  ): Promise<void>;
  list(relDir: RelCanonical): Promise<RelCanonical[]>;
  stat(rel: RelCanonical): Promise<FsStat>;
}

export function rootedDriver<R extends RootLiteral>(
  base: FsDriver,
  root: R,
  policy: PathPolicy = {},
): RootedDriver<R> {
  const resolveAbs = (rel: RelCanonical): RootedAbs<R> => {
    const abs = toAbs(root, rel);
    if (!isInsideRoot(abs, root, policy)) {
      throw new Error(`Path escapes root: ${abs}`);
    }
    return abs as RootedAbs<R>;
  };

  return {
    provider: `${base.provider}+root:${root}`,
    root,
    resolveAbs,
    async read(rel, opts) {
      return await base.read(resolveAbs(rel), opts);
    },
    async write(rel, data, opts) {
      return await base.write(resolveAbs(rel), data, opts);
    },
    async mkdir(rel, opts) {
      await base.mkdir(resolveAbs(rel), opts);
    },
    async rm(rel, opts) {
      await base.rm(resolveAbs(rel), opts);
    },
    async move(from, to, opts) {
      await base.move(resolveAbs(from), resolveAbs(to), opts);
    },
    async copy(from, to, opts) {
      await base.copy(resolveAbs(from), resolveAbs(to), opts);
    },
    async list(relDir) {
      const absEntries = await base.list(resolveAbs(relDir));
      return absEntries.map((abs) => relativeToRoot(abs, root, policy));
    },
    async stat(rel) {
      return await base.stat(resolveAbs(rel));
    },
  } as const;
}

// ------------------------------- Events ------------------------------------

export interface BaseEvent<R extends RootLiteral> {
  readonly at: number;
  readonly provider: string;
  readonly path: RelCanonical;
  readonly absPath: RootedAbs<R>;
  readonly correlationId: string;
}

export type WriteBefore<R extends RootLiteral> = BaseEvent<R> & {
  readonly op: "write";
  readonly phase: "before";
  readonly inputKind: "bytes" | "text";
  readonly size?: number;
};

export type WriteAfter<R extends RootLiteral> = BaseEvent<R> & {
  readonly op: "write";
  readonly phase: "after";
  readonly bytesWritten: number;
};

export type WriteError<R extends RootLiteral> = BaseEvent<R> & {
  readonly op: "write";
  readonly phase: "error";
  readonly error: unknown;
};

export type ReadBefore<R extends RootLiteral> = BaseEvent<R> & {
  readonly op: "read";
  readonly phase: "before";
};

export type ReadAfter<R extends RootLiteral> = BaseEvent<R> & {
  readonly op: "read";
  readonly phase: "after";
  readonly bytes: number;
};

export type ReadError<R extends RootLiteral> = BaseEvent<R> & {
  readonly op: "read";
  readonly phase: "error";
  readonly error: unknown;
};

export type MkdirBefore<R extends RootLiteral> = BaseEvent<R> & {
  readonly op: "mkdir";
  readonly phase: "before";
  readonly recursive: boolean;
};

export type MkdirAfter<R extends RootLiteral> = BaseEvent<R> & {
  readonly op: "mkdir";
  readonly phase: "after";
  readonly created: boolean;
};

export type MkdirError<R extends RootLiteral> = BaseEvent<R> & {
  readonly op: "mkdir";
  readonly phase: "error";
  readonly error: unknown;
};

export type RmBefore<R extends RootLiteral> = BaseEvent<R> & {
  readonly op: "rm";
  readonly phase: "before";
  readonly recursive: boolean;
};

export type RmAfter<R extends RootLiteral> = BaseEvent<R> & {
  readonly op: "rm";
  readonly phase: "after";
  readonly removed: boolean;
};

export type RmError<R extends RootLiteral> = BaseEvent<R> & {
  readonly op: "rm";
  readonly phase: "error";
  readonly error: unknown;
};

export type MoveBefore<R extends RootLiteral> = BaseEvent<R> & {
  readonly op: "move";
  readonly phase: "before";
  readonly to: RelCanonical;
  readonly toAbsPath: RootedAbs<R>;
  readonly overwrite: boolean;
};

export type MoveAfter<R extends RootLiteral> = BaseEvent<R> & {
  readonly op: "move";
  readonly phase: "after";
  readonly to: RelCanonical;
  readonly toAbsPath: RootedAbs<R>;
};

export type MoveError<R extends RootLiteral> = BaseEvent<R> & {
  readonly op: "move";
  readonly phase: "error";
  readonly to: RelCanonical;
  readonly toAbsPath: RootedAbs<R>;
  readonly error: unknown;
};

export type CopyBefore<R extends RootLiteral> = BaseEvent<R> & {
  readonly op: "copy";
  readonly phase: "before";
  readonly to: RelCanonical;
  readonly toAbsPath: RootedAbs<R>;
  readonly overwrite: boolean;
};

export type CopyAfter<R extends RootLiteral> = BaseEvent<R> & {
  readonly op: "copy";
  readonly phase: "after";
  readonly to: RelCanonical;
  readonly toAbsPath: RootedAbs<R>;
};

export type CopyError<R extends RootLiteral> = BaseEvent<R> & {
  readonly op: "copy";
  readonly phase: "error";
  readonly to: RelCanonical;
  readonly toAbsPath: RootedAbs<R>;
  readonly error: unknown;
};

export type StatBefore<R extends RootLiteral> = BaseEvent<R> & {
  readonly op: "stat";
  readonly phase: "before";
};

export type StatAfter<R extends RootLiteral> = BaseEvent<R> & {
  readonly op: "stat";
  readonly phase: "after";
  readonly stat: FsStat;
};

export type StatError<R extends RootLiteral> = BaseEvent<R> & {
  readonly op: "stat";
  readonly phase: "error";
  readonly error: unknown;
};

export type ListBefore<R extends RootLiteral> = BaseEvent<R> & {
  readonly op: "list";
  readonly phase: "before";
};

export type ListAfter<R extends RootLiteral> = BaseEvent<R> & {
  readonly op: "list";
  readonly phase: "after";
  readonly entries: readonly RelCanonical[];
};

export type ListError<R extends RootLiteral> = BaseEvent<R> & {
  readonly op: "list";
  readonly phase: "error";
  readonly error: unknown;
};

export type WatchChange<R extends RootLiteral> = BaseEvent<R> & {
  readonly op: "watch";
  readonly phase: "change";
  readonly kind: "create" | "modify" | "delete" | "rename";
  readonly oldPath?: RelCanonical;
  readonly oldAbsPath?: RootedAbs<R>;
};

export type ReactiveFsEvents<R extends RootLiteral> = {
  "write:before": WriteBefore<R>;
  "write:after": WriteAfter<R>;
  "write:error": WriteError<R>;
  "read:before": ReadBefore<R>;
  "read:after": ReadAfter<R>;
  "read:error": ReadError<R>;
  "mkdir:before": MkdirBefore<R>;
  "mkdir:after": MkdirAfter<R>;
  "mkdir:error": MkdirError<R>;
  "rm:before": RmBefore<R>;
  "rm:after": RmAfter<R>;
  "rm:error": RmError<R>;
  "move:before": MoveBefore<R>;
  "move:after": MoveAfter<R>;
  "move:error": MoveError<R>;
  "copy:before": CopyBefore<R>;
  "copy:after": CopyAfter<R>;
  "copy:error": CopyError<R>;
  "stat:before": StatBefore<R>;
  "stat:after": StatAfter<R>;
  "stat:error": StatError<R>;
  "list:before": ListBefore<R>;
  "list:after": ListAfter<R>;
  "list:error": ListError<R>;
  "watch:change": WatchChange<R>;
};

// ------------------------------ Reactive FS --------------------------------

export function newCorrelationId(): string {
  const r = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(r).map((b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${
    hex.slice(6, 8).join("")
  }-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

export class ReactiveFs<R extends RootLiteral> {
  #bus = eventBus<ReactiveFsEvents<R>>();

  constructor(readonly driver: RootedDriver<R>) {}

  get events() {
    return this.#bus;
  }

  async read(path: RelCanonical, opts?: { as?: "text" | "bytes" }) {
    const absPath = this.driver.resolveAbs(path);
    const correlationId = newCorrelationId();
    this.#bus.emit("read:before", {
      op: "read",
      phase: "before",
      provider: this.driver.provider,
      path,
      absPath,
      at: Date.now(),
      correlationId,
    });
    try {
      const data = await this.driver.read(path, opts);
      const bytes = typeof data === "string"
        ? new TextEncoder().encode(data).byteLength
        : data.byteLength;
      this.#bus.emit("read:after", {
        op: "read",
        phase: "after",
        provider: this.driver.provider,
        path,
        absPath,
        at: Date.now(),
        correlationId,
        bytes,
      });
      return data;
    } catch (error) {
      this.#bus.emit("read:error", {
        op: "read",
        phase: "error",
        provider: this.driver.provider,
        path,
        absPath,
        at: Date.now(),
        correlationId,
        error,
      });
      throw error;
    }
  }

  async write(
    path: RelCanonical,
    data: Uint8Array | string,
    opts?: { overwrite?: boolean },
  ) {
    const absPath = this.driver.resolveAbs(path);
    const correlationId = newCorrelationId();
    const inputKind: "bytes" | "text" = typeof data === "string"
      ? "text"
      : "bytes";
    const size = typeof data === "string"
      ? new TextEncoder().encode(data).byteLength
      : data.byteLength;
    this.#bus.emit("write:before", {
      op: "write",
      phase: "before",
      provider: this.driver.provider,
      path,
      absPath,
      at: Date.now(),
      correlationId,
      inputKind,
      size,
    });
    try {
      const bytesWritten = await this.driver.write(path, data, opts);
      this.#bus.emit("write:after", {
        op: "write",
        phase: "after",
        provider: this.driver.provider,
        path,
        absPath,
        at: Date.now(),
        correlationId,
        bytesWritten,
      });
      this.#bus.emit("watch:change", {
        op: "watch",
        phase: "change",
        provider: this.driver.provider,
        path,
        absPath,
        at: Date.now(),
        correlationId,
        kind: "modify",
      });
      return bytesWritten;
    } catch (error) {
      this.#bus.emit("write:error", {
        op: "write",
        phase: "error",
        provider: this.driver.provider,
        path,
        absPath,
        at: Date.now(),
        correlationId,
        error,
      });
      throw error;
    }
  }

  async mkdir(path: RelCanonical, opts?: { recursive?: boolean }) {
    const absPath = this.driver.resolveAbs(path);
    const correlationId = newCorrelationId();
    const recursive = opts?.recursive ?? false;
    this.#bus.emit("mkdir:before", {
      op: "mkdir",
      phase: "before",
      provider: this.driver.provider,
      path,
      absPath,
      at: Date.now(),
      correlationId,
      recursive,
    });
    try {
      await this.driver.mkdir(path, { recursive });
      this.#bus.emit("mkdir:after", {
        op: "mkdir",
        phase: "after",
        provider: this.driver.provider,
        path,
        absPath,
        at: Date.now(),
        correlationId,
        created: true,
      });
      this.#bus.emit("watch:change", {
        op: "watch",
        phase: "change",
        provider: this.driver.provider,
        path,
        absPath,
        at: Date.now(),
        correlationId,
        kind: "create",
      });
    } catch (error) {
      this.#bus.emit("mkdir:error", {
        op: "mkdir",
        phase: "error",
        provider: this.driver.provider,
        path,
        absPath,
        at: Date.now(),
        correlationId,
        error,
      });
      throw error;
    }
  }

  async rm(path: RelCanonical, opts?: { recursive?: boolean }) {
    const absPath = this.driver.resolveAbs(path);
    const correlationId = newCorrelationId();
    const recursive = opts?.recursive ?? false;
    this.#bus.emit("rm:before", {
      op: "rm",
      phase: "before",
      provider: this.driver.provider,
      path,
      absPath,
      at: Date.now(),
      correlationId,
      recursive,
    });
    try {
      await this.driver.rm(path, { recursive });
      this.#bus.emit("rm:after", {
        op: "rm",
        phase: "after",
        provider: this.driver.provider,
        path,
        absPath,
        at: Date.now(),
        correlationId,
        removed: true,
      });
      this.#bus.emit("watch:change", {
        op: "watch",
        phase: "change",
        provider: this.driver.provider,
        path,
        absPath,
        at: Date.now(),
        correlationId,
        kind: "delete",
      });
    } catch (error) {
      this.#bus.emit("rm:error", {
        op: "rm",
        phase: "error",
        provider: this.driver.provider,
        path,
        absPath,
        at: Date.now(),
        correlationId,
        error,
      });
      throw error;
    }
  }

  async move(
    from: RelCanonical,
    to: RelCanonical,
    opts?: { overwrite?: boolean },
  ) {
    const fromAbs = this.driver.resolveAbs(from);
    const toAbs = this.driver.resolveAbs(to);
    const correlationId = newCorrelationId();
    const overwrite = opts?.overwrite ?? false;
    this.#bus.emit("move:before", {
      op: "move",
      phase: "before",
      provider: this.driver.provider,
      path: from,
      absPath: fromAbs,
      at: Date.now(),
      correlationId,
      to,
      toAbsPath: toAbs,
      overwrite,
    });
    try {
      await this.driver.move(from, to, { overwrite });
      this.#bus.emit("move:after", {
        op: "move",
        phase: "after",
        provider: this.driver.provider,
        path: from,
        absPath: fromAbs,
        at: Date.now(),
        correlationId,
        to,
        toAbsPath: toAbs,
      });
      this.#bus.emit("watch:change", {
        op: "watch",
        phase: "change",
        provider: this.driver.provider,
        path: to,
        absPath: toAbs,
        at: Date.now(),
        correlationId,
        kind: "rename",
        oldPath: from,
        oldAbsPath: fromAbs,
      });
    } catch (error) {
      this.#bus.emit("move:error", {
        op: "move",
        phase: "error",
        provider: this.driver.provider,
        path: from,
        absPath: fromAbs,
        at: Date.now(),
        correlationId,
        to,
        toAbsPath: toAbs,
        error,
      });
      throw error;
    }
  }

  async copy(
    from: RelCanonical,
    to: RelCanonical,
    opts?: { overwrite?: boolean },
  ) {
    const fromAbs = this.driver.resolveAbs(from);
    const toAbs = this.driver.resolveAbs(to);
    const correlationId = newCorrelationId();
    const overwrite = opts?.overwrite ?? false;
    this.#bus.emit("copy:before", {
      op: "copy",
      phase: "before",
      provider: this.driver.provider,
      path: from,
      absPath: fromAbs,
      at: Date.now(),
      correlationId,
      to,
      toAbsPath: toAbs,
      overwrite,
    });
    try {
      await this.driver.copy(from, to, { overwrite });
      this.#bus.emit("copy:after", {
        op: "copy",
        phase: "after",
        provider: this.driver.provider,
        path: from,
        absPath: fromAbs,
        at: Date.now(),
        correlationId,
        to,
        toAbsPath: toAbs,
      });
      this.#bus.emit("watch:change", {
        op: "watch",
        phase: "change",
        provider: this.driver.provider,
        path: to,
        absPath: toAbs,
        at: Date.now(),
        correlationId,
        kind: "create",
      });
    } catch (error) {
      this.#bus.emit("copy:error", {
        op: "copy",
        phase: "error",
        provider: this.driver.provider,
        path: from,
        absPath: fromAbs,
        at: Date.now(),
        correlationId,
        to,
        toAbsPath: toAbs,
        error,
      });
      throw error;
    }
  }

  async list(dir: RelCanonical) {
    const absPath = this.driver.resolveAbs(dir);
    const correlationId = newCorrelationId();
    this.#bus.emit("list:before", {
      op: "list",
      phase: "before",
      provider: this.driver.provider,
      path: dir,
      absPath,
      at: Date.now(),
      correlationId,
    });
    try {
      const entries = await this.driver.list(dir);
      this.#bus.emit("list:after", {
        op: "list",
        phase: "after",
        provider: this.driver.provider,
        path: dir,
        absPath,
        at: Date.now(),
        correlationId,
        entries,
      });
      return entries;
    } catch (error) {
      this.#bus.emit("list:error", {
        op: "list",
        phase: "error",
        provider: this.driver.provider,
        path: dir,
        absPath,
        at: Date.now(),
        correlationId,
        error,
      });
      throw error;
    }
  }

  async stat(path: RelCanonical) {
    const absPath = this.driver.resolveAbs(path);
    const correlationId = newCorrelationId();
    this.#bus.emit("stat:before", {
      op: "stat",
      phase: "before",
      provider: this.driver.provider,
      path,
      absPath,
      at: Date.now(),
      correlationId,
    });
    try {
      const stat = await this.driver.stat(path);
      this.#bus.emit("stat:after", {
        op: "stat",
        phase: "after",
        provider: this.driver.provider,
        path,
        absPath,
        at: Date.now(),
        correlationId,
        stat,
      });
      return stat;
    } catch (error) {
      this.#bus.emit("stat:error", {
        op: "stat",
        phase: "error",
        provider: this.driver.provider,
        path,
        absPath,
        at: Date.now(),
        correlationId,
        error,
      });
      throw error;
    }
  }
}

// ------------------------------ Convenience --------------------------------

export function rel(path: string): RelCanonical {
  return parseRel(path);
}

export function rootFs<R extends RootLiteral>(
  driver: FsDriver,
  root: R,
  policy?: PathPolicy,
) {
  return rootedDriver(driver, root, policy);
}

export function reactiveFs<R extends RootLiteral>(driver: RootedDriver<R>) {
  return new ReactiveFs(driver);
}
