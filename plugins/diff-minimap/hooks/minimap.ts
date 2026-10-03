export type Hunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: readonly string[]
}

/** The parts of an Edit or Write result the minimap reads. */
export type EditOutput = {
  structuredPatch?: readonly Hunk[]
  originalFile?: string | null
  content?: string
  type?: 'create' | 'update'
}

export type Mark = 'added' | 'removed' | 'changed' | 'none'

export type Minimap = { marks: Mark[]; totalLines: number; firstLine: number; lastLine: number }

export const ROWS = 8

function lineCount(text: string): number {
  if (text === '') return 0
  const lines = text.split('\n')
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
}

function hunksOf(output: EditOutput): readonly Hunk[] {
  const patch = output.structuredPatch ?? []
  if (patch.length > 0 || output.type !== 'create' || output.content === undefined) return patch
  const total = lineCount(output.content)
  return [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: total, lines: Array.from({ length: total }, () => '+') }]
}

/** Buckets the file into up to ROWS slices and marks each slice the edit touched; null when there is nothing to show. */
export function minimapOf(output: EditOutput, rows = ROWS): Minimap | null {
  const hunks = hunksOf(output)
  if (hunks.length === 0) return null

  const added = hunks.reduce((sum, hunk) => sum + hunk.lines.filter(line => line.startsWith('+')).length, 0)
  const removed = hunks.reduce((sum, hunk) => sum + hunk.lines.filter(line => line.startsWith('-')).length, 0)
  const fromHunks = Math.max(...hunks.map(hunk => hunk.newStart + Math.max(hunk.newLines, 1) - 1))
  const original = typeof output.originalFile === 'string' ? lineCount(output.originalFile) : 0
  const totalLines = Math.max(1, fromHunks, original + added - removed)

  const slices = Math.min(rows, totalLines)
  const marks: Mark[] = Array.from({ length: slices }, () => 'none')
  const mark = (line: number, kind: 'added' | 'removed'): void => {
    const row = Math.min(slices - 1, Math.max(0, Math.floor(((line - 1) / totalLines) * slices)))
    const current = marks[row]
    marks[row] = current === 'none' || current === kind ? kind : 'changed'
  }

  let firstLine = Number.POSITIVE_INFINITY
  let lastLine = 0
  for (const hunk of hunks) {
    let line = Math.max(1, hunk.newStart)
    for (const text of hunk.lines) {
      if (text.startsWith('+')) {
        mark(line, 'added')
        firstLine = Math.min(firstLine, line)
        lastLine = Math.max(lastLine, line)
        line += 1
      } else if (text.startsWith('-')) {
        mark(line, 'removed')
        firstLine = Math.min(firstLine, line)
        lastLine = Math.max(lastLine, line)
      } else {
        line += 1
      }
    }
  }
  if (lastLine === 0) return null

  return { marks, totalLines, firstLine, lastLine }
}

export const GLYPH: Record<Mark, { text: string; color?: string }> = {
  added: { text: '█', color: 'green' },
  removed: { text: '█', color: 'red' },
  changed: { text: '█', color: 'yellow' },
  none: { text: '│' },
}
