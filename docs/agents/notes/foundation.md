# foundation notes

Status: DONE. `npm run build` (no env set), `typecheck`, `test` (3 files, 19 tests) and `lint` all pass.

## Built
- Next.js 16.4.6 App Router, TypeScript strict, no `src/`: `app/`, `components/`, `lib/` at repo root. Path alias `@/*` to repo root.
- Tailwind CSS v4 via `@tailwindcss/postcss` (`postcss.config.mjs`), no tailwind.config file; theme lives in `app/globals.css`.
- ESLint 9 flat config (`eslint.config.mjs`): `eslint-config-next/core-web-vitals` + `eslint-config-next/typescript`.
  Ignores `.next`, `out`, `build`, `coverage`, `next-env.d.ts`, `lib/db/database.types.ts`.
- Vitest 5 (`vitest.config.mts`): node environment, `@` alias, `server-only` aliased to its empty module so
  server-only files can be unit tested. Tests: `**/*.test.ts(x)`.
- shadcn/ui (new-york, `components.json`, radix-ui unified package) in `components/ui/`: avatar, badge, button,
  card, dialog, dropdown-menu, input, label, scroll-area, select, separator, sheet, skeleton, table, tabs,
  textarea, tooltip.
- `app/layout.tsx` (lang en-IN, wraps everything in `TooltipProvider`, metadata title template
  `%s | Shadow Accounting`), `app/globals.css` (tokens), `app/page.tsx` (redirects to `/home`).
- `lib/env.ts`, `lib/supabase/{server,browser,admin}.ts`, `lib/db/types.ts`, `lib/jobs/guard.ts`, `lib/utils.ts`,
  `.env.example`, plus tests `lib/env.test.ts`, `lib/jobs/guard.test.ts`, `lib/utils.test.ts`.

## Exports (exact import paths + signatures)
```ts
// lib/env.ts  (lazy: nothing validated at import; call inside handlers/jobs only)
import { serverEnv, publicEnv, type ServerEnv, type PublicEnv } from '@/lib/env'
serverEnv(): ServerEnv
//   { NEXT_PUBLIC_SUPABASE_URL: string; NEXT_PUBLIC_SUPABASE_ANON_KEY: string; SUPABASE_SERVICE_ROLE_KEY: string
//     OPENROUTER_API_KEY?: string; OPENROUTER_MODEL_A?: string; OPENROUTER_MODEL_B?: string; OPENROUTER_EMBED_MODEL?: string
//     CRON_SECRET?: string; JOBS_WRITE_ENABLED: boolean; HUBSPOT_ACCESS_TOKEN?: string; HUBSPOT_WEBHOOK_SECRET?: string
//     DEV_LOGIN_EMAIL?: string; APP_TIMEZONE: string /* 'Asia/Kolkata' default */ }
//   Cached after first success. Blank strings count as unset. Throws Error('Invalid environment: ...') naming each problem.
publicEnv(): { NEXT_PUBLIC_SUPABASE_URL: string; NEXT_PUBLIC_SUPABASE_ANON_KEY: string }  // browser-safe, throws if missing

// lib/supabase/server.ts  ('server-only'; uses next/headers cookies)
import { createServerSupabase } from '@/lib/supabase/server'
createServerSupabase(): Promise<SupabaseClient<Database>>   // anon key + user session; use for auth.getUser() for now

// lib/supabase/browser.ts  (auth only: sign in / out, session; memoised singleton)
import { createBrowserSupabase } from '@/lib/supabase/browser'
createBrowserSupabase(): SupabaseClient<Database>

// lib/supabase/admin.ts  ('server-only'; service role; no session persistence; memoised)
import { createAdminSupabase } from '@/lib/supabase/admin'
createAdminSupabase(): SupabaseClient<Database>

// lib/db/types.ts
import type { Database, Json, TableName, ViewName, Row, Insert, Update, ViewRow } from '@/lib/db/types'
// Row<'clients'>, Insert<'conversations'>, Update<'client_scores'>, ViewRow<'conversation_response_lags'>

// lib/jobs/guard.ts  (reads process.env at call time, not cached, so it does not need Supabase env)
import { assertCronAuth, jobsWriteEnabled, type JobResult } from '@/lib/jobs/guard'
assertCronAuth(req: Request): void   // throws Response 401 {error:'Unauthorised'} unless `Authorization: Bearer <CRON_SECRET>`;
                                     // fails closed when CRON_SECRET is unset
jobsWriteEnabled(): boolean          // true only when JOBS_WRITE_ENABLED is "true" (case-insensitive, trimmed)
type JobResult = { job: string; dryRun: boolean; processed: number; written: number; errors: string[]; details?: unknown }

// lib/utils.ts
import { cn } from '@/lib/utils'      // cn(...inputs: ClassValue[]): string

// components/ui/*: standard shadcn exports, e.g.
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, CardAction } from '@/components/ui/card'
```

### Job route pattern (scoring, council, hubspot, context-agent)
```ts
export async function GET(req: Request) {
  try { assertCronAuth(req) } catch (e) { if (e instanceof Response) return e; throw e }
  const result: JobResult = await runXJob({ write: jobsWriteEnabled(), ... })
  return Response.json(result)
}
```
Route handlers that read env or Supabase should `export const dynamic = 'force-dynamic'` so `next build` never runs them.

## Theme tokens (app/globals.css)
- `background` #ffffff, `foreground` #000000, `muted-foreground` #666666 (grey copy), `primary` #314DD0 (one
  primary action per screen; `ring` is the same), `border`/`input` #e4e4e7, `muted`/`secondary`/`accent` #f4f4f5.
- Extra: `destructive` #c62828, `success` #1b7f3b, `warning` #b26a00 (usable as `text-success`, `bg-warning/10` etc).
- Font: `font-sans` = "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif (applied on body). No web font loaded.
- No dark theme defined (brand is white). `dark:` classes in shadcn files are inert.

## Installed versions
Runtime: next 16.4.6, react 19.3.1, react-dom 19.3.1, @supabase/supabase-js 2.119.0, @supabase/ssr 0.12.7,
server-only 0.0.1, zod 4.6.7, ai 7.0.173, @openrouter/ai-sdk-provider 3.1.0, clsx 2.1.1, tailwind-merge 3.7.0,
class-variance-authority 0.7.1, lucide-react 1.73.0, radix-ui 1.8.1, tw-animate-css 1.4.0.
Dev: typescript 5.9.3, @types/node 24.19.2, @types/react 19.3.0, @types/react-dom 19.3.0, eslint 9.39.5,
eslint-config-next 16.4.6, tailwindcss 4.3.5, @tailwindcss/postcss 4.3.5, vitest 5.1.0.

## Decisions
- TypeScript 5.9.3, not 7.x: typescript-eslint (used by eslint-config-next) supports `<6.1.0` only.
- ESLint 9, not 10: eslint-config-next plugins are proven on 9.
- zod is v4 (`import { z } from 'zod'`; use `z.url()`, `{ error: '...' }`). The AI SDK v7 accepts zod 4 schemas.
- No `@vitejs/plugin-react` and no jsdom: tests are node-only pure functions. Ask if you need component tests.
- `serverEnv()` requires the three Supabase vars; everything else optional. Model names are not defaulted in code;
  `.env.example` suggests OPENROUTER_MODEL_A=anthropic/claude-sonnet-5, OPENROUTER_MODEL_B=openai/gpt-5.6-luna.
  Embeddings must be 1536 dims (`vector(1536)`).
- `createServerSupabase` cannot be used in `middleware.ts` (no next/headers there). auth agent: build the middleware
  client with `createServerClient` from `@supabase/ssr` over `request.cookies` / `response.cookies`, using `publicEnv()`.
- shadcn CLI 4.23 rewrote the utils import to `"cn"` and added an npm package `cn`; I fixed imports to `@/lib/utils`
  and removed the package. If you run `npx shadcn add` yourself, check for this. Prefer asking foundation.

## Requests
- integrator: update CLAUDE.md "Commands" section (no longer "not scaffolded"): `npm run lint | typecheck | test | build`, `npm run dev`.
- integrator: `vercel.json` crons must send the CRON_SECRET (Vercel Cron does this automatically when `CRON_SECRET` is set in the project).
- integrator: env vars to set in Vercel are exactly the names in `.env.example`. No extra env vars added by foundation.
- anyone: need another shadcn component or package? Write it under Requests in your notes for foundation / integrator.

## Known gaps
- `npm audit`: 7 moderate (dev only) via minimatch inside @typescript-eslint, pulled by eslint-config-next. `npm audit fix`
  could not resolve it without a forced major change. Not shipped to production.
- Two extraneous optional packages (@emnapi/runtime, @img/sharp-wasm32) in node_modules; harmless, `npm prune` clears them.
- No CI workflow and no Vercel project created (no live systems touched). No git commit made.
- `app/(app)` and `app/(auth)` do not exist yet (owned by auth and UI agents). `/` redirects to `/home`, which 404s until
  accountant-ui adds `app/(app)/home`.
