import type { Reading } from '../types'

export const HISTORY_LENGTH = 12

const BARS = '▁▂▃▄▅▆▇█'

export type Sky = { icon: string; label: string; color: string; advice?: string }

export function sky(percent: number): Sky {
  if (percent < 50) return { icon: '☀', label: 'Clear', color: 'green' }
  if (percent < 75) return { icon: '⛅', label: 'Cloudy', color: 'yellow' }
  if (percent < 90) {
    return { icon: '☂', label: 'Rain', color: 'yellow', advice: 'consider /compact soon' }
  }
  return { icon: '⚡', label: 'Storm', color: 'red', advice: 'run /compact now' }
}

export function sparkline(values: readonly number[]): string {
  return values
    .map(value => {
      const level = Math.floor((Math.min(100, Math.max(0, value)) / 100) * BARS.length)
      return BARS.charAt(Math.min(BARS.length - 1, level))
    })
    .join('')
}

/** Average growth per turn over the last few turns, ignoring drops (compaction). */
export function growthPerTurn(history: readonly number[]): number | undefined {
  const recent = history.slice(-6)
  const deltas: number[] = []
  for (let i = 1; i < recent.length; i += 1) {
    const delta = (recent[i] ?? 0) - (recent[i - 1] ?? 0)
    if (delta >= 0) deltas.push(delta)
  }
  if (deltas.length === 0) return undefined
  return deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length
}

export function turnsLeft(percent: number, perTurn: number | undefined): number | undefined {
  if (perTurn === undefined || perTurn < 0.1) return undefined
  return Math.max(0, Math.floor((100 - percent) / perTurn))
}

export function kilo(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)
}

export function outlook(history: readonly number[], reading: Reading): string {
  const perTurn = growthPerTurn(history)
  const left = turnsLeft(reading.percent, perTurn)
  if (perTurn === undefined) return 'steady'
  const rate = `+${perTurn.toFixed(1)}%/turn`
  return left === undefined ? rate : `${rate} · ~${left} turns to full`
}

export function forecastText(history: readonly number[], reading: Reading | null): string {
  if (reading === null) return 'Token Weather: no reading yet. It appears after the first reply.'
  const now = sky(reading.percent)
  const lines = [
    `${now.icon} ${now.label}: context ${reading.percent}% full (${kilo(reading.tokens)}/${kilo(reading.window)} tokens)`,
    `Last ${history.length} turns: ${sparkline(history) || '-'}  ${outlook(history, reading)}`,
  ]
  if (now.advice !== undefined) lines.push(`Advice: ${now.advice}`)
  return lines.join('\n')
}
