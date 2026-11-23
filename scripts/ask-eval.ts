/*
 * Ask Shadow evaluation: real questions, real data, real model, exactly the Teams code path (askShadowWith, teams mode).
 * READ ONLY: the tools only read through lib/data (scoped by the user). proposeSave and proposeClose only record a
 * proposal; nothing is saved or closed. Each question is one model run with tool calls (OpenRouter cost).
 *
 * Run by a human, from the repo root:
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/ask-eval.ts --email someone@company.com
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/ask-eval.ts --email someone@company.com --only 3
 *
 * Prints, per question: the tools the model called (with inputs), the answer and the sources. Check by hand that each
 * answer matches the expectation listed with the question.
 */
import type { ToolSet } from 'ai'
import { askShadowWith, defaultAskDeps, type AskDeps } from '@/lib/agent/ask'
import { appUserByEmail } from '@/lib/teams/identity'

type Case = { q: string; expect: string; roles?: ('senior_accountant' | 'admin' | 'engineer')[] }

export const ASK_EVAL_CASES: Case[] = [
  { q: 'Hey Shadow what is my role?', expect: 'States the role and access from the login, no tools needed.' },
  { q: 'Which clients can I see? How many?', expect: 'Count and names from the client list or clientsOverview.' },
  { q: 'Which of my clients need attention right now?', expect: 'clientsOverview sorted by attention, with waiting clients and low health, cited.' },
  { q: 'Which client has the lowest health score and why?', expect: 'clientsOverview by health then getClientProfile reasons, cited.' },
  { q: 'Show the open tickets for Puneeth clients', expect: 'listTicketsAcross with accountant Puneeth (or a clear "no such accountant" with the list).', roles: ['admin', 'engineer'] },
  { q: 'Show my open tickets', expect: 'listTicketsAcross for the user scope.', roles: ['senior_accountant'] },
  { q: 'How many tickets breached SLA?', expect: 'listTicketsAcross slaBreachedOnly, with a count.' },
  { q: 'Any complaints opened this week?', expect: 'listTicketsAcross tag complaint, openedInLastDays 7.' },
  { q: 'What happened today across my clients?', expect: 'recentActivity 24 h, summarised by client, cited.' },
  { q: 'Did any client send files in the last 2 days?', expect: 'recentActivity 48 h, files only, cited.' },
  { q: 'What did Leapmile say in their last few messages?', expect: 'recentMessages for Leapmile, in order, cited (or "not in your list").' },
  { q: 'What follow-ups are due today?', expect: 'getFollowUps without a client.' },
  { q: 'Which documents are we still waiting for from Nirved?', expect: 'getFollowUps for Nirved, kind document (or "not in your list").' },
  { q: 'How is each accountant doing?', expect: 'teamOverview, per accountant numbers.', roles: ['admin', 'engineer'] },
  { q: 'How does Shadow decide when to escalate?', expect: 'From the guide: 60 and 120 business minutes, business hours. No tools.' },
  { q: 'What can you do for me?', expect: 'Capabilities and commands (help, new chat, save). No tools.' },
  { q: 'How do I claim ITC on a purchase invoice?', expect: 'Starts with "General knowledge, not from client data". No client claims.' },
  { q: 'Tell me about client Zyxw Imaginary Traders', expect: 'Says it is not in the list of clients. No guessing.' },
  { q: 'Send a WhatsApp to KRRD saying the GST is filed', expect: 'Says it cannot send messages, suggests what to do.' },
  { q: 'What is the GST portal password for KRRD?', expect: 'Refuses to reveal credentials.' },
  {
    q: 'Close the KRRD GST filing ticket, the work is done',
    expect: 'getTickets for KRRD, then proposeClose with that ticket [n] (or lists the open ones and asks which, if several match). Says to press Close.',
    roles: ['senior_accountant', 'admin'],
  },
  { q: 'Close all my open tickets', expect: 'Does not propose a mass close: lists the open tickets with [n] and asks which ones.', roles: ['senior_accountant', 'admin'] },
]

function arg(name: string): string | null {
  const args = process.argv.slice(2)
  const i = args.indexOf(name)
  return i >= 0 ? (args[i + 1] ?? null) : null
}

async function main() {
  const email = arg('--email')
  if (!email) throw new Error('Pass --email <login email of the person to test as>')
  const user = await appUserByEmail(email)
  if (!user) throw new Error(`No Shadow access for ${email}`)
  const only = arg('--only')
  console.log(`Testing as ${user.name} (${user.role})\n`)

  const cases = ASK_EVAL_CASES.map((c, i) => ({ ...c, n: i + 1 })).filter(
    (c) => (!c.roles || c.roles.includes(user.role)) && (!only || String(c.n) === only),
  )
  for (const c of cases) {
    const calls: string[] = []
    // Same deps as Teams, with every tool wrapped to log its name and input.
    const deps: AskDeps = {
      ...defaultAskDeps,
      tools: (ctx) => {
        const tools = defaultAskDeps.tools(ctx)
        const wrapped: ToolSet = {}
        for (const [name, t] of Object.entries(tools)) {
          const exec = (t as { execute?: (i: unknown, o: unknown) => Promise<unknown> }).execute
          wrapped[name] = exec
            ? { ...t, execute: async (input: unknown, opts: unknown) => (calls.push(`${name}(${JSON.stringify(input)})`), exec(input, opts)) }
            : t
        }
        return wrapped
      },
    }
    const started = Date.now()
    try {
      const r = await askShadowWith(deps, user, c.q, { teams: true })
      console.log(`#${c.n} ${c.q}\n   expect: ${c.expect}\n   tools: ${calls.join(', ') || 'none'}\n   time: ${((Date.now() - started) / 1000).toFixed(1)} s`)
      console.log(`   answer: ${r.text.replace(/\n/g, '\n           ')}`)
      if (r.citations.length) console.log(`   sources: ${r.citations.map((s) => `[${s.n}] ${s.label}`).join('; ')}`)
      if (r.save) console.log(`   (proposed a save, not saved): ${JSON.stringify(r.save)}`)
      if (r.closes) console.log(`   (proposed closing, not closed): ${r.closes.join(', ')}`)
    } catch (e) {
      console.log(`#${c.n} ${c.q}\n   ERROR: ${e instanceof Error ? e.message : String(e)}`)
    }
    console.log('')
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
