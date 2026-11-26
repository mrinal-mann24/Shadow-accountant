'use client'

// Admin only: pick a Senior Accountant; submits the surrounding GET form (?va=) on change.
export function SeniorFilter({ seniors, value }: { seniors: { id: string; name: string }[]; value: string }) {
  return (
    <>
      <label htmlFor="client-senior" className="sr-only">
        Senior Accountant
      </label>
      <select
        id="client-senior"
        name="va"
        defaultValue={value}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="press h-10 max-w-full rounded-xl border bg-card px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <option value="">All seniors</option>
        {seniors.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </>
  )
}
