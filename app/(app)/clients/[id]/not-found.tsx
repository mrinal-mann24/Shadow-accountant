import Link from 'next/link'

export default function ClientNotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-start gap-3 py-12">
      <h1 className="text-xl font-semibold">Client not found</h1>
      <p className="text-sm text-muted-foreground">This client does not exist or is not assigned to you.</p>
      <Link href="/clients" className="text-sm underline">
        Back to clients
      </Link>
    </div>
  )
}
