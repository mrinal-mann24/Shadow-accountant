'use client'
// Fallback for every signed-in page without its own error.tsx (Ask AI, Engineer, Admin).
import { PageError } from '@/components/accountant/page-error'

export default function Error(props: { error: unknown; retry?: () => void; reset?: () => void }) {
  return <PageError {...props} />
}
