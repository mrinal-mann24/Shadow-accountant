'use client'
import { useEffect } from 'react'
import { Button } from '@/components/ui/button'

/** Error boundary body for the accountant routes. Shows no internal details. */
export function PageError({ error, retry, reset }: { error: unknown; retry?: () => void; reset?: () => void }) {
  useEffect(() => {
    console.error(error)
  }, [error])
  const again = retry ?? reset
  return (
    <div className="mx-auto flex max-w-md flex-col items-start gap-3 py-12">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-sm text-muted-foreground">We could not load this page. Please try again in a moment.</p>
      {again && (
        <Button type="button" variant="outline" onClick={() => again()}>
          Try again
        </Button>
      )}
    </div>
  )
}
