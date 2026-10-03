import type { OutlineEntry, SymbolChange, SymbolKind } from '../types'
import { bodyOf } from './calls'
import { isPython, symbolName } from './scan'

export type Range = readonly [number, number]

export type DiffFile = {
  path: string
  status: 'modified' | 'added' | 'deleted'
  added: number
  removed: number
  /** Changed lines in the current file, 1-based and inclusive. */
  ranges: Range[]
}

/** Reads `git diff -U0` output into one entry per file. */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    if (header !== null) {
      current = { path: header[2] ?? '', status: 'modified', added: 0, removed: 0, ranges: [] }
      files.push(current)
      continue
    }
    if (current === null) continue
    if (line.startsWith('new file mode')) current.status = 'added'
    else if (line.startsWith('deleted file mode')) current.status = 'deleted'
    else if (line.startsWith('+++') || line.startsWith('---')) continue
    else if (line.startsWith('@@')) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (hunk !== null) {
        const start = Number(hunk[1])
        const count = hunk[2] === undefined ? 1 : Number(hunk[2])
        current.ranges.push([Math.max(1, start), Math.max(1, start + Math.max(count, 1) - 1)])
      }
    } else if (line.startsWith('+')) current.added += 1
    else if (line.startsWith('-')) current.removed += 1
  }
  return files
}

function indentOf(line: string): number {
  return (/^\s*/.exec(line)?.[0] ?? '').replace(/\t/g, '    ').length
}

const JS_METHOD = /^\s+(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]*)?\{\s*$/
const NOT_METHODS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'function', 'return'])

/** The classes, functions and methods of a file, each with its line span and depth. */
export function outlineOf(text: string, path: string): OutlineEntry[] {
  const lines = text.split('\n')
  const entries: OutlineEntry[] = []
  const classes: { endLine: number; indent: number }[] = []

  lines.forEach((line, index) => {
    const number = index + 1
    while (classes.length > 0 && (classes[classes.length - 1]?.endLine ?? 0) < number) classes.pop()

    let name = symbolName(line)
    let kind: SymbolKind | null = null
    if (name !== null) {
      kind = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s/.test(line) ? 'class' : 'function'
    } else if (!isPython(path) && classes.length > 0) {
      const method = JS_METHOD.exec(line)
      if (method?.[1] !== undefined && !NOT_METHODS.has(method[1])) {
        name = method[1]
        kind = 'method'
      }
    }
    if (name === null || kind === null) return

    const insideClass = classes.length > 0 && (!isPython(path) || indentOf(line) > (classes[classes.length - 1]?.indent ?? 0))
    if (kind === 'function' && insideClass) kind = 'method'
    const endLine = number + bodyOf(text, number, path).length - 1
    entries.push({ name, kind, line: number, endLine, depth: insideClass ? classes.length : 0, isChanged: false, calls: [] })
    if (kind === 'class') classes.push({ endLine, indent: indentOf(line) })
  })
  return entries
}

function overlaps(entry: OutlineEntry, ranges: readonly Range[]): boolean {
  return ranges.some(([start, end]) => start <= entry.endLine && end >= entry.line)
}

/** Marks entries whose span a change touches; a class counts only for changes outside its methods. */
export function markChanged(entries: readonly OutlineEntry[], ranges: readonly Range[]): OutlineEntry[] {
  return entries.map(entry => {
    if (!overlaps(entry, ranges)) return entry
    if (entry.kind !== 'class') return { ...entry, isChanged: true }
    const members = entries.filter(other => other !== entry && other.line > entry.line && other.endLine <= entry.endLine)
    const outsideMembers = ranges.some(
      ([start, end]) =>
        start <= entry.endLine &&
        end >= entry.line &&
        !members.some(member => start >= member.line && end <= member.endLine),
    )
    return { ...entry, isChanged: outsideMembers }
  })
}

/** What changed in one file at the level of its functions and classes. */
export function symbolChanges(current: readonly OutlineEntry[], before: readonly OutlineEntry[], ranges: readonly Range[]): SymbolChange[] {
  const beforeNames = new Set(before.map(entry => `${entry.kind}:${entry.name}`))
  const currentNames = new Set(current.map(entry => `${entry.kind}:${entry.name}`))
  const changes: SymbolChange[] = []
  for (const entry of markChanged(current, ranges)) {
    const key = `${entry.kind}:${entry.name}`
    if (!beforeNames.has(key)) changes.push({ name: entry.name, kind: entry.kind, change: 'added', line: entry.line, callers: 0 })
    else if (entry.isChanged) changes.push({ name: entry.name, kind: entry.kind, change: 'modified', line: entry.line, callers: 0 })
  }
  for (const entry of before) {
    if (!currentNames.has(`${entry.kind}:${entry.name}`)) {
      changes.push({ name: entry.name, kind: entry.kind, change: 'removed', line: entry.line, callers: 0 })
    }
  }
  return changes
}

/**
 * Counts call sites per name from `git grep -o` output, leaving out each name's own definition lines
 * and longer identifiers that only end in a name (`refetch(` is not a call of `fetch`).
 */
export function countCallers(grepOutput: string, definitions: ReadonlySet<string>, names: ReadonlySet<string>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const line of grepOutput.split('\n')) {
    const match = /^(.+?):(\d+):([A-Za-z_$][\w$]*)/.exec(line)
    if (match === null) continue
    const [, file = '', number = '', name = ''] = match
    if (!names.has(name) || definitions.has(`${file}:${number}:${name}`)) continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return counts
}

export function escapeRegex(name: string): string {
  return name.replace(/[$]/g, '\\$')
}
