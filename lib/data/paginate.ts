// PostgREST returns at most 1000 rows per request. Every list read that can exceed that goes through here.
// The query passed in must have a stable order (add a unique column as the last order key).

export const PAGE_SIZE = 1000

type PageResult<T> = { data: T[] | null; error: { message: string } | null }

export async function fetchAll<T>(
  label: string,
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
  opts: { pageSize?: number; maxRows?: number } = {},
): Promise<T[]> {
  const size = opts.pageSize ?? PAGE_SIZE
  const max = opts.maxRows ?? 200_000
  const out: T[] = []
  for (let from = 0; from < max; from += size) {
    const { data, error } = await page(from, Math.min(from + size, max) - 1)
    if (error) throw new Error(`${label}: ${error.message}`)
    const rows = data ?? []
    out.push(...rows)
    if (rows.length < size) break
  }
  return out
}

/** Splits ids into chunks so `.in()` filters stay well under URL length limits. */
export function chunk<T>(items: T[], size = 150): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
