// Shared column layout for the clients table header and rows (plain module so both server and client code can use it).
// Columns: Client, [Senior], Groups, Open, Health, Last message.
export const GRID_WITH_SENIOR =
  'xl:grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)_5.5rem_5.5rem_minmax(0,1.3fr)_minmax(0,1.1fr)]'
export const GRID_NO_SENIOR = 'xl:grid-cols-[minmax(0,2.6fr)_5.5rem_5.5rem_minmax(0,1.4fr)_minmax(0,1.2fr)]'

export const AVATAR_CLASSES = [
  'bg-primary-soft text-accent-foreground',
  'bg-violet-soft text-violet',
  'bg-teal-soft text-teal',
  'bg-success-soft text-success',
  'bg-warning-soft text-warning',
] as const

export const TONE_CHIP = {
  good: 'bg-success-soft text-success',
  watch: 'bg-warning-soft text-warning',
  risk: 'bg-destructive-soft text-destructive',
  none: 'bg-secondary text-muted-foreground',
} as const

export const TONE_BAR = {
  good: 'bg-success',
  watch: 'bg-warning',
  risk: 'bg-destructive',
  none: 'bg-border',
} as const
