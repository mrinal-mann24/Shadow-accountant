import Link from 'next/link'

export default function NotFound() {
  return (
    <main className="mx-auto max-w-md px-4 py-24">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">This page does not exist, or you do not have access to it.</p>
      <Link href="/home" className="mt-4 inline-block text-sm font-medium text-primary hover:underline">
        Go to Home
      </Link>
    </main>
  )
}
