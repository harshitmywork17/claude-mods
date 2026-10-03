/**
 * One palette for every view: soft, saturated tones that read on dark terminals and in the desktop app.
 * ok/bad/warn carry meaning everywhere (added/passing, removed/failing, modified/warning).
 */
export const C = {
  ok: '#34D399',
  bad: '#F87171',
  warn: '#FBBF24',
  live: '#22D3EE',
  accent: '#A78BFA',
  blue: '#60A5FA',
  pink: '#F472B6',
  line: '#475569',
  soft: '#94A3B8',
  text: '#E2E8F0',
  /** Dark text on a filled pill. */
  ink: '#1E1B2E',
  /** The fill behind a quiet chip. */
  chip: '#334155',
} as const

const NAMED: Record<string, string> = {
  green: C.ok,
  red: C.bad,
  yellow: C.warn,
  cyan: C.live,
  magenta: C.accent,
  blue: C.blue,
  gray: C.line,
}

/** The palette's tone for a colour name the shared helpers use ('green', 'red', ...); other values pass through. */
export function hue(name: string | undefined): string | undefined {
  return name === undefined ? undefined : (NAMED[name] ?? name)
}

/** A compact gauge of `width` cells: ▰ for the used share, ▱ for the rest. */
export function pill(percent: number, width: number): { used: string; left: string } {
  const filled = Math.max(0, Math.min(width, Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)))
  return { used: '▰'.repeat(filled), left: '▱'.repeat(width - filled) }
}

/** A git-style change bar: green cells for added lines and red for removed, scaled so `most` fills `width`. */
export function diffstat(added: number, removed: number, most: number, width: number): { plus: string; minus: string } {
  const total = added + removed
  if (total === 0 || most <= 0) return { plus: '', minus: '' }
  const cells = Math.max(1, Math.round((Math.min(total, most) / most) * width))
  const plus = added === 0 ? 0 : removed === 0 ? cells : Math.max(1, Math.round((added / total) * cells))
  return { plus: '▮'.repeat(plus), minus: '▮'.repeat(Math.max(0, cells - plus)) }
}

/** Cuts text to `width` cells, keeping the end: a path keeps its file name. */
export function tail(text: string, width: number): string {
  if (width <= 1) return text.slice(-Math.max(0, width))
  return text.length <= width ? text : `…${text.slice(text.length - width + 1)}`
}

/** Cuts text to `width` cells, keeping the start. */
export function head(text: string, width: number): string {
  if (width <= 1) return text.slice(0, Math.max(0, width))
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`
}

/** One line of a prompt, without runs of white space. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** True when a drawn tree holds any visible text: whether another mod drew something in the band. */
export function hasContent(node: unknown): boolean {
  if (typeof node === 'string') return node.trim() !== ''
  if (typeof node === 'number') return true
  if (Array.isArray(node)) return node.some(hasContent)
  if (node !== null && typeof node === 'object') {
    const element = node as { children?: unknown; props?: { label?: unknown } }
    if (typeof element.props?.label === 'string' && element.props.label.trim() !== '') return true
    return hasContent(element.children)
  }
  return false
}
