import type { Limit } from '../types'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const WINDOW_MS: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 7 * DAY }
const ORDER = ['five_hour', 'seven_day']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function limitLabel(kind: string): string {
  if (kind === 'five_hour') return '5-hour'
  if (kind === 'seven_day') return 'Weekly'
  if (kind === 'spend_limit') return 'Spend'
  return kind.replace(/_/g, ' ')
}

/** The plan windows in a fixed order: 5-hour first, then weekly, then anything else. */
export function sortLimits(limits: readonly Limit[]): Limit[] {
  const rank = (kind: string): number => (ORDER.includes(kind) ? ORDER.indexOf(kind) : ORDER.length)
  return [...limits].sort((a, b) => rank(a.kind) - rank(b.kind) || a.kind.localeCompare(b.kind))
}

export function usageColor(percent: number): string {
  if (percent >= 90) return 'red'
  if (percent >= 70) return 'yellow'
  return 'green'
}

/** A bar of `width` cells: filled blocks for the used share, light shade for the rest. */
export function meter(percent: number, width = 12): { used: string; left: string } {
  const filled = Math.max(0, Math.min(width, Math.round((Math.min(100, percent) / 100) * width)))
  return { used: '█'.repeat(filled), left: '░'.repeat(width - filled) }
}

/** "1h 12m", "3d 4h", "8m"; "now" once the time has passed. */
export function duration(ms: number): string {
  if (ms <= 0) return 'now'
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`
}

/** The reset as a wall-clock time: "15:40" today, "Mon 09:00" on another day. */
export function clockTime(resetMs: number, nowMs: number): string {
  const reset = new Date(resetMs)
  const time = `${String(reset.getHours()).padStart(2, '0')}:${String(reset.getMinutes()).padStart(2, '0')}`
  return new Date(nowMs).toDateString() === reset.toDateString() ? time : `${WEEKDAYS[reset.getDay()] ?? ''} ${time}`
}

export type LimitView = {
  label: string
  percent: number
  color: string
  resetIn?: string
  resetAt?: string
  /** Set when the window will run out before it resets at the current pace: how long until it does. */
  runsOutIn?: string
}

/** Everything the band shows for one limit, worked out at time `now`. */
export function viewOf(limit: Limit, now: number): LimitView {
  const view: LimitView = { label: limitLabel(limit.kind), percent: limit.percentUsed, color: usageColor(limit.percentUsed) }
  const reset = limit.resetsAt === undefined ? Number.NaN : Date.parse(limit.resetsAt)
  if (Number.isNaN(reset)) return view

  view.resetIn = duration(reset - now)
  view.resetAt = clockTime(reset, now)

  const windowMs = WINDOW_MS[limit.kind]
  if (windowMs === undefined || limit.percentUsed <= 0 || limit.percentUsed >= 100) return view
  const elapsed = now - (reset - windowMs)
  if (elapsed < 5 * 60_000) return view
  const rate = limit.percentUsed / elapsed
  const untilFull = (100 - limit.percentUsed) / rate
  if (untilFull < reset - now) view.runsOutIn = duration(untilFull)
  return view
}

export function limitText(view: LimitView): string {
  const reset = view.resetIn === undefined ? '' : `, resets in ${view.resetIn} (${view.resetAt})`
  const pace = view.runsOutIn === undefined ? '' : `. At this pace it runs out in ${view.runsOutIn}`
  return `${view.label} limit: ${view.percent}% used${reset}${pace}`
}
