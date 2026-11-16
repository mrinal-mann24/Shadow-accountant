'use client'
import { PageError } from '@/components/accountant/page-error'

export default function Error(props: { error: unknown; retry?: () => void; reset?: () => void }) {
  return <PageError {...props} />
}
