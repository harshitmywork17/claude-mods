import type { EditHunk } from '../types'

/** The most a Code element draws; a diff is cut at a hunk boundary below it, so it still parses. */
export const MAX_DIFF_CHARS = 9500

export type DiffText = { text: string; hunks: number; isCut: boolean }

/** A line cut or padded to exactly `width` characters, tabs shown as two spaces. */
export function fit(text: string, width: number): string {
  const flat = text.replace(/\t/g, '  ')
  return flat.length > width ? `${flat.slice(0, Math.max(0, width - 1))}…` : flat.padEnd(width, ' ')
}

/** Characters a Code element refuses: every control character but tab and newline. */
function clean(line: string): string {
  return line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
}

/** Joins hunk texts until the next would pass `maxChars`. */
function joinHunks(parts: readonly string[], maxChars: number): DiffText {
  let text = ''
  let count = 0
  for (const part of parts) {
    const next = text === '' ? part : `${text}\n${part}`
    if (next.length > maxChars) return { text, hunks: count, isCut: true }
    text = next
    count += 1
  }
  return { text, hunks: count, isCut: false }
}

/** One recorded edit's hunks as unified-diff text, for `Code` with `format: 'diff'`. */
export function hunksText(hunks: readonly EditHunk[], maxChars = MAX_DIFF_CHARS): DiffText {
  return joinHunks(
    hunks.map(hunk => [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines.map(clean)].join('\n')),
    maxChars,
  )
}

type Op = { kind: ' ' | '-' | '+'; text: string }

/** The LCS table above which a diff gives up line matching and marks the whole middle as replaced. */
const MAX_DIFF_CELLS = 4_000_000

/** Line operations turning `a` into `b`: a common head and tail, and a longest-common-subsequence middle. */
export function diffOps(a: readonly string[], b: readonly string[]): Op[] {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1
  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)
  const ops: Op[] = a.slice(0, head).map(text => ({ kind: ' ', text }))
  if ((midA.length + 1) * (midB.length + 1) > MAX_DIFF_CELLS) {
    ops.push(...midA.map(text => ({ kind: '-' as const, text })), ...midB.map(text => ({ kind: '+' as const, text })))
  } else {
    const width = midB.length + 1
    const table = new Uint32Array((midA.length + 1) * width)
    for (let i = midA.length - 1; i >= 0; i -= 1) {
      for (let j = midB.length - 1; j >= 0; j -= 1) {
        table[i * width + j] =
          midA[i] === midB[j] ? (table[(i + 1) * width + j + 1] ?? 0) + 1 : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0)
      }
    }
    let i = 0
    let j = 0
    while (i < midA.length || j < midB.length) {
      if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
        ops.push({ kind: ' ', text: midA[i] ?? '' })
        i += 1
        j += 1
      } else if (j >= midB.length || (i < midA.length && (table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0))) {
        ops.push({ kind: '-', text: midA[i] ?? '' })
        i += 1
      } else {
        ops.push({ kind: '+', text: midB[j] ?? '' })
        j += 1
      }
    }
  }
  ops.push(...a.slice(a.length - tail).map(text => ({ kind: ' ' as const, text })))
  return ops
}

function linesOf(text: string | null): string[] {
  return text === null || text === '' ? [] : text.replace(/\n$/, '').split('\n')
}

/** The whole change from `before` to `after` as unified-diff text with `context` lines around each hunk. */
export function unifiedDiff(before: string | null, after: string | null, context = 3, maxChars = MAX_DIFF_CHARS): DiffText {
  const ops = diffOps(linesOf(before), linesOf(after))
  const changed = ops.map((op, index) => (op.kind === ' ' ? -1 : index)).filter(index => index >= 0)
  if (changed.length === 0) return { text: '', hunks: 0, isCut: false }

  // Group changed lines whose context windows touch into one hunk each.
  const spans: [number, number][] = []
  for (const index of changed) {
    const last = spans[spans.length - 1]
    if (last !== undefined && index - context <= last[1] + context + 1) last[1] = index
    else spans.push([index, index])
  }

  // Line numbers in the old and new file before each op.
  const oldAt: number[] = []
  const newAt: number[] = []
  let oldLine = 1
  let newLine = 1
  for (const op of ops) {
    oldAt.push(oldLine)
    newAt.push(newLine)
    if (op.kind !== '+') oldLine += 1
    if (op.kind !== '-') newLine += 1
  }

  const parts = spans.map(([first, last]) => {
    const from = Math.max(0, first - context)
    const to = Math.min(ops.length - 1, last + context)
    const slice = ops.slice(from, to + 1)
    const oldCount = slice.filter(op => op.kind !== '+').length
    const newCount = slice.filter(op => op.kind !== '-').length
    const oldStart = oldCount === 0 ? Math.max(0, (oldAt[from] ?? 1) - 1) : (oldAt[from] ?? 1)
    const newStart = newCount === 0 ? Math.max(0, (newAt[from] ?? 1) - 1) : (newAt[from] ?? 1)
    return [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...slice.map(op => clean(`${op.kind}${op.text}`))].join('\n')
  })
  return joinHunks(parts, maxChars)
}

/** The lines an edit really changed in the new file, leaving out the context lines its hunks carry. */
export function changedRanges(hunks: readonly EditHunk[]): [number, number][] {
  const ranges: [number, number][] = []
  for (const hunk of hunks) {
    let line = Math.max(1, hunk.newStart)
    for (const text of hunk.lines) {
      if (text.startsWith('+')) {
        ranges.push([line, line])
        line += 1
      } else if (text.startsWith('-')) ranges.push([line, line])
      else if (!text.startsWith('\\')) line += 1
    }
  }
  return ranges
}
