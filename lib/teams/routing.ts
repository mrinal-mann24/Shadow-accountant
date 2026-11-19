// Where Shadow posts a card: each person's 1:1 chat with Shadow first, a linked channel only as the fallback.
// Used by the teams-notify job (lib/teams/notify.ts), the follow-ups job (lib/followups/job.ts) and the bot
// (ping and reassign). Pure apart from the injected store and user lookup, so it is unit tested.
//
//   Senior Accountant  -> their own 1:1 chat (cards for their clients: tickets, reminders, files, follow-ups)
//   Admin, Engineer    -> their own 1:1 chat (escalations)
//   nobody in 1:1      -> the accountant's linked channel / the Escalations channel, when those still exist
//
// Roles are looked up again from the email on every load (the same rules as web sign-in), so a person who loses
// access stops getting cards at once, even though their chat is still stored.

import type { Role } from '@/lib/auth/types'
import type { DeliveryTarget, PersonalChat, PersonalChats, ResolveUser, TeamsChannelMap, TeamsStore } from './types'

export const ESCALATION_ROLES: readonly Role[] = ['admin', 'engineer']

export type Routes = {
  /** The accountant's 1:1 chat, else their linked channel, else null. */
  accountant(vaId: string | null): DeliveryTarget | null
  /** 1:1 chats of Admins and Engineers, else the Escalations channel, else []. */
  escalations(): DeliveryTarget[]
  /** True when there is anywhere at all to post. */
  any: boolean
  /** Stored chats skipped: no access any more, or the lookup failed (with why). */
  skipped: string[]
  /**
   * True when a role lookup failed. Then a card for an accountant with no route must wait for the next run instead of
   * going to the escalation chats: the missing route may be that accountant's own chat.
   */
  lookupFailed: boolean
}

export type RoutingDeps = { store: Pick<TeamsStore, 'channels' | 'personalChats' | 'accountants'>; resolveUser: ResolveUser }

function personalTarget(chat: PersonalChat, name: string): DeliveryTarget {
  return { id: chat.conversationId, name: `${name} (1:1)`, serviceUrl: chat.serviceUrl }
}

/** Builds the routes from the stored 1:1 chats and the channel map (either may be empty). */
export async function loadRoutes(deps: RoutingDeps): Promise<Routes> {
  const [map, chats, accountants] = await Promise.all([deps.store.channels(), deps.store.personalChats(), deps.store.accountants()])
  const vaEmails = new Map(accountants.filter((a) => a.email).map((a) => [a.vaId, (a.email as string).trim().toLowerCase()]))
  return buildRoutes(map, chats, deps.resolveUser, vaEmails)
}

/**
 * vaEmails (va_id -> login email) lets an accountant who has a stored 1:1 chat skip the channel fallback even when
 * their chat cannot be used this run (lookup failed, or no access any more): cards for them never go back to a
 * shared channel once they use the 1:1 chat.
 */
export async function buildRoutes(
  map: TeamsChannelMap | null,
  chats: PersonalChats,
  resolveUser: ResolveUser,
  vaEmails: Map<string, string> = new Map(),
): Promise<Routes> {
  const byVa = new Map<string, DeliveryTarget>()
  const escalations: DeliveryTarget[] = []
  const skipped: string[] = []
  let lookupFailed = false
  // Look everyone up together (each lookup reads the accountants and auth users), then route in stored order.
  const entries = Object.entries(chats)
  const looked = await Promise.all(
    entries.map(async ([email]) => {
      try {
        return { ok: true as const, user: await resolveUser(email) }
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
      }
    }),
  )
  for (const [i, [email, chat]] of entries.entries()) {
    const r = looked[i]
    if (!r.ok) {
      lookupFailed = true
      skipped.push(`${email}: lookup failed (${r.error})`)
      continue
    }
    const user = r.user
    if (!user || user.viewingAs) {
      skipped.push(`${email}: no access`)
      continue
    }
    const target = personalTarget(chat, user.name || chat.name || email)
    if (user.role === 'senior_accountant' && user.vaId) byVa.set(user.vaId, target)
    if (ESCALATION_ROLES.includes(user.role) && !escalations.some((t) => t.id === target.id)) escalations.push(target)
  }

  const channel = (ref: { id: string; name: string | null } | null | undefined): DeliveryTarget | null =>
    ref && map ? { id: ref.id, name: ref.name, serviceUrl: map.serviceUrl } : null
  const escalationsChannel = channel(map?.escalations)
  const finalEscalations = escalations.length ? escalations : escalationsChannel ? [escalationsChannel] : []

  return {
    accountant: (vaId) => {
      if (!vaId) return null
      const own = byVa.get(vaId)
      if (own) return own
      const email = vaEmails.get(vaId)
      if (email && chats[email]) return null // uses the 1:1 chat, but it cannot be used this run: no channel fallback
      return channel(map?.accountants[vaId])
    },
    escalations: () => finalEscalations,
    any: byVa.size > 0 || finalEscalations.length > 0 || Object.keys(map?.accountants ?? {}).length > 0,
    skipped,
    lookupFailed,
  }
}
