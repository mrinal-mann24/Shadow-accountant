// Cookie names owned by auth. Read by proxy.ts, lib/auth/session.ts, lib/auth/view-as.ts and the sign-out route.

/** Engineer "view as": the va_id being viewed. httpOnly. */
export const VIEW_AS_COOKIE = 'view_as_va'

/** DEV LOGIN only: "engineer" | "admin" | "va:<va_id>" (or legacy "1"); see parseDevLoginChoice. Ignored in production. httpOnly. */
export const DEV_LOGIN_COOKIE = 'dev_login'

export const AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: 60 * 60 * 8, // one working day
}
