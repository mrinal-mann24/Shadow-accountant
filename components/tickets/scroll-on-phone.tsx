'use client'
// On phone width the reply timeline stacks below the list, so after picking a ticket we bring the panel into
// view. On wider screens the panel is already beside the list and nothing moves.
import { useEffect } from 'react'

/** Runs when `ticketId` changes (a new ticket was picked), only while `active` (the URL names a ticket). */
export function ScrollIntoViewOnPhone({ targetId, ticketId, active }: { targetId: string; ticketId: string; active: boolean }) {
  useEffect(() => {
    if (!active) return
    if (!window.matchMedia('(max-width: 1023px)').matches) return
    document.getElementById(targetId)?.scrollIntoView({ block: 'start' })
  }, [targetId, ticketId, active])
  return null
}
