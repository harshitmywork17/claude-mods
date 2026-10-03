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
