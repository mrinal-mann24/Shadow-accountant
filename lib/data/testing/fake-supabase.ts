// In-memory stand-in for the Supabase query builder, for unit tests only. Supports the subset of the
// PostgREST API used by lib/data: select (incl. count head), update, eq, neq, in, lt, lte, gt, gte,
// order, range, limit, maybeSingle, single. Column lists in select() are ignored (full rows returned).

type R = Record<string, unknown>
export type FakeTables = Record<string, R[]>
export type FakeCall = { table: string; op: 'select' | 'update'; filters: string[]; patch?: R }

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
  private op: 'select' | 'update' = 'select'
  private patch: R | undefined

  constructor(
    private table: string,
    private tables: FakeTables,
    private calls: FakeCall[],
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

  private run(): { data: unknown; error: null | { message: string }; count?: number } {
    const rows = this.tables[this.table] ?? []
    const matched = rows.filter((r) => this.filters.every((f) => f(r)))
    this.calls.push({ table: this.table, op: this.op, filters: this.filterLog, patch: this.patch })
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

export function createFakeSupabase(tables: FakeTables) {
  const calls: FakeCall[] = []
  const client = { from: (table: string) => new FakeQuery(table, tables, calls) }
  return { client, calls, tables }
}
