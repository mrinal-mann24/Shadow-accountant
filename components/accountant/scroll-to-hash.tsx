'use client'
// Scrolls to the #section in the address (for example #files, #follow-ups, #ticket-<id>, #message-<id>) once the
// page content is in. The client page streams in after its loading screen, so the browser's own jump to the hash
// happens too early (on the loading screen) and the page stays at the top. Links from Teams cards and Ask Shadow
// citations rely on this.
import { useEffect } from 'react'

/** Tries a few times while the content finishes streaming in. */
const TRIES = 10
const EVERY_MS = 100

export function ScrollToHash() {
  useEffect(() => {
    const raw = window.location.hash.slice(1)
    if (!raw) return
    let id: string
    try {
      id = decodeURIComponent(raw)
    } catch {
      return
    }
    let tries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const jump = () => {
      const el = document.getElementById(id)
      if (el) {
        el.scrollIntoView({ block: 'start' })
        return
      }
      if (++tries < TRIES) timer = setTimeout(jump, EVERY_MS)
    }
    jump()
    return () => clearTimeout(timer)
  }, [])
  return null
}
