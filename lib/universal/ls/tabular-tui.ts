import {
  bold,
  cyan,
  gray,
  green,
  magenta,
  yellow,
} from "jsr:@std/fmt@1/colors";

/* ------------------------------------------------------------------------------------------------
 * Public helpers & shared types
 * ----------------------------------------------------------------------------------------------*/

export type Iterish<T> = Iterable<T> | AsyncIterable<T>;

/** Human-friendly byte size (KiB, MiB…). */
export function humanSize(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const neg = n < 0;
  let v = Math.abs(n);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const s = (v >= 100 || v % 1 === 0) ? v.toFixed(0) : v.toFixed(1);
  return `${neg ? "-" : ""}${s} ${units[i]}`;
}

/** Strip ANSI sequences so we can compute printable width correctly. */
function stripAnsi(s: string): string {
  // This regex is standard for SGR codes; annotated to silence the lint rule.
  // deno-lint-ignore no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, "");
}

type Colorize = (s: string) => string;

/* ------------------------------------------------------------------------------------------------
 * Column definitions
 * ----------------------------------------------------------------------------------------------*/

type Align = "left" | "right";

export type ColumnDef<T, V> = {
  id: string;
  header: string;
  align: Align;
  width?: number; // computed at build unless provided
  accessor: (row: T) => V;
  // Optional stringifier/formatter
  format?: (val: V, row: T) => string;
  // Optional comparator for sortBy safety (esp. non-primitives)
  compare?: (a: V, b: V) => number;
  // Coloring
  defaultColor?: Colorize;
  rules?: Array<{ when: (val: V, row: T) => boolean; color: Colorize }>;
};

function defaultStringify<V>(v: V): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean" || t === "bigint") {
    return String(v);
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/* ------------------------------------------------------------------------------------------------
 * ObjectLister (built renderer)
 * ----------------------------------------------------------------------------------------------*/

export class ObjectLister<T, C extends Record<string, unknown>> {
  constructor(
    private readonly rows: Iterish<T>,
    private readonly cols: ReadonlyArray<ColumnDef<T, unknown>>,
    private readonly order: ReadonlyArray<string>,
    private readonly showHeader: boolean,
    private readonly useCompact: boolean,
    private readonly iconCb?: (row: T) => string,
    private readonly colorOn: boolean = true,
    private readonly sortState?: { id: string; dir: "asc" | "desc" },
    private readonly strictSortSafety: boolean = true,
  ) {}

  /** Render to string (and optionally print). */
  async ls(print = true): Promise<string> {
    // Materialize rows
    const items: T[] = [];
    if ((this.rows as AsyncIterable<T>)[Symbol.asyncIterator]) {
      for await (const r of this.rows as AsyncIterable<T>) items.push(r);
    } else {
      for (const r of this.rows as Iterable<T>) items.push(r);
    }

    // Order columns by configured order
    const byId = new Map(this.cols.map((c) => [c.id, c]));
    const orderedCols: ReadonlyArray<ColumnDef<T, unknown>> = this.order
      .map((id) => {
        const c = byId.get(id);
        if (!c) {
          throw new Error(
            `[lister-tui] Unknown column id in order: ${id}`,
          );
        }
        return c;
      });

    // Strict sort safety: if sorting on a column whose accessor returns a non-primitive
    // (and not Date) and no compare provided, throw with a helpful message.
    let rows = items;
    if (this.sortState) {
      const col = byId.get(this.sortState.id);
      if (!col) {
        throw new Error(
          `[lister-tui] sortBy column not found: ${this.sortState.id}`,
        );
      }
      const sample = items[0];
      if (sample) {
        const val = (col.accessor as (r: T) => unknown)(sample);
        const isPrimitive = val == null ||
          typeof val === "string" ||
          typeof val === "number" ||
          typeof val === "boolean" ||
          typeof val === "bigint" ||
          typeof val === "symbol" ||
          val instanceof Date;
        if (this.strictSortSafety && !isPrimitive && !col.compare) {
          throw new Error(
            `[lister-tui] sortBy("${col.id}") needs a .compare(...) because accessor returns a non-primitive. ` +
              `Either provide a compare or sort by a primitive column.`,
          );
        }
      }
      const dir = this.sortState.dir === "asc" ? 1 : -1;
      rows = [...rows].sort((a, b) => {
        const va = col.accessor(a) as unknown;
        const vb = col.accessor(b) as unknown;
        if (col.compare) return dir * col.compare(va, vb);
        // Fall back to default comparisons for primitives & Date
        if (va instanceof Date && vb instanceof Date) {
          return dir * (va.getTime() - vb.getTime());
        }
        const sa = typeof va === "string" ? va : String(va ?? "");
        const sb = typeof vb === "string" ? vb : String(vb ?? "");
        if (sa < sb) return -1 * dir;
        if (sa > sb) return 1 * dir;
        return 0;
      });
    }

    // Compute column widths (table mode)
    const widths: number[] = [];
    const headCells = orderedCols.map((c) => c.header ?? "");
    const dataRows: string[][] = [];

    // Prepare rows as strings (apply format/color)
    for (const r of rows) {
      const icon = this.iconCb ? (this.iconCb(r) ?? "") : "";
      const rowCells: string[] = [];
      orderedCols.forEach((c, idx) => {
        const raw = c.accessor(r) as unknown;
        const formatted = c.format
          ? (c.format as (v: unknown, row: T) => string)(raw, r)
          : defaultStringify(raw);
        const colored = this.colorOn
          ? colorizeCell(formatted, raw, r, c)
          : formatted;
        // Prepend icon to the first visible column
        rowCells.push(idx === 0 ? icon + colored : colored);
      });
      dataRows.push(rowCells);
    }

    if (!this.useCompact) {
      for (let i = 0; i < orderedCols.length; i++) {
        const col = orderedCols[i];
        const head = headCells[i] ?? "";
        let w = stripAnsi(head).length;
        for (const dr of dataRows) {
          w = Math.max(w, stripAnsi(dr[i]).length);
        }
        widths[i] = col.width ?? w;
      }
    }

    // Render
    let out = "";
    if (this.showHeader) {
      const line = this.useCompact
        ? joinCompact(headCells)
        : joinGrid(headCells, widths, orderedCols.map((c) => c.align));
      out += bold(line) + "\n";
      if (!this.useCompact) {
        const sep = orderedCols.map((_c, i) =>
          "-".repeat(Math.max(1, widths[i]))
        ); // dashes
        out += joinGrid(sep, widths, orderedCols.map((_c) => "left")) +
          "\n";
      }
    }

    for (const dr of dataRows) {
      out += this.useCompact
        ? joinCompact(dr)
        : joinGrid(dr, widths, orderedCols.map((c) => c.align));
      out += "\n";
    }

    if (print) console.log(out.trimEnd());
    return out;
  }
}

function colorizeCell<T, V>(
  text: string,
  val: V,
  row: T,
  def: ColumnDef<T, V>,
): string {
  let paint: Colorize | undefined = def.defaultColor;
  if (def.rules && def.rules.length) {
    for (const rule of def.rules) {
      if (rule.when(val, row)) {
        paint = rule.color;
        break;
      }
    }
  }
  return paint ? paint(text) : text;
}

function joinCompact(cols: string[]): string {
  return cols.join("  ");
}

function padLeft(s: string, width: number): string {
  const diff = width - stripAnsi(s).length;
  return diff > 0 ? " ".repeat(diff) + s : s;
}
function padRight(s: string, width: number): string {
  const diff = width - stripAnsi(s).length;
  return diff > 0 ? s + " ".repeat(diff) : s;
}
function joinGrid(cols: string[], widths: number[], aligns: Align[]): string {
  const parts: string[] = [];
  for (let i = 0; i < cols.length; i++) {
    const w = Math.max(1, widths[i] ?? stripAnsi(cols[i]).length);
    const s = aligns[i] === "right"
      ? padLeft(cols[i], w)
      : padRight(cols[i], w);
    parts.push(s);
  }
  return parts.join("  ");
}

/* ------------------------------------------------------------------------------------------------
 * ListerBuilder (strongly typed builder)
 * ----------------------------------------------------------------------------------------------*/

type SortDir = "asc" | "desc";

export class ListerBuilder<
  T,
  C extends Record<string, unknown> = Record<string, unknown>,
  I extends string = string,
> {
  private rows?: Iterish<T>;
  private defs: ColumnDef<T, unknown>[] = [];
  private idToDef = new Map<string, ColumnDef<T, unknown>>();
  private colOrder: string[] = [];
  private selectedOrder?: string[];
  private showHeader = true;
  private useCompact = false;
  private iconCb?: (row: T) => string;
  private colorOn = true;
  private sort?: { id: string; dir: SortDir };
  private strictSortSafety = true;
  private requireOne = false;
  private allowedIds?: Set<string>;

  /* ---------------- configuration ---------------- */

  /** Start/replace the data source. */
  from(rows: Iterish<T>) {
    this.rows = rows;
    return this;
  }

  /** Turn colors on/off (on by default). */
  color(on = true) {
    this.colorOn = on;
    return this;
  }

  /** Show header row (default true). */
  header(on = true) {
    this.showHeader = on;
    return this;
  }

  /** Compact mode (no alignment/padding). */
  compact(on = false) {
    this.useCompact = on;
    return this;
  }

  /** Set a per-row icon, rendered before the first column. */
  icon(cb: (row: T) => string) {
    this.iconCb = cb;
    return this;
  }

  /** Enforce that at least one column must be defined when building. */
  requireAtLeastOneColumn(on = true) {
    this.requireOne = on;
    return this;
  }

  /** Reject ad-hoc column IDs; only these IDs are allowed. */
  declareColumns<Ids extends string>(...ids: Ids[]) {
    this.allowedIds = new Set(ids);
    // Widen the C map to include these keys (with unknown values)
    return this as unknown as ListerBuilder<T, Record<Ids, unknown>, Ids>;
  }

  private assertAllowed(id: string) {
    if (
      this.allowedIds && this.allowedIds.size > 0 &&
      !this.allowedIds.has(id)
    ) {
      const list = [...this.allowedIds].sort().join(", ");
      throw new Error(
        `[lister-tui] Column id "${id}" not in declared namespace. Allowed: ${list}`,
      );
    }
  }

  /* ---------------- column factories ---------------- */

  /** Lowest-level column. Use when other helpers don't fit. */
  column<V>(
    id: I & string,
    accessor: (row: T) => V,
    cfg: Partial<Omit<ColumnDef<T, V>, "id" | "accessor">> = {},
  ) {
    this.assertAllowed(id);
    const def: ColumnDef<T, V> = {
      id,
      header: cfg.header ?? id,
      align: cfg.align ?? "left",
      width: cfg.width,
      accessor,
      format: cfg.format,
      compare: cfg.compare,
      defaultColor: cfg.defaultColor,
      rules: cfg.rules as
        | Array<{ when: (val: V, row: T) => boolean; color: Colorize }>
        | undefined,
    };
    this.add(def as unknown as ColumnDef<T, unknown>);
    return this;
  }

  /** Column that maps directly from a key on T. */
  field<K extends I & string, Key extends keyof T>(
    id: K,
    key: Key,
    cfg: Partial<Omit<ColumnDef<T, T[Key]>, "id" | "accessor">> = {},
  ) {
    return this.column<T[Key]>(
      id,
      (row) => row[key],
      cfg as Partial<ColumnDef<T, T[Key]>>,
    );
  }

  /** Numeric column with built-in right alignment and number formatting. */
  numeric<K extends I & string>(
    id: K,
    accessor: (row: T) => number,
    cfg: Partial<Omit<ColumnDef<T, number>, "id" | "accessor">> = {},
  ) {
    const merged = {
      align: "right" as const,
      ...cfg,
    };
    return this.column<number>(id, accessor, merged);
  }

  /** Date/Time column — accessor can return Date, string, or number. */
  date<K extends I & string>(
    id: K,
    accessor: (row: T) => Date | string | number,
    cfg: Partial<
      Omit<ColumnDef<T, Date | string | number>, "id" | "accessor">
    > = {},
  ) {
    const fmtr = cfg.format ?? ((v: Date | string | number) => {
      const d = v instanceof Date ? v : new Date(v);
      if (!Number.isFinite(d.getTime())) return String(v);
      const p = (x: number) => String(x).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${
        p(d.getHours())
      }:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    });
    return this.column<Date | string | number>(id, accessor, {
      ...cfg,
      format: fmtr,
    });
  }

  private add(def: ColumnDef<T, unknown>) {
    if (this.idToDef.has(def.id)) {
      // Replace existing definition (e.g., user redefines)
      const idx = this.defs.findIndex((d) => d.id === def.id);
      if (idx >= 0) this.defs[idx] = def;
      this.idToDef.set(def.id, def);
      return;
    }
    this.defs.push(def);
    this.idToDef.set(def.id, def);
    this.colOrder.push(String(def.id));
  }

  /* ---------------- selection & sorting ---------------- */

  /** Reorder/subset columns; IDs must already exist. */
  select(...ids: ReadonlyArray<keyof C & string>) {
    // runtime validation to help juniors
    for (const id of ids) {
      if (!this.idToDef.has(String(id))) {
        const known = this.defs.map((d) => d.id).join(", ");
        throw new Error(
          `[lister-tui] select(): unknown id "${String(id)}". Known: ${known}`,
        );
      }
    }
    this.selectedOrder = Array.from(ids as ReadonlyArray<string>);
    return this;
  }

  /** Set the column to sort by. */
  sortBy(id: keyof C & string) {
    this.sort = { id: String(id), dir: this.sort?.dir ?? "asc" };
    return this;
  }

  /** Sort direction. */
  sortDir(dir: SortDir) {
    if (!this.sort) this.sort = { id: this.defs[0]?.id ?? "", dir };
    else this.sort.dir = dir;
    return this;
  }

  /** Toggle strict sort safety (on by default). */
  strictSort(on = true) {
    this.strictSortSafety = on;
    return this;
  }

  /* ---------------- build ---------------- */

  build(): ObjectLister<T, C> {
    if (!this.rows) {
      throw new Error(
        "[lister-tui] .from(rows) is required before build()",
      );
    }
    if (this.requireOne && this.defs.length === 0) {
      throw new Error(
        "[lister-tui] No columns defined. Call .field() / .numeric() / .date() / .column() first.",
      );
    }
    const order = (this.selectedOrder ?? this.colOrder).slice();
    return new ObjectLister<T, C>(
      this.rows,
      this.defs,
      order,
      this.showHeader,
      this.useCompact,
      this.iconCb,
      this.colorOn,
      this.sort ? { id: this.sort.id, dir: this.sort.dir } : undefined,
      this.strictSortSafety,
    );
  }
}

/* ------------------------------------------------------------------------------------------------
 * Presets (optional helpers)
 * ----------------------------------------------------------------------------------------------*/

export const presets = {
  files<
    T extends {
      name?: string;
      path?: string;
      size?: number;
      mtime?: Date | string | number;
      kind?: string;
      isDir?: boolean;
    },
  >(): ListerBuilder<
    T,
    Record<"name" | "size" | "updated" | "path" | "type", unknown>,
    "name" | "size" | "updated" | "path" | "type"
  > {
    const b = new ListerBuilder<T>()
      .declareColumns<"name" | "size" | "updated" | "path" | "type">(
        "name",
        "size",
        "updated",
        "path",
        "type",
      )
      .color(true)
      .header(true)
      .compact(false)
      .icon((r) => (r.isDir ? "📁" : "📄"));

    const hasName = "name" in ({} as T);
    const hasPath = "path" in ({} as T);

    if (hasName) {
      b.field("name", "name" as keyof T, {
        header: "NAME",
        defaultColor: cyan,
      });
    } else if (hasPath) {
      b.field("name", "path" as keyof T, {
        header: "NAME",
        defaultColor: cyan,
      });
    }

    b.numeric("size", (r) => Number((r as { size?: number }).size ?? 0), {
      header: "SIZE",
      format: humanSize,
      defaultColor: green,
    });

    b.date(
      "updated",
      (r) => (r as { mtime?: Date | string | number }).mtime ?? "",
      {
        header: "MODIFIED",
      },
    );

    if (hasPath) {
      b.field("path", "path" as keyof T, {
        header: "PATH",
        defaultColor: gray,
      });
    }
    b.field("type", "kind" as keyof T, {
      header: "TYPE",
      defaultColor: magenta,
    });

    return b;
  },

  processes<
    T extends {
      pid?: number;
      ppid?: number;
      user?: string;
      cpu?: number;
      mem?: number;
      start?: Date | string | number;
      command?: string;
    },
  >(): ListerBuilder<
    T,
    Record<"pid" | "user" | "cpu" | "mem" | "start" | "command", unknown>,
    "pid" | "user" | "cpu" | "mem" | "start" | "command"
  > {
    const b = new ListerBuilder<T>()
      .declareColumns<
        "pid" | "user" | "cpu" | "mem" | "start" | "command"
      >("pid", "user", "cpu", "mem", "start", "command")
      .header(true)
      .compact(false);

    b.numeric("pid", (r) => Number((r as { pid?: number }).pid ?? 0), {
      header: "PID",
      defaultColor: yellow,
    });
    b.field("user", "user" as keyof T, {
      header: "USER",
      defaultColor: cyan,
    });
    b.numeric("cpu", (r) => Number((r as { cpu?: number }).cpu ?? 0), {
      header: "CPU %",
      format: (n) => n.toFixed(1),
    });
    b.numeric("mem", (r) => Number((r as { mem?: number }).mem ?? 0), {
      header: "MEM %",
      format: (n) => n.toFixed(1),
    });
    b.date(
      "start",
      (r) => (r as { start?: Date | string | number }).start ?? "",
      { header: "START" },
    );
    b.field("command", "command" as keyof T, {
      header: "COMMAND",
      defaultColor: gray,
    });

    return b;
  },
};
