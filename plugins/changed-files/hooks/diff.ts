export type Hunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: readonly string[]
}

/** The parts of an Edit or Write result a diff is built from. */
export type FileResult = {
  filePath: string
  structuredPatch: readonly Hunk[]
  originalFile: string | null
  content?: string
  type?: 'create' | 'update'
  staged?: boolean
}

export type Change = {
  file: string
  kind: 'edit' | 'create' | 'overwrite'
  diff: string
  added: number
  removed: number
  isCut: boolean
}

/** Code renders at most 10000 characters; leave room for the hunk headers. */
const MAX_SOURCE = 9000

function header(hunk: Hunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
}

function recount(hunk: Hunk, lines: readonly string[]): Hunk {
  const oldLines = lines.filter(line => !line.startsWith('+')).length
  const newLines = lines.filter(line => !line.startsWith('-')).length
  return { ...hunk, oldLines, newLines, lines }
}

/** Joins hunks into unified-diff text, cutting whole lines (headers kept valid) past the limit. */
export function toSource(hunks: readonly Hunk[], limit = MAX_SOURCE): { source: string; isCut: boolean } {
  let source = ''
  for (const hunk of hunks) {
    const whole = `${header(hunk)}\n${hunk.lines.join('\n')}\n`
    if (source.length + whole.length <= limit) {
      source += whole
      continue
    }
    if (source === '') {
      const kept: string[] = []
      let size = 40
      for (const line of hunk.lines) {
        if (size + line.length + 1 > limit) break
        kept.push(line)
        size += line.length + 1
      }
      const cut = recount(hunk, kept)
      source = `${header(cut)}\n${kept.join('\n')}\n`
    }
    return { source, isCut: true }
  }
  return { source, isCut: false }
}

function creationHunk(content: string): Hunk {
  const lines = content.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return { oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map(line => `+${line}`) }
}

export function relative(path: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return path
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`
  return path.startsWith(root) ? path.slice(root.length) : path
}

/** The change an Edit or Write made, or null when it wrote nothing (staged for review). */
export function changeOf(result: FileResult, cwd?: string): Change | null {
  if (result.staged === true) return null

  const isCreate = result.type === 'create' || (result.type !== undefined && result.originalFile === null)
  const hunks =
    result.structuredPatch.length === 0 && isCreate && result.content !== undefined
      ? [creationHunk(result.content)]
      : result.structuredPatch
  const lines = hunks.flatMap(hunk => hunk.lines)
  const { source, isCut } = toSource(hunks)

  return {
    file: relative(result.filePath, cwd),
    kind: result.type === undefined ? 'edit' : isCreate ? 'create' : 'overwrite',
    diff: source,
    added: lines.filter(line => line.startsWith('+')).length,
    removed: lines.filter(line => line.startsWith('-')).length,
    isCut,
  }
}
