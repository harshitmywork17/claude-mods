import type { EditHunk } from '../types'

export type Cell = { line: number; text: string; kind: ' ' | '-' | '+' }

/** One row of a side-by-side diff: the old line on the left, the new on the right, or a gap between hunks. */
export type Row = { left?: Cell; right?: Cell; isGap?: true }

/** Lays unified hunks out as two columns, pairing each removed run with the added run that replaced it. */
export function sideBySide(hunks: readonly EditHunk[]): Row[] {
  const rows: Row[] = []
  hunks.forEach((hunk, index) => {
    if (index > 0) rows.push({ isGap: true })
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    let removed: Cell[] = []
    let added: Cell[] = []
    const flush = (): void => {
      for (let i = 0; i < Math.max(removed.length, added.length); i += 1) rows.push({ left: removed[i], right: added[i] })
      removed = []
      added = []
    }
    for (const raw of hunk.lines) {
      const mark = raw.charAt(0)
      const text = raw.slice(1)
      if (mark === '-') {
        removed.push({ line: oldLine, text, kind: '-' })
        oldLine += 1
      } else if (mark === '+') {
        added.push({ line: newLine, text, kind: '+' })
        newLine += 1
      } else {
        flush()
        rows.push({ left: { line: oldLine, text, kind: ' ' }, right: { line: newLine, text, kind: ' ' } })
        oldLine += 1
        newLine += 1
      }
    }
    flush()
  })
  return rows
}

/** A line cut or padded to exactly `width` characters, tabs shown as two spaces. */
export function fit(text: string, width: number): string {
  const flat = text.replace(/\t/g, '  ')
  return flat.length > width ? `${flat.slice(0, Math.max(0, width - 1))}…` : flat.padEnd(width, ' ')
}
