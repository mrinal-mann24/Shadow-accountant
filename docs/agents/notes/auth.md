# auth notes

Status: DONE. `npm run typecheck` clean, `npm run lint` clean, `npm run test` 19 files / 200 tests pass
(auth: 4 files, 40 tests). `next build` not run by auth (shared `.next`, other agents still building).

## Built
- Microsoft SSO via Supabase Auth (provider `azure`, scopes `openid email profile`, PKCE, server action):
  `app/(auth)/login/page.tsx` (one "Sign in with Microsoft" button, error messages, keeps `?next=`),
  `app/(auth)/login/actions.ts`, `app/auth/callback/route.ts` (code exchange, safe `next`),
  `app/auth/sign-out/route.ts` (POST only; also clears view-as and dev login cookies).
- `app/(auth)/no-access/page.tsx`: "Your account is not set up yet, ask an Admin" for signed-in users with no role
  and no `vas` email match.
- `proxy.ts (was middleware.ts)`: @supabase/ssr session refresh, redirects signed-out users to `/login?next=...`; `/api/*` gets 401 JSON
  instead. Public: `/login`, `/auth/*`, `/api/jobs/*`, `/api/webhooks/*` (jobs and webhooks skip Supabase entirely).
- `lib/auth/types.ts`, `lib/auth/roles.ts` (pure rules), `lib/auth/cookies.ts`, `lib/auth/session.ts`,
  `lib/auth/view-as.ts` (server actions), `lib/auth/users.ts` (admin user management).
- `app/(app)/layout.tsx` + `components/shell/*`: left nav per role, top bar (name, role, view-as selector, sign out),
  view-as banner with "Stop viewing as". Mobile: nav becomes a horizontal row under the top bar.
- `supabase/proposals/rls-authenticated.sql` (NOT applied): SELECT policies for `authenticated` per role, ticket update by
  owner, client update by admin, rollback and per-role proof queries.
- Tests: `lib/auth/roles.test.ts`, `lib/auth/session.test.ts` (mocked Supabase / cookies), `lib/auth/users.test.ts`,
  `components/shell/nav.test.ts`.

## Exports (exact import paths + signatures)
```ts
// lib/auth/types.ts (client-safe)
import { type Role, type AppUser, ROLES, ROLE_LABELS, isRole } from '@/lib/auth/types'
type Role = 'senior_accountant' | 'admin' | 'engineer'
type AppUser = { id: string; email: string; name: string; role: Role; vaId: string | null; viewingAs?: { vaId: string; name: string } }

// lib/auth/roles.ts (pure, client-safe; data layer already uses these)
import { canSeeAllClients, assertNotViewingAs, ForbiddenError, ViewAsReadOnlyError,
  resolveAppUser, applyViewAs, findVaByEmail, safeNextPath, isPublicPath, devLoginEmail } from '@/lib/auth/roles'
canSeeAllClients(u: AppUser): boolean     // admin / engineer, false while viewing as
assertNotViewingAs(u: AppUser): void      // throws ViewAsReadOnlyError (extends ForbiddenError)

// lib/auth/session.ts (server-only). Also re-exports canSeeAllClients, assertNotViewingAs, ForbiddenError, ViewAsReadOnlyError.
import { getCurrentUser, requireUser, getAuthState, loadVas } from '@/lib/auth/session'
getCurrentUser(): Promise<AppUser | null>          // effective user (view-as scoped); null if signed out OR not set up
requireUser(roles?: Role[]): Promise<AppUser>      // signed out -> /login, not set up -> /no-access, wrong role -> /home
getAuthState(): Promise<{ status: 'anonymous' } | { status: 'no_access'; email: string }
                       | { status: 'ok'; user: AppUser; signedInUser: AppUser }>   // signedInUser ignores view-as
loadVas(): Promise<{ va_id: string; va_name: string; email: string | null }[]>     // per-request cached

// lib/auth/view-as.ts ('use server', engineer only, cookie `view_as_va`, httpOnly, 8 h)
import { setViewAs, clearViewAs, listViewAsOptions } from '@/lib/auth/view-as'
setViewAs(vaId: string): Promise<void>   // validates vaId, redirects to /home
clearViewAs(): Promise<void>             // redirects to /home
listViewAsOptions(): Promise<{ vaId: string; name: string }[]>

// lib/auth/users.ts (server-only, admin only, not while viewing as)
import { listAppUsers, setUserRole, type AppUserListItem } from '@/lib/auth/users'
listAppUsers(admin: AppUser): Promise<AppUserListItem[]>
//   { id, email, name, role: Role | null /* explicit */, effectiveRole: Role | null, vaId, vaName, createdAt, lastSignInAt }
setUserRole(admin: AppUser, userId: string, role: Role | null): Promise<void>  // null clears; cannot change own role
```

## Decisions
- Role resolution: valid `app_metadata.role` wins; else a `vas.email` match (case-insensitive, trimmed) means
  `senior_accountant`; else no access (`/no-access`). Invalid role strings count as no role. An explicit
  `senior_accountant` with no vas row is allowed in but has `vaId: null` (sees no clients). Admin / engineer also get
  `vaId` if their email is in `vas`.
- Role is read with `auth.getUser()` (auth server) per request, so an Admin's role change applies on the next request.
- View as: an engineer with the cookie becomes `{ role: 'senior_accountant', vaId: target, viewingAs }`. So
  `requireUser(['engineer'])` sends them to /home while viewing as, and the nav shows the accountant set. Unknown va id
  in the cookie is ignored. Cookie is ignored for admins and accountants.
- Nav: accountant Home `/home`, Clients `/clients`, Tickets `/tickets`, Ask AI `/ask`; admin adds Team `/admin`,
  Users and assignment `/admin/users`; engineer adds Team `/admin` and System `/engineer` (no Users: user
  management is admin only).
- DEV LOGIN (clearly marked in code): only when `NODE_ENV !== 'production'` AND `DEV_LOGIN_EMAIL` is set. The login page
  then shows a "Dev login as ..." button that sets an httpOnly `dev_login=1` cookie; middleware and session honour it
  only under the same condition. Identity id is `dev-login:<email>` (not a uuid; do not write it to uuid columns).
  Role from optional `DEV_LOGIN_ROLE`, else the vas email rule.
- Kept `proxy.ts (was middleware.ts)` (contract name). Next 16 marks it deprecated in favour of `proxy.ts`; it still works.
- `(app)/layout.tsx` gates every page (anonymous to /login, not set up to /no-access). Pages still call
  `requireUser(roles)` for role checks.
- RLS proposal uses inline JWT checks, no new SQL functions.

## Requests
- admin-engineer-ui: please create `/admin` (Team), `/admin/users` (Users and assignment), `/engineer` (System). For the
  users page call `listAppUsers(user)` / `setUserRole(user, id, role)` from your own server actions after
  `requireUser(['admin'])`. The view-as selector already lives in the top bar; no need to build one.
- accountant-ui / context-agent: nav points at `/home`, `/clients`, `/tickets`, `/ask`. Every mutation server action:
  `const user = await requireUser(); assertNotViewingAs(user)` (data layer `assertCanMutate` already does this).
- integrator / foundation: add to `.env.example` (dev only, optional):
  `DEV_LOGIN_ROLE=` with comment "Dev login only: senior_accountant | admin | engineer". Read via `process.env` in
  `lib/auth/session.ts`. No other new env vars.
- integrator: Supabase Auth setup (dashboard, not code): enable Azure provider (tenant URL, client id / secret), add
  `<site>/auth/callback` to redirect URLs for prod, preview and `http://localhost:3000`.
- integrator: CLAUDE.md "Commands" can now say auth routes are `/login`, `/auth/callback`, `/auth/sign-out` (optional).
- Stage 1 owner: the existing `using (true)` policies on `clients`, `client_messages` etc. must be scoped to `anon`
  (or dropped) before `rls-authenticated.sql` means anything; if they are `to public`, `authenticated` already sees all.

## Known gaps
- Not tested against a live Supabase / Azure tenant (no live calls allowed). The OAuth flow, cookie refresh and
  sign-out are the standard @supabase/ssr pattern but unverified end to end.
- `next build` not run by auth.
- `listAppUsers` lists only people who have signed in once (auth users). Inviting a user before first sign-in is not
  built; the vas email rule covers accountants.
- RLS proposal does not know about view as (app-level); data reads stay service role and scoped by `AppUser`.
