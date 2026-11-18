// In-memory stand-in for the Supabase query builder, for unit tests only. Supports the subset of the
// PostgREST API used by lib/data: select (incl. count head), update, insert, delete, eq, neq, in, lt, lte, gt, gte,
// order, range, limit, maybeSingle, single. Column lists in select() are ignored (full rows returned).
// Options: `unique` makes insert fail with Postgres code 23505 on a duplicate key; `fail` injects an error.

type R = Record<string, unknown>
export type FakeTables = Record<string, R[]>
export type FakeOp = 'select' | 'update' | 'insert' | 'delete'
export type FakeCall = { table: string; op: FakeOp; filters: string[]; patch?: R }
export type FakeError = { message: string; code?: string }
export type FakeOptions = {
  /** Unique keys per table, each a list of columns, e.g. { t: [['kind', 'ref_id']] }. */
  unique?: Record<string, string[][]>
  /** Return an error for a call instead of running it (null: run normally). */
  fail?: (call: { table: string; op: FakeOp }) => FakeError | null
}

function cmp(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === null || a === undefined) return 1
  if (b === null || b === undefined) return -1
  return String(a) < String(b) ? -1 : 1
}

class FakeQuery implements PromiseLike<unknown> {
  private filters: ((r: R) => boolean)[] = []
  private filterLog: string[] = []
  private orders: { col: string; asc: boolean }[] = []
  private from = 0
  private to: number | null = null
  private single: 'one' | 'maybe' | null = null
  private head = false
  private countMode = false
  private op: FakeOp = 'select'
  private patch: R | undefined
  private inserts: R[] = []

  constructor(
    private table: string,
    private tables: FakeTables,
    private calls: FakeCall[],
    private opts: FakeOptions = {},
  ) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (opts?.count) this.countMode = true
    if (opts?.head) this.head = true
    return this
  }
  update(patch: R) {
    this.op = 'update'
    this.patch = patch
    return this
  }
  insert(rows: R | R[]) {
    this.op = 'insert'
    this.inserts = Array.isArray(rows) ? rows : [rows]
    return this
  }
  delete() {
    this.op = 'delete'
    return this
  }
  private add(desc: string, f: (r: R) => boolean) {
    this.filterLog.push(desc)
    this.filters.push(f)
    return this
  }
  eq(col: string, v: unknown) {
    return this.add(`${col}=${String(v)}`, (r) => r[col] === v)
  }
  neq(col: string, v: unknown) {
    return this.add(`${col}!=${String(v)}`, (r) => r[col] !== v)
  }
  in(col: string, vs: unknown[]) {
    return this.add(`${col} in ${vs.length}`, (r) => vs.includes(r[col]))
  }
  is(col: string, v: null | boolean) {
    return this.add(`${col} is ${String(v)}`, (r) => (v === null ? r[col] == null : r[col] === v))
  }
  lt(col: string, v: unknown) {
    return this.add(`${col}<${String(v)}`, (r) => r[col] != null && cmp(r[col], v) < 0)
  }
  lte(col: string, v: unknown) {
    return this.add(`${col}<=${String(v)}`, (r) => r[col] != null && cmp(r[col], v) <= 0)
  }
  gt(col: string, v: unknown) {
    return this.add(`${col}>${String(v)}`, (r) => r[col] != null && cmp(r[col], v) > 0)
  }
  gte(col: string, v: unknown) {
    return this.add(`${col}>=${String(v)}`, (r) => r[col] != null && cmp(r[col], v) >= 0)
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orders.push({ col, asc: opts?.ascending !== false })
    return this
  }
  range(from: number, to: number) {
    this.from = from
    this.to = to
    return this
  }
  limit(n: number) {
    this.from = 0
    this.to = n - 1
    return this
  }
  maybeSingle() {
    this.single = 'maybe'
    return this
  }
  singleRow() {
    this.single = 'one'
    return this
  }

  private run(): { data: unknown; error: null | FakeError; count?: number } {
    const rows = this.tables[this.table] ?? []
    this.calls.push({
      table: this.table,
      op: this.op,
      filters: this.filterLog,
      patch: this.op === 'insert' ? this.inserts[0] : this.patch,
    })
    const failed = this.opts.fail?.({ table: this.table, op: this.op }) ?? null
    if (failed) return { data: null, error: failed }
    if (this.op === 'insert') {
      const keys = this.opts.unique?.[this.table] ?? []
      const all = [...rows]
      for (const row of this.inserts) {
        if (keys.some((cols) => all.some((r) => cols.every((c) => r[c] === row[c])))) {
          return { data: null, error: { message: 'duplicate key value violates unique constraint', code: '23505' } }
        }
        all.push(row)
      }
      const added = this.inserts.map((r) => ({ ...r }))
      this.tables[this.table] = [...rows, ...added]
      return { data: added.map((r) => ({ ...r })), error: null }
    }
    const matched = rows.filter((r) => this.filters.every((f) => f(r)))
    if (this.op === 'delete') {
      this.tables[this.table] = rows.filter((r) => !matched.includes(r))
      return { data: matched.map((r) => ({ ...r })), error: null }
    }
    if (this.op === 'update') {
      for (const r of matched) Object.assign(r, this.patch)
      return { data: matched.map((r) => ({ ...r })), error: null }
    }
    if (this.head) return { data: null, error: null, count: matched.length }
    const sorted = [...matched].sort((a, b) => {
      for (const o of this.orders) {
        const c = cmp(a[o.col], b[o.col])
        if (c !== 0) return o.asc ? c : -c
      }
      return 0
    })
    const sliced = sorted.slice(this.from, this.to === null ? undefined : this.to + 1).map((r) => ({ ...r }))
    if (this.single) {
      if (sliced.length > 1) return { data: null, error: { message: 'multiple rows' } }
      if (sliced.length === 0 && this.single === 'one') return { data: null, error: { message: 'no rows' } }
      return { data: sliced[0] ?? null, error: null }
    }
    return { data: sliced, error: null, ...(this.countMode ? { count: matched.length } : {}) }
  }

  then<A = unknown, B = never>(
    onfulfilled?: ((value: unknown) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve()
      .then(() => this.run())
      .then(onfulfilled, onrejected)
  }
}

export function createFakeSupabase(tables: FakeTables, opts: FakeOptions = {}) {
  const calls: FakeCall[] = []
  const client = { from: (table: string) => new FakeQuery(table, tables, calls, opts) }
  return { client, calls, tables }
}
