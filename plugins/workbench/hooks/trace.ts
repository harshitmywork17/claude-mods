import type { Lane, Step, StepStatus, Turn } from '../types'

export const MAX_TURNS = 5
const MAX_STEPS = 200
const MAX_OUTPUT = 240

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

function firstString(input: Record<string, unknown>): string {
  const found = Object.values(input).find(value => typeof value === 'string')
  return typeof found === 'string' ? found : ''
}

/** One short line saying what a tool call is about. */
export function summarize(tool: string, input: Record<string, unknown>): string {
  const get = (key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '')
  switch (tool) {
    case 'Bash':
      return get('command')
    case 'Read':
    case 'Edit':
    case 'Write':
      return basename(get('file_path'))
    case 'NotebookEdit':
      return basename(get('notebook_path'))
    case 'Grep':
    case 'Glob':
      return get('pattern')
    case 'WebFetch':
      return get('url')
    case 'WebSearch':
      return get('query')
    case 'Agent':
      return [get('subagent_type'), get('description')].filter(Boolean).join(': ')
    case 'Skill':
      return get('skill')
    default:
      return firstString(input)
  }
}

export function preview(text: string | undefined): string {
  const lines = (text ?? '').trim().split('\n').slice(0, 3).join('\n')
  return lines.length > MAX_OUTPUT ? `${lines.slice(0, MAX_OUTPUT)}…` : lines
}

export function statusOf(ran: { deny?: string; isError?: true }): StepStatus {
  if (ran.deny !== undefined) return 'denied'
  return ran.isError === true ? 'error' : 'ok'
}

/** Applies a change to the newest turn, creating one when a tool runs before any turn started. */
export function onNewest(turns: readonly Turn[], now: number, change: (turn: Turn) => Turn): Turn[] {
  const newest = turns[turns.length - 1] ?? {
    id: 'earlier',
    prompt: '(before this view opened)',
    startedAt: now,
    status: 'running',
    steps: [],
    lanes: [{ id: 'main', label: 'Main' }],
  }
  return [...turns.slice(0, -1), change(newest)]
}

export function withStep(turn: Turn, step: Step, laneLabel: string): Turn {
  const hasLane = turn.lanes.some(lane => lane.id === step.lane)
  const lanes: Lane[] = hasLane ? turn.lanes : [...turn.lanes, { id: step.lane, label: laneLabel }]
  return { ...turn, lanes, steps: [...turn.steps, step].slice(-MAX_STEPS) }
}

export function withStepChange(turns: readonly Turn[], id: string, change: Partial<Step>): Turn[] {
  return turns.map(turn =>
    turn.steps.some(step => step.id === id)
      ? { ...turn, steps: turn.steps.map(step => (step.id === id ? { ...step, ...change } : step)) }
      : turn,
  )
}

export function relabel(turns: readonly Turn[], laneId: string, label: string): Turn[] {
  return turns.map(turn => ({
    ...turn,
    lanes: turn.lanes.some(lane => lane.id === laneId)
      ? turn.lanes.map(lane => (lane.id === laneId ? { ...lane, label } : lane))
      : turn.lanes,
  }))
}

export function seconds(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`
}

/** Time the main lane spent outside tool calls: the model reading, deciding and writing. */
export function modelTime(turn: Turn, now: number): number {
  const end = turn.endedAt ?? now
  const spans = turn.steps
    .filter(step => step.lane === 'main')
    .map(step => [step.startedAt, step.endedAt ?? now] as const)
    .sort((a, b) => a[0] - b[0])
  let busy = 0
  let reach = turn.startedAt
  for (const [start, stop] of spans) {
    const from = Math.max(start, reach)
    if (stop > from) busy += stop - from
    reach = Math.max(reach, stop)
  }
  return Math.max(0, end - turn.startedAt - busy)
}

/** A waterfall bar: leading spaces then blocks, placed on the turn's time span. */
export function bar(step: Step, turn: Turn, now: number, width: number): { pad: string; fill: string } {
  const span = Math.max(1, (turn.endedAt ?? now) - turn.startedAt)
  const start = Math.min(width - 1, Math.floor(((step.startedAt - turn.startedAt) / span) * width))
  const length = Math.max(1, Math.round((((step.endedAt ?? now) - step.startedAt) / span) * width))
  return { pad: ' '.repeat(Math.max(0, start)), fill: '█'.repeat(Math.min(length, width - start)) }
}

export function colorOf(step: Step, now: number): string {
  if (step.status === 'running') return 'cyan'
  if (step.status === 'error') return 'red'
  if (step.status === 'denied') return 'magenta'
  const took = (step.endedAt ?? now) - step.startedAt
  return took >= 30_000 ? 'red' : took >= 10_000 ? 'yellow' : 'green'
}

export const BADGE: Record<StepStatus, string> = { running: '●', ok: '✓', error: '✗', denied: '⊘' }

/** What a turn's prompt reads as: a background task's notice becomes its one-line summary instead of raw tags. */
export function promptLabel(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat === '') return '(continued without a prompt)'
  if (flat.startsWith('<task-notification>')) {
    const summary = /<summary>(.*?)<\/summary>/.exec(flat)?.[1]?.trim()
    return `↻ ${summary === undefined || summary === '' ? 'a background task finished' : summary}`
  }
  return flat.slice(0, 160)
}
