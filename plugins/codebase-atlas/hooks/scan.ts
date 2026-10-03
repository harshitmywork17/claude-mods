import type { Edge, Graph, Group, Site } from '../types'

export const SOURCE_GLOBS = ['*.py', '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs']

/** Lines `git grep -E` matches as possible imports, in POSIX classes so every git build reads them. */
export const IMPORT_PATTERN =
  '^[[:space:]]*(import|from)[[:space:]]|require\\(|^[[:space:]]*export[[:space:]].*[[:space:]]from[[:space:]]'

/** Lines `git grep -E` matches as possible definitions. */
export const SYMBOL_PATTERN =
  '^[[:space:]]*(async[[:space:]]+)?def[[:space:]]+[A-Za-z_]|^[[:space:]]*class[[:space:]]+[A-Za-z_]|function[[:space:]]*\\*?[[:space:]]+[A-Za-z_$]|^[[:space:]]*(export[[:space:]]+)?(const|let)[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*=[[:space:]]*(async[[:space:]]*)?(\\(|function|[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*=>)'

export const MAX_FILES = 4000
const MAX_GROUPS = 80
const MAX_EDGES = 1000
const GROUP_DEPTH = 3
const JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']

export type FileImports = Map<string, Set<string>>
export type SymbolIndex = Map<string, Site[]>

/** Everything a scan learned: the map for the pane, and the indexes later lookups use. */
export type Scan = { graph: Graph; imports: FileImports; symbols: SymbolIndex }

export function isPython(path: string): boolean {
  return path.endsWith('.py')
}

/** The folder a file is drawn under: its directory, cut to GROUP_DEPTH levels. */
export function groupOf(path: string): string {
  const parts = path.split('/').slice(0, -1)
  return parts.length === 0 ? '(root)' : parts.slice(0, GROUP_DEPTH).join('/')
}

/** Splits one `git grep -n` line into file, line number and text. */
export function grepLine(line: string): { file: string; line: number; text: string } | null {
  const match = /^(.+?):(\d+):(.*)$/.exec(line)
  if (match === null) return null
  return { file: match[1] ?? '', line: Number(match[2]), text: match[3] ?? '' }
}

function normalize(parts: readonly string[]): string {
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

function dirOf(path: string): string[] {
  return path.split('/').slice(0, -1)
}

/** Finds the repo file a dotted Python module names, also under a prefix such as src/. */
function pythonFile(dotted: string, base: readonly string[], files: ReadonlySet<string>, bySuffix: Map<string, string>): string | null {
  const stem = normalize([...base, ...dotted.split('.')])
  for (const candidate of [`${stem}.py`, `${stem}/__init__.py`]) {
    if (files.has(candidate)) return candidate
    if (base.length === 0) {
      const found = bySuffix.get(candidate)
      if (found !== undefined) return found
    }
  }
  return null
}

/** The repo files one Python import line brings in. */
export function resolvePython(from: string, text: string, files: ReadonlySet<string>, bySuffix: Map<string, string>): string[] {
  const out: string[] = []
  const fromImport = /^\s*from\s+(\.*)([\w.]*)\s+import\s+(.+)$/.exec(text)
  if (fromImport !== null) {
    const dots = (fromImport[1] ?? '').length
    const module = fromImport[2] ?? ''
    const base = dots === 0 ? [] : dirOf(from).slice(0, Math.max(0, dirOf(from).length - (dots - 1)))
    const whole = module === '' ? null : pythonFile(module, base, files, bySuffix)
    if (whole !== null) out.push(whole)
    const names = (fromImport[3] ?? '').replace(/[()]/g, '').split(',')
    for (const name of names) {
      const bare = name.trim().split(/\s+/)[0] ?? ''
      if (!/^\w+$/.test(bare)) continue
      const sub = pythonFile(module === '' ? bare : `${module}.${bare}`, base, files, bySuffix)
      if (sub !== null) out.push(sub)
    }
    return out
  }
  const plain = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/.exec(text)
  if (plain !== null) {
    for (const module of (plain[1] ?? '').split(',')) {
      const found = pythonFile(module.trim(), [], files, bySuffix)
      if (found !== null) out.push(found)
    }
  }
  return out
}

/** The repo files one JS or TS import line brings in; package imports are left out. */
export function resolveJs(from: string, text: string, files: ReadonlySet<string>): string[] {
  const out: string[] = []
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\(\s*)['"]([^'"]+)['"]/g
  for (const match of text.matchAll(pattern)) {
    const spec = match[1] ?? ''
    if (!spec.startsWith('.')) continue
    const stem = normalize([...dirOf(from), ...spec.split('/')])
    const candidates = [
      stem,
      ...JS_EXTENSIONS.map(ext => `${stem}${ext}`),
      ...JS_EXTENSIONS.map(ext => `${stem}/index${ext}`),
      stem.replace(/\.js$/, '.ts'),
      stem.replace(/\.js$/, '.tsx'),
    ]
    const found = candidates.find(candidate => files.has(candidate))
    if (found !== undefined) out.push(found)
  }
  return out
}

/** The name a definition line declares, or null. */
export function symbolName(text: string): string | null {
  const patterns = [
    /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,
    /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /function\s*\*?\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match?.[1] !== undefined) return match[1]
  }
  return null
}

/** Height of each folder in the dependency order, cycles broken where they close. */
export function levels(ids: readonly string[], edges: readonly Edge[]): Map<string, number> {
  const out = new Map<string, string[]>()
  for (const edge of edges) out.set(edge.from, [...(out.get(edge.from) ?? []), edge.to])
  const memo = new Map<string, number>()
  const visiting = new Set<string>()
  const level = (id: string): number => {
    const known = memo.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return 0
    visiting.add(id)
    const deps = out.get(id) ?? []
    const value = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(level))
    visiting.delete(id)
    memo.set(id, value)
    return value
  }
  return new Map(ids.map(id => [id, level(id)]))
}

/** Builds the map and indexes from the four git outputs a scan collects. */
export function buildScan(root: string, fileList: string, lineCounts: string, importLines: string, symbolLines: string): Scan {
  const fileNames = fileList.split('\n').filter(Boolean)
  const isTruncated = fileNames.length > MAX_FILES
  const files = new Set(fileNames.slice(0, MAX_FILES))
  const bySuffix = new Map<string, string>()
  for (const file of files) {
    const parts = file.split('/')
    for (let start = 1; start < parts.length; start += 1) {
      const suffix = parts.slice(start).join('/')
      if (!bySuffix.has(suffix)) bySuffix.set(suffix, file)
    }
  }

  const lines = new Map<string, number>()
  for (const row of lineCounts.split('\n')) {
    const match = /^(.+):(\d+)$/.exec(row)
    if (match !== null && files.has(match[1] ?? '')) lines.set(match[1] ?? '', Number(match[2]))
  }

  const imports: FileImports = new Map()
  for (const row of importLines.split('\n')) {
    const hit = grepLine(row)
    if (hit === null || !files.has(hit.file)) continue
    const targets = isPython(hit.file) ? resolvePython(hit.file, hit.text, files, bySuffix) : resolveJs(hit.file, hit.text, files)
    for (const target of targets) {
      if (target === hit.file) continue
      const set = imports.get(hit.file) ?? new Set<string>()
      set.add(target)
      imports.set(hit.file, set)
    }
  }

  const symbols: SymbolIndex = new Map()
  const symbolCount = new Map<string, number>()
  for (const row of symbolLines.split('\n')) {
    const hit = grepLine(row)
    if (hit === null || !files.has(hit.file)) continue
    const name = symbolName(hit.text)
    if (name === null) continue
    symbols.set(name, [...(symbols.get(name) ?? []), { symbol: name, file: hit.file, line: hit.line, isKnown: true }])
    symbolCount.set(groupOf(hit.file), (symbolCount.get(groupOf(hit.file)) ?? 0) + 1)
  }

  const groupFiles = new Map<string, string[]>()
  for (const file of files) groupFiles.set(groupOf(file), [...(groupFiles.get(groupOf(file)) ?? []), file])

  const edgeCount = new Map<string, number>()
  for (const [from, targets] of imports) {
    for (const to of targets) {
      const key = `${groupOf(from)}\u0000${groupOf(to)}`
      if (groupOf(from) !== groupOf(to)) edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1)
    }
  }
  const edges: Edge[] = [...edgeCount]
    .map(([key, count]) => {
      const [from = '', to = ''] = key.split('\u0000')
      return { from, to, count }
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_EDGES)

  const byLines = [...groupFiles.keys()].sort(
    (a, b) => (groupFiles.get(b)?.length ?? 0) - (groupFiles.get(a)?.length ?? 0),
  )
  const kept = new Set(byLines.slice(0, MAX_GROUPS))
  const keptEdges = edges.filter(edge => kept.has(edge.from) && kept.has(edge.to))
  const heights = levels([...kept], keptEdges)
  const groups: Group[] = [...kept]
    .map(id => ({
      id,
      files: groupFiles.get(id)?.length ?? 0,
      lines: (groupFiles.get(id) ?? []).reduce((sum, file) => sum + (lines.get(file) ?? 0), 0),
      symbols: symbolCount.get(id) ?? 0,
      level: heights.get(id) ?? 0,
    }))
    .sort((a, b) => b.level - a.level || a.id.localeCompare(b.id))

  return {
    graph: { root, files: files.size, groups, edges: keptEdges, isTruncated: isTruncated || kept.size < groupFiles.size },
    imports,
    symbols,
  }
}

/** Files outside `changed` that import any file in it. */
export function dependentsOf(changed: ReadonlySet<string>, imports: FileImports): string[] {
  const out: string[] = []
  for (const [from, targets] of imports) {
    if (changed.has(from)) continue
    if ([...targets].some(target => changed.has(target))) out.push(from)
  }
  return out.sort()
}

export function shortCount(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value)
}
