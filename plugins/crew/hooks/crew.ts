import type { AgentStatus, PlanTask } from '../types'

export const C = {
  ok: '#34D399',
  bad: '#F87171',
  warn: '#FBBF24',
  live: '#22D3EE',
  accent: '#A78BFA',
  blue: '#60A5FA',
  line: '#475569',
  soft: '#94A3B8',
  text: '#E2E8F0',
  card: '#1E293B',
  track: '#334155',
} as const

// ── Effort tiers ────────────────────────────────────────────────────────

export type Tier = { label: string; color: string; hat: string; band?: string }

const TIERS: Record<string, Tier> = {
  heavy: { label: 'heavy', color: '#F87171', hat: '#A0522D', band: '#60A5FA' },
  careful: { label: 'careful', color: '#F59E0B', hat: '#F2C94C' },
  medium: { label: 'medium', color: '#60A5FA', hat: '#9CA3AF', band: '#3B82F6' },
  light: { label: 'light', color: '#34D399', hat: '#22A06B' },
  unknown: { label: 'agent', color: '#94A3B8', hat: '#64748B' },
}

/** How hard an agent thinks, as a crew rank: max and xhigh are heavy, high careful, medium, low light. */
export function tierOf(effort: string | undefined): Tier {
  if (effort === undefined) return TIERS.unknown as Tier
  const budget = Number(effort)
  if (!Number.isNaN(budget)) return (budget >= 32_000 ? TIERS.heavy : budget >= 12_000 ? TIERS.careful : budget >= 4_000 ? TIERS.medium : TIERS.light) as Tier
  if (effort === 'max' || effort === 'xhigh') return TIERS.heavy as Tier
  if (effort === 'high') return TIERS.careful as Tier
  if (effort === 'medium') return TIERS.medium as Tier
  if (effort === 'low') return TIERS.light as Tier
  return TIERS.unknown as Tier
}

/** "claude-opus-5-5" reads "Opus 5.5", "claude-haiku-4-5-20251001" "Haiku 4.5", an alias "opus" "Opus". */
export function modelLabel(model: string | undefined): string {
  if (model === undefined || model === '') return 'model ?'
  const id = model.replace(/\[.*\]$/, '')
  const match = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id)
  const cap = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1)
  if (match !== null) return `${cap(match[1] ?? '')} ${match[2]}${match[3] === undefined ? '' : `.${match[3]}`}`
  return /^[a-z]+$/.test(id) ? cap(id) : id
}

// ── Numbers ─────────────────────────────────────────────────────────────

export function tokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1000) return `${Math.round(count / 1000)}k`
  return String(Math.round(count))
}

export function money(usd: number): string {
  return usd >= 10 ? `≈$${usd.toFixed(1)}` : `≈$${usd.toFixed(2)}`
}

/** A stopwatch: 3:21, 17:45, 1:02:09. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

export function head(text: string, width: number): string {
  if (width <= 1) return text.slice(0, Math.max(0, width))
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`
}

export function firstLine(text: string, width = 160): string {
  return head(text.replace(/\s+/g, ' ').trim(), width)
}

/** The engine's task statuses folded into the pane's four. */
export function statusOf(engine: string, reason?: string): AgentStatus {
  if (reason === 'aborted' || engine === 'killed' || engine === 'stopped') return 'stopped'
  if (reason === 'error' || reason === 'refusal' || engine === 'failed') return 'failed'
  if (reason !== undefined || engine === 'completed') return 'completed'
  return 'running'
}

// ── Plan ────────────────────────────────────────────────────────────────

export type TaskEvent =
  | { kind: 'create'; id: string; subject: string }
  | { kind: 'update'; id: string; subject?: string; status?: string; addBlockedBy?: readonly string[]; owner?: string }
  | { kind: 'todos'; todos: readonly { content: string; status: string }[] }

/** Folds one TaskCreate, TaskUpdate or TodoWrite into the plan. */
export function applyTask(tasks: readonly PlanTask[], event: TaskEvent): PlanTask[] {
  if (event.kind === 'todos') {
    // A todo list replaces itself whole; it lives beside task-list tasks under ids of its own.
    const kept = tasks.filter(task => !task.id.startsWith('todo-'))
    const todos = event.todos.map((todo, index): PlanTask => ({
      id: `todo-${index + 1}`,
      subject: todo.content,
      status: todo.status === 'completed' ? 'completed' : todo.status === 'in_progress' ? 'in_progress' : 'pending',
      blockedBy: [],
    }))
    return [...kept, ...todos]
  }
  if (event.kind === 'create') {
    if (tasks.some(task => task.id === event.id)) return [...tasks]
    return [...tasks, { id: event.id, subject: event.subject, status: 'pending', blockedBy: [] }]
  }
  if (event.status === 'deleted') return tasks.filter(task => task.id !== event.id)
  return tasks.map(task =>
    task.id !== event.id
      ? task
      : {
          ...task,
          subject: event.subject ?? task.subject,
          status: event.status === 'pending' || event.status === 'in_progress' || event.status === 'completed' ? event.status : task.status,
          blockedBy: [...new Set([...task.blockedBy, ...(event.addBlockedBy ?? [])])],
          owner: event.owner ?? task.owner,
        },
  )
}

/** The tasks a task still waits for: its blockers not yet completed. */
export function waitingOn(task: PlanTask, tasks: readonly PlanTask[]): string[] {
  return task.blockedBy.filter(id => tasks.find(other => other.id === id)?.status !== 'completed')
}

// ── The crew member ─────────────────────────────────────────────────────

/**
 * The sprite, 8 pixels wide and 6 tall, two pixel rows to a terminal row:
 * H hat, b hat band, B body, E eye, L leg, F the flag of a light agent, A a heavy agent's antenna.
 */
const BODY = ['..HHHH.A', '.HbbbbH.', '.BBBBBB.', 'BBEBBEBB', '.BBBBBB.']
const LEGS = ['.L.LL.L.', 'L.L..L.L']
const FLAGGED = ['..HHHH.F', '.HHHHHH.', '.BBBBBB.', 'BBEBBEBB', '.BBBBBB.']

export type Cell = { char: string; fg?: string; bg?: string }

const BODY_COLOR: Record<AgentStatus | 'planned', string> = {
  running: '#E8795A',
  completed: '#E8795A',
  failed: '#B45F4D',
  stopped: '#8C6A5F',
  planned: '#7A4535',
}

/** The sprite as rows of half-block cells, each run of one colour pair merged; `frame` swaps the legs while it walks. */
export function sprite(tier: Tier, status: AgentStatus | 'planned', frame: number): Cell[][] {
  const body = BODY_COLOR[status]
  const isDim = status === 'planned'
  const shade = (hex: string): string => (isDim ? dim(hex) : hex)
  const pixels = [...(tier.label === 'light' ? FLAGGED : BODY), LEGS[status === 'running' ? frame % 2 : 0] ?? '']
  const colorOf = (char: string): string | undefined => {
    if (char === 'H') return shade(tier.hat)
    if (char === 'b') return shade(tier.band ?? tier.hat)
    if (char === 'B' || char === 'L') return body
    if (char === 'E') return '#1E1B2E'
    if (char === 'A') return tier.label === 'heavy' ? shade('#60A5FA') : undefined
    if (char === 'F') return shade('#E5E7EB')
    return undefined
  }
  const rows: Cell[][] = []
  for (let row = 0; row < pixels.length; row += 2) {
    const top = pixels[row] ?? ''
    const bottom = pixels[row + 1] ?? ''
    const cells: Cell[] = []
    for (let col = 0; col < 8; col += 1) {
      const up = colorOf(top.charAt(col))
      const down = colorOf(bottom.charAt(col))
      const cell: Cell = up === undefined && down === undefined ? { char: ' ' } : up === undefined ? { char: '▄', fg: down } : { char: '▀', fg: up, bg: down }
      const last = cells[cells.length - 1]
      if (last !== undefined && last.fg === cell.fg && last.bg === cell.bg) last.char += cell.char
      else cells.push(cell)
    }
    rows.push(cells)
  }
  return rows
}

function dim(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16)
  const channel = (shift: number): number => Math.round(((value >> shift) & 255) * 0.55)
  return `#${[16, 8, 0].map(shift => channel(shift).toString(16).padStart(2, '0')).join('')}`
}
