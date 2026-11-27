import 'server-only'

// Teams bot settings. Read at call time, never at import, so a missing value never breaks the build.

export type TeamsEnv = { appId: string; password: string; tenantId: string }

const DEFAULT_SITE_URL = 'https://shadow.aiaccountant.com'

function read(name: string): string | undefined {
  const v = process.env[name]?.trim()
  return v ? v : undefined
}

/** The bot's Entra app registration, or null when any of the three values is not set. */
export function teamsEnv(): TeamsEnv | null {
  const appId = read('TEAMS_BOT_APP_ID')
  const password = read('TEAMS_BOT_APP_PASSWORD')
  const tenantId = read('TEAMS_BOT_TENANT_ID')
  if (!appId || !password || !tenantId) return null
  return { appId, password, tenantId }
}

/** Public base URL of the app (for links in cards), without a trailing slash. */
export function siteUrl(): string {
  const v = read('NEXT_PUBLIC_SITE_URL')
  return (v ?? DEFAULT_SITE_URL).replace(/\/+$/, '')
}
