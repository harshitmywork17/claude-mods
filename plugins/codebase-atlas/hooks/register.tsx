import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, RenderNode, Register } from 'claude-code'

import type {
  Activity,
  CallView,
  ChangeMap,
  Decision,
  FileChange,
  Graph,
  Insight,
  Outline,
  Site,
  SymbolKind,
  Tab,
} from '../types'
import { bodyOf, calleesIn, enclosingSymbol, isDefinitionLine, symbolFromSelection } from './calls'
import { countCallers, escapeRegex, lineDiff, markChanged, outlineOf, parseDiff, symbolChanges } from './changes'
import type { DiffFile, Range } from './changes'
import {
  DECISION_MODEL,
  DECISION_SYSTEM,
  decisionPrompt,
  explainChangesPrompt,
  explainFunctionPrompt,
  explainModulePrompt,
  parseDecisions,
} from './prompts'
import {
  IMPORT_PATTERN,
  IMPORT_RE,
  SKIPPED_DIRS,
  SOURCE_GLOBS,
  SYMBOL_PATTERN,
  SYMBOL_RE,
  buildScan,
  countTexts,
  dependentsOf,
  grepLine,
  grepMatches,
  grepTexts,
  groupOf,
  isSource,
  shortCount,
} from './scan'
import type { Scan } from './scan'

const graphAtom = atom({ plugin: 'codebase-atlas', key: 'graph' } as const, null)
const scanStatusAtom = atom({ plugin: 'codebase-atlas', key: 'scanStatus' } as const, 'idle')
const scanErrorAtom = atom({ plugin: 'codebase-atlas', key: 'scanError' } as const, '')
const activityAtom = atom({ plugin: 'codebase-atlas', key: 'activity' } as const, [])
const tabAtom = atom({ plugin: 'codebase-atlas', key: 'tab' } as const, 'map')
const focusAtom = atom({ plugin: 'codebase-atlas', key: 'focus' } as const, null)
const changesAtom = atom({ plugin: 'codebase-atlas', key: 'changes' } as const, { status: 'idle', files: [], layers: [], dependents: [] })
const outlineAtom = atom({ plugin: 'codebase-atlas', key: 'outline' } as const, null)
const callAtom = atom({ plugin: 'codebase-atlas', key: 'call' } as const, null)
const trailAtom = atom({ plugin: 'codebase-atlas', key: 'trail' } as const, [])
const decisionsAtom = atom({ plugin: 'codebase-atlas', key: 'decisions' } as const, [])
const isExtractingAtom = atom({ plugin: 'codebase-atlas', key: 'isExtracting' } as const, false)
const insightAtom = atom({ plugin: 'codebase-atlas', key: 'insight' } as const, null)

const MAX_CHANGED_FILES = 30
const MAX_CALLER_NAMES = 25
const MAX_CALLERS = 40
const MAX_DECISIONS = 60
const GIT_TIMEOUT_MS = 20_000
const MAX_FOLDER_FILES = 1500
const MAX_FOLDER_DIRS = 2000
const MAX_FILE_BYTES = 512 * 1024

type Source = { root: string; isGit: boolean }

let cwd = ''
let cache: Scan | null = null
let isScanning = false
let source: Source | null = null

/** Folder mode: each source file's text and modification time as last read. */
const current = new Map<string, { text: string; mtimeMs: number }>()
/** Folder mode: each file as the first scan found it; null for a file that appeared after that scan. */
const baseline = new Map<string, string | null>()
let hasBaseline = false

function setCwd(value: string): void {
  cwd = value
}

type GitResult = { isOk: boolean; out: string; err: string }

/** Runs git in the repo; `git grep` finding nothing (exit 1 with no error text) counts as success. */
async function git($: EngineInterface, root: string, args: readonly string[]): Promise<GitResult> {
  const run = await $.process.run(['git', '-C', root, ...args], { timeoutMs: GIT_TIMEOUT_MS })
  const isEmptyGrep = args[0] === 'grep' && run.exitCode === 1 && run.stderr.trim() === ''
  return { isOk: run.exitCode === 0 || isEmptyGrep, out: run.stdout, err: run.stderr.trim() }
}

/** The folder Atlas reads: the git repository around the session, or else the session's own folder. */
async function findSource($: EngineInterface): Promise<Source | null> {
  if (source !== null) return source
  try {
    const run = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: cwd || undefined, timeoutMs: 5000 })
    if (run.exitCode === 0 && run.stdout.trim() !== '') {
      source = { root: run.stdout.trim(), isGit: true }
      return source
    }
  } catch {
    // No git on this machine: read the folder directly.
  }
  if (cwd === '') return null
  source = { root: cwd.replace(/\/+$/, ''), isGit: false }
  return source
}

/** A path as the repo names it: relative to the root when inside it. */
function relative(path: string, root: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
}

/** Lines in a text, not counting the empty piece after a final newline. */
function lineTotal(text: string): number {
  if (text === '') return 0
  const lines = text.split('\n')
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
}

async function readText($: EngineInterface, path: string): Promise<string> {
  try {
    return await $.fs.read(path)
  } catch {
    return ''
  }
}

/** Folder mode: the source files under the root, leaving out dependencies, environments, caches and build output. */
async function walkFolder($: EngineInterface, root: string): Promise<{ path: string; mtimeMs: number }[]> {
  const found: { path: string; mtimeMs: number }[] = []
  const queue = ['']
  let dirs = 0
  while (queue.length > 0 && found.length < MAX_FOLDER_FILES && dirs < MAX_FOLDER_DIRS) {
    const dir = queue.shift() ?? ''
    dirs += 1
    let entries: Awaited<ReturnType<EngineInterface['fs']['list']>>
    try {
      entries = await $.fs.list(dir === '' ? root : `${root}/${dir}`)
    } catch {
      continue
    }
    if (dir !== '' && entries.some(entry => entry.name === 'pyvenv.cfg')) continue
    for (const entry of entries) {
      const path = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (entry.kind === 'dir' && !entry.isLink && !entry.name.startsWith('.') && !SKIPPED_DIRS.has(entry.name)) queue.push(path)
      else if (entry.kind === 'file' && isSource(entry.name) && entry.size <= MAX_FILE_BYTES) found.push({ path, mtimeMs: entry.mtimeMs })
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path)).slice(0, MAX_FOLDER_FILES)
}

/** Folder mode: re-reads only files whose time changed; the first scan's texts stay as the baseline. */
async function syncFolder($: EngineInterface, root: string): Promise<void> {
  const listed = await walkFolder($, root)
  const seen = new Set<string>()
  for (const file of listed) {
    seen.add(file.path)
    if (current.get(file.path)?.mtimeMs === file.mtimeMs) continue
    const text = await readText($, `${root}/${file.path}`)
    current.set(file.path, { text, mtimeMs: file.mtimeMs })
    if (!baseline.has(file.path)) baseline.set(file.path, hasBaseline ? null : text)
  }
  for (const path of [...current.keys()]) if (!seen.has(path)) current.delete(path)
  hasBaseline = true
}

function currentTexts(): Map<string, string> {
  return new Map([...current].map(([path, file]) => [path, file.text]))
}

/** Folder mode: the same scan git mode builds, from the texts in memory. */
function folderScan(root: string): Scan {
  const texts = currentTexts()
  return buildScan(root, [...texts.keys()].join('\n'), countTexts(texts), grepTexts(texts, IMPORT_RE), grepTexts(texts, SYMBOL_RE), false)
}

/** Lines matching a pattern across the sources, as `git grep -n` prints them (`-o` with `isOnlyMatch`). */
async function searchSources($: EngineInterface, src: Source, gitPattern: string, jsPattern: RegExp, isOnlyMatch: boolean): Promise<string> {
  if (src.isGit) {
    const flags = isOnlyMatch ? ['-n', '-o', '-I', '-E'] : ['-n', '-I', '-E']
    return (await git($, src.root, ['grep', ...flags, gitPattern, '--', ...SOURCE_GLOBS])).out
  }
  return isOnlyMatch ? grepMatches(currentTexts(), jsPattern) : grepTexts(currentTexts(), jsPattern)
}

async function sourceText($: EngineInterface, src: Source, path: string): Promise<string> {
  return src.isGit ? readText($, `${src.root}/${path}`) : (current.get(path)?.text ?? readText($, `${src.root}/${path}`))
}

/** Scans the code for files, imports and definitions, and draws the map from them. */
async function scan($: EngineInterface): Promise<void> {
  if (isScanning) return
  isScanning = true
  await update($, scanStatusAtom, () => 'scanning')
  try {
    cache = null
    const src = await findSource($)
    if (src === null) {
      await update($, scanStatusAtom, () => 'no-folder')
      return
    }
    if (src.isGit) {
      const files = await git($, src.root, ['ls-files', '--', ...SOURCE_GLOBS])
      if (!files.isOk) throw new Error(files.err || 'git ls-files failed')
      const counts = await git($, src.root, ['grep', '-c', '-I', '', '--', ...SOURCE_GLOBS])
      const imports = await git($, src.root, ['grep', '-n', '-I', '-E', IMPORT_PATTERN, '--', ...SOURCE_GLOBS])
      const symbols = await git($, src.root, ['grep', '-n', '-I', '-E', SYMBOL_PATTERN, '--', ...SOURCE_GLOBS])
      cache = buildScan(src.root, files.out, counts.out, imports.out, symbols.out, true)
    } else {
      await syncFolder($, src.root)
      cache = folderScan(src.root)
    }
    const graph = cache.graph
    await update($, graphAtom, () => graph)
    await update($, scanStatusAtom, () => 'ready')
  } catch (error) {
    await update($, scanErrorAtom, () => String(error))
    await update($, scanStatusAtom, () => 'error')
  } finally {
    isScanning = false
  }
}

async function ensureScan($: EngineInterface): Promise<Scan | null> {
  if (cache === null) await scan($)
  return cache
}

async function recordActivity($: EngineInterface, path: string, kind: 'read' | 'edit'): Promise<void> {
  await update($, activityAtom, list => {
    const found = list.find(one => one.path === path) ?? { path, reads: 0, edits: 0 }
    const next = kind === 'read' ? { ...found, reads: found.reads + 1 } : { ...found, edits: found.edits + 1 }
    return [next, ...list.filter(one => one.path !== path)].slice(0, 300)
  })
}

function toFileChange(diff: DiffFile, after: string, before: string): FileChange {
  const symbols = symbolChanges(outlineOf(after, diff.path), outlineOf(before, diff.path), diff.ranges)
  return { path: diff.path, group: groupOf(diff.path), status: diff.status, added: diff.added, removed: diff.removed, symbols }
}

/** Git mode: uncommitted and untracked changes against HEAD. */
async function gitChanges($: EngineInterface, root: string): Promise<FileChange[]> {
  const diff = await git($, root, ['diff', '-U0', 'HEAD', '--', ...SOURCE_GLOBS])
  const untracked = await git($, root, ['ls-files', '--others', '--exclude-standard', '--', ...SOURCE_GLOBS])
  const diffs = parseDiff(diff.isOk ? diff.out : '')
  for (const path of untracked.out.split('\n').filter(Boolean)) {
    const lines = lineTotal(await readText($, `${root}/${path}`))
    diffs.push({ path, status: 'added', added: lines, removed: 0, ranges: [[1, lines]] })
  }
  const files: FileChange[] = []
  for (const one of diffs.slice(0, MAX_CHANGED_FILES)) {
    const after = one.status === 'deleted' ? '' : await readText($, `${root}/${one.path}`)
    const before = one.status === 'added' ? '' : (await git($, root, ['show', `HEAD:${one.path}`])).out
    files.push(toFileChange(one, after, before))
  }
  return files
}

/** Folder mode: every file whose text differs from the baseline snapshot. */
function folderDiffs(): (DiffFile & { text: string; before: string; after: string })[] {
  const out: (DiffFile & { text: string; before: string; after: string })[] = []
  for (const path of [...new Set([...baseline.keys(), ...current.keys()])].sort()) {
    const before = baseline.get(path) ?? null
    const after = current.get(path)?.text ?? null
    if (before === after || (before === null && after === null)) continue
    const diff = lineDiff(path, before, after)
    if (diff.ranges.length === 0) continue
    out.push({ ...diff, before: before ?? '', after: after ?? '' })
    if (out.length >= MAX_CHANGED_FILES) break
  }
  return out
}

/** Maps every change to the functions and classes it touched, with call sites, layers and impact. */
async function refreshChanges($: EngineInterface): Promise<void> {
  await update($, changesAtom, (current): ChangeMap => ({ ...current, status: 'loading' }))
  try {
    const src = await findSource($)
    if (src === null) throw new Error('Codebase Atlas could not tell which folder to read.')
    let scanned = await ensureScan($)
    let files: FileChange[]
    if (src.isGit) {
      files = await gitChanges($, src.root)
    } else {
      await syncFolder($, src.root)
      scanned = folderScan(src.root)
      cache = scanned
      const graph = scanned.graph
      await update($, graphAtom, () => graph)
      files = folderDiffs().map(diff => toFileChange(diff, diff.after, diff.before))
    }

    const names = [...new Set(files.flatMap(file => file.symbols.filter(s => s.change !== 'removed').map(s => s.name)))]
      .filter(name => /^[A-Za-z_$][\w$]*$/.test(name))
      .slice(0, MAX_CALLER_NAMES)
    if (names.length > 0) {
      const alternatives = names.map(escapeRegex).join('|')
      const hits = await searchSources($, src, `[A-Za-z0-9_$]*(${alternatives})[[:space:]]*\\(`, new RegExp(`[A-Za-z0-9_$]*(${alternatives})\\s*\\(`), true)
      const definitions = new Set<string>()
      for (const [name, sites] of scanned?.symbols ?? []) for (const site of sites) definitions.add(`${site.file}:${site.line}:${name}`)
      for (const file of files) for (const s of file.symbols) definitions.add(`${file.path}:${s.line}:${s.name}`)
      const counts = countCallers(hits, definitions, new Set(names))
      for (const file of files) for (const s of file.symbols) s.callers = counts.get(s.name) ?? 0
    }

    const levelOf = new Map((await read($, graphAtom))?.groups.map(group => [group.id, group.level]) ?? [])
    const layers = [...new Set(files.map(file => file.group))].sort((a, b) => (levelOf.get(b) ?? 0) - (levelOf.get(a) ?? 0))
    const dependents = scanned === null ? [] : dependentsOf(new Set(files.map(file => file.path)), scanned.imports).slice(0, 30)
    const map: ChangeMap = { status: 'ready', files, layers, dependents }
    await update($, changesAtom, () => map)
  } catch (error) {
    await update($, changesAtom, (current): ChangeMap => ({ ...current, status: 'error', error: String(error) }))
  }
}

/** Builds the component outline of one file: its classes, functions and methods, what each calls, and what changed. */
async function loadOutline($: EngineInterface, path: string): Promise<void> {
  await update($, outlineAtom, (): Outline => ({ file: path, status: 'loading', lines: 0, entries: [] }))
  await update($, tabAtom, () => 'components')
  try {
    const src = await findSource($)
    if (src === null) throw new Error('Codebase Atlas could not tell which folder to read.')
    const scanned = await ensureScan($)
    const text = await sourceText($, src, path)
    if (text === '') throw new Error(`Could not read ${path}.`)
    let ranges: Range[]
    if (src.isGit) {
      const diff = parseDiff((await git($, src.root, ['diff', '-U0', 'HEAD', '--', path])).out)[0]
      const isUntracked = (await git($, src.root, ['ls-files', '--', path])).out.trim() === ''
      ranges = isUntracked ? [[1, lineTotal(text)]] : (diff?.ranges ?? [])
    } else {
      const before = baseline.get(path)
      ranges = before === undefined ? [] : lineDiff(path, before, text).ranges
    }
    const entries = markChanged(outlineOf(text, path), ranges).map(entry => ({
      ...entry,
      calls: entry.kind === 'class' ? [] : calleesIn(bodyOf(text, entry.line, path), entry.name, scanned?.symbols ?? new Map())
        .filter(site => site.isKnown)
        .map(site => site.symbol)
        .slice(0, 8),
    }))
    await update($, outlineAtom, (): Outline => ({ file: path, status: 'ready', lines: lineTotal(text), entries }))
  } catch (error) {
    await update($, outlineAtom, (): Outline => ({ file: path, status: 'error', lines: 0, entries: [], error: String(error) }))
  }
}

/** Finds a function's definition, who calls it and what it calls. */
async function loadCalls($: EngineInterface, symbol: string, isFromTrail = false): Promise<void> {
  const name = symbol.trim()
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
    await update($, callAtom, (): CallView => ({ symbol: name, status: 'error', callers: [], callees: [], error: 'Type one function or class name.' }))
    await update($, tabAtom, () => 'calls')
    return
  }
  await update($, callAtom, (): CallView => ({ symbol: name, status: 'loading', callers: [], callees: [] }))
  await update($, tabAtom, () => 'calls')
  if (!isFromTrail) await update($, trailAtom, trail => [...trail.filter(one => one !== name), name].slice(-20))
  try {
    const src = await findSource($)
    if (src === null) throw new Error('Codebase Atlas could not tell which folder to read.')
    const scanned = await ensureScan($)
    const index = scanned?.symbols ?? new Map<string, Site[]>()
    const definition = index.get(name)?.[0]

    const texts = new Map<string, string>()
    const textOf = async (file: string): Promise<string> => {
      if (!texts.has(file)) texts.set(file, await sourceText($, src, file))
      return texts.get(file) ?? ''
    }

    const escaped = escapeRegex(name)
    const hits = await searchSources($, src, `(^|[^A-Za-z0-9_$])${escaped}[[:space:]]*\\(`, new RegExp(`(^|[^A-Za-z0-9_$])${escaped}\\s*\\(`), false)
    const callers: Site[] = []
    const seen = new Set<string>()
    for (const row of hits.split('\n')) {
      const hit = grepLine(row)
      if (hit === null || isDefinitionLine(hit.text, name)) continue
      const caller = enclosingSymbol(await textOf(hit.file), hit.line, hit.file)
      const key = `${caller}@${hit.file}`
      if (seen.has(key)) continue
      seen.add(key)
      callers.push({ symbol: caller, file: hit.file, line: hit.line, isKnown: index.has(caller) })
      if (callers.length >= MAX_CALLERS) break
    }

    const callees = definition === undefined ? [] : calleesIn(bodyOf(await textOf(definition.file), definition.line, definition.file), name, index)
    const view: CallView = {
      symbol: name,
      status: definition === undefined && callers.length === 0 ? 'missing' : 'ready',
      definition,
      callers,
      callees,
    }
    await update($, callAtom, () => view)
  } catch (error) {
    await update($, callAtom, (): CallView => ({ symbol: name, status: 'error', callers: [], callees: [], error: String(error) }))
  }
}

async function showInsight($: EngineInterface, title: string, prompt: () => Promise<string>): Promise<void> {
  const loading: Insight = { title, status: 'loading', text: '' }
  await update($, insightAtom, () => loading)
  await update($, tabAtom, (): Tab => 'explain')
  try {
    const reply = await $.model.fork({ prompt: await prompt() })
    const text = reply.isAnswered ? reply.text : `No answer (${reply.reason}). Ask Claude something first, then try again.`
    await update($, insightAtom, () => ({ title, status: reply.isAnswered ? 'ready' : 'error', text }))
  } catch (error) {
    await update($, insightAtom, () => ({ title, status: 'error', text: String(error) }))
  }
}

async function explainModule($: EngineInterface, id: string): Promise<void> {
  await showInsight($, `Folder ${id}`, async () => {
    const scanned = await ensureScan($)
    const files = [...new Set([...(scanned?.symbols.values() ?? [])].flat().map(site => site.file))].filter(file => groupOf(file) === id)
    const symbols = [...(scanned?.symbols ?? new Map<string, Site[]>())]
      .filter(([, sites]) => sites.some(site => groupOf(site.file) === id))
      .map(([name]) => name)
    const edges = (await read($, graphAtom))?.edges ?? []
    return explainModulePrompt(
      id,
      files,
      symbols,
      edges.filter(edge => edge.from === id).map(edge => edge.to),
      edges.filter(edge => edge.to === id).map(edge => edge.from),
    )
  })
}

async function explainFunction($: EngineInterface, view: CallView): Promise<void> {
  await showInsight($, `Function ${view.symbol}`, async () => {
    const src = await findSource($)
    const definition = view.definition
    const body = definition === undefined || src === null ? '' : bodyOf(await sourceText($, src, definition.file), definition.line, definition.file).join('\n')
    return explainFunctionPrompt(
      view.symbol,
      definition?.file ?? 'an unknown file',
      body,
      view.callers.map(site => site.symbol),
      view.callees.filter(site => site.isKnown).map(site => site.symbol),
    )
  })
}

async function explainChanges($: EngineInterface): Promise<void> {
  await showInsight($, 'This session’s changes', async () => {
    const changes = await read($, changesAtom)
    const summary = changes.files
      .map(file => `${file.path} (+${file.added} −${file.removed}): ${file.symbols.map(s => `${s.change} ${s.name}`).join(', ') || 'no function-level change'}`)
      .join('\n')
    const src = await findSource($)
    const diff = src === null ? '' : src.isGit ? (await git($, src.root, ['diff', 'HEAD', '--', ...SOURCE_GLOBS])).out : folderDiffs().map(one => one.text).join('\n')
    return explainChangesPrompt(summary || 'No changes found.', diff)
  })
}

/** Pulls the decisions out of one finished turn with a small model, in the background. */
async function extractDecisions($: EngineInterface, request: string, answer: string, edited: readonly string[]): Promise<void> {
  await update($, isExtractingAtom, () => true)
  try {
    const reply = await $.model.complete({
      model: DECISION_MODEL,
      system: DECISION_SYSTEM,
      prompt: decisionPrompt(request, answer, edited),
      maxTokens: 700,
    })
    if (reply.isAnswered) {
      const found = parseDecisions(reply.text, request.slice(0, 120), `d${await $.clock.now()}`)
      if (found.length > 0) await update($, decisionsAtom, list => [...list, ...found].slice(-MAX_DECISIONS))
    }
  } finally {
    await update($, isExtractingAtom, () => false)
  }
}

const PANE = 'codebase-atlas'
const TITLE = 'Codebase Atlas'
const READ_TOOLS = new Set(['Read'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const LONG_ANSWER = 400

type T = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Markdown'>

const TABS: { tab: Tab; label: string; key: string }[] = [
  { tab: 'map', label: 'Map', key: '1' },
  { tab: 'changes', label: 'Changes', key: '2' },
  { tab: 'components', label: 'Components', key: '3' },
  { tab: 'calls', label: 'Calls', key: '4' },
  { tab: 'decisions', label: 'Decisions', key: '5' },
  { tab: 'explain', label: 'Explain', key: '6' },
]

const KIND_ICON: Record<SymbolKind, string> = { class: '◆', function: 'ƒ', method: '·' }
const CHANGE_STYLE = {
  added: { mark: '+', color: 'green' },
  modified: { mark: '~', color: 'yellow' },
  removed: { mark: '−', color: 'red' },
} as const

function filePath(path: string, line?: number): string {
  return line === undefined || line === 0 ? path : `${path}:${line}`
}

type GroupActivity = { reads: number; edits: number }

function activityByGroup(activity: readonly Activity[], root: string): Map<string, GroupActivity> {
  const out = new Map<string, GroupActivity>()
  for (const one of activity) {
    const id = groupOf(relative(one.path, root))
    const sum = out.get(id) ?? { reads: 0, edits: 0 }
    out.set(id, { reads: sum.reads + one.reads, edits: sum.edits + one.edits })
  }
  return out
}

function mapView($: EngineInterface, t: T, graph: Graph, activity: readonly Activity[], focus: string | null): RenderNode {
  const { Box, Text, Button } = t
  const touched = activityByGroup(activity, graph.root)
  const levels = [...new Set(graph.groups.map(group => group.level))].sort((a, b) => b - a)
  const focused = graph.groups.find(group => group.id === focus)
  const files = activity.map(one => relative(one.path, graph.root)).filter(path => focused !== undefined && groupOf(path) === focused.id)

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={2}>
        <Text dimColor>
          {graph.files} files · {graph.groups.length} folders{graph.isTruncated ? ' (largest shown)' : ''}
        </Text>
        {!graph.isGit && <Text color="magenta">folder mode (no git)</Text>}
        <Text color="yellow">■ edited</Text>
        <Text color="cyan">■ read</Text>
        <Text dimColor>■ untouched</Text>
      </Box>
      {levels.map((level, index) => (
        <Box key={`level-${level}`} flexDirection="column">
          {index > 0 && <Text dimColor>{'   ▼ imports'}</Text>}
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            <Box width={4} flexShrink={0}>
              <Text dimColor>L{level}</Text>
            </Box>
            {graph.groups
              .filter(group => group.level === level)
              .map(group => {
                const hit = touched.get(group.id)
                const color = hit === undefined ? 'gray' : hit.edits > 0 ? 'yellow' : 'cyan'
                return (
                  <Box
                    key={`box-${group.id}`}
                    flexDirection="column"
                    borderStyle={group.id === focus ? 'double' : 'round'}
                    borderColor={color}
                    paddingX={1}
                  >
                    <Button key={`g:${group.id}`} label={group.id} plain onPress={() => update($, focusAtom, now => (now === group.id ? null : group.id))} />
                    <Text dimColor>
                      {group.files} files · {shortCount(group.lines)} lines
                    </Text>
                    {hit !== undefined && (
                      <Text color={color}>
                        {hit.edits > 0 ? `✎ ${hit.edits} ` : ''}
                        {hit.reads > 0 ? `◉ ${hit.reads}` : ''}
                      </Text>
                    )}
                  </Box>
                )
              })}
          </Box>
        </Box>
      ))}
      {focused !== undefined && (
        <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginTop={1}>
          <Text bold color="magenta">
            {focused.id} · {focused.symbols} functions and classes · layer L{focused.level}
          </Text>
          <Text>
            imports → {graph.edges.filter(edge => edge.from === focused.id).map(edge => `${edge.to} (${edge.count})`).join(', ') || 'nothing in the repo'}
          </Text>
          <Text>
            used by ← {graph.edges.filter(edge => edge.to === focused.id).map(edge => `${edge.from} (${edge.count})`).join(', ') || 'nothing in the repo'}
          </Text>
          {files.length > 0 && <Text dimColor>Touched this session:</Text>}
          {files.slice(0, 8).map((path, index) => (
            <Button key={`mf:${index}`} label={`▸ ${path}`} plain onPress={() => void loadOutline($, path)} />
          ))}
          <Box flexDirection="row" gap={1}>
            <Button key="explain-folder" label="explain this folder" hotkey="e" onPress={() => void explainModule($, focused.id)} />
          </Box>
        </Box>
      )}
      {focused === undefined && <Text dimColor>Select a folder to see what it imports, what uses it, and to explain it.</Text>}
    </Box>
  )
}

function changesView($: EngineInterface, t: T, changes: ChangeMap, isGit: boolean): RenderNode {
  const { Box, Text, Button } = t
  const added = changes.files.reduce((sum, file) => sum + file.added, 0)
  const removed = changes.files.reduce((sum, file) => sum + file.removed, 0)

  return (
    <Box flexDirection="column">
      {changes.status === 'loading' && <Text color="cyan">Mapping changes to functions…</Text>}
      {changes.status === 'error' && <Text color="red">{changes.error}</Text>}
      {changes.status === 'idle' && <Text dimColor>Press refresh to map the changes to the functions they touch.</Text>}
      {!isGit && <Text dimColor>No git here: changes are compared with the files as Codebase Atlas first read them this session.</Text>}
      {changes.status === 'ready' && changes.files.length === 0 && (
        <Text dimColor>{isGit ? 'No uncommitted changes in source files.' : 'No changes since Codebase Atlas first read this folder.'}</Text>
      )}
      {changes.files.length > 0 && (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text bold>
              {changes.files.length} file{changes.files.length === 1 ? '' : 's'}
            </Text>
            <Text color="green">+{added}</Text>
            <Text color="red">−{removed}</Text>
          </Box>
          <Text color="magenta" wrap="truncate-end">
            Layers crossed: {changes.layers.join('  →  ')}
          </Text>
        </Box>
      )}
      {changes.files.map((file, fileIndex) => (
        <Box key={`cf-${fileIndex}`} flexDirection="column" marginTop={1}>
          <Box flexDirection="row" gap={1}>
            <Button key={`cfile:${fileIndex}`} label={file.path} plain onPress={() => void loadOutline($, file.path)} />
            <Text color={file.status === 'added' ? 'green' : file.status === 'deleted' ? 'red' : 'yellow'}>{file.status}</Text>
            <Text color="green">+{file.added}</Text>
            <Text color="red">−{file.removed}</Text>
          </Box>
          {file.symbols.length === 0 && <Text dimColor>{'   no function-level change (imports, constants or top-level code)'}</Text>}
          {file.symbols.map((change, index) => (
            <Box key={`cs-${fileIndex}-${index}`} flexDirection="row" gap={1}>
              <Text color={CHANGE_STYLE[change.change].color}>
                {'   '}
                {CHANGE_STYLE[change.change].mark} {KIND_ICON[change.kind]}
              </Text>
              {change.change === 'removed' ? (
                <Text strikethrough dimColor>
                  {change.name}
                </Text>
              ) : (
                <Button key={`csym:${fileIndex}:${index}`} label={change.name} plain onPress={() => void loadCalls($, change.name)} />
              )}
              <Text dimColor>
                {change.change} · L{change.line}
                {change.change === 'removed' ? '' : ` · ${change.callers} call site${change.callers === 1 ? '' : 's'}`}
              </Text>
            </Box>
          ))}
        </Box>
      ))}
      {changes.dependents.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="yellow">
            Affected elsewhere: {changes.dependents.length} file{changes.dependents.length === 1 ? '' : 's'} import what changed
          </Text>
          {changes.dependents.slice(0, 10).map((path, index) => (
            <Button key={`dep:${index}`} label={`▸ ${path}`} plain onPress={() => void loadOutline($, path)} />
          ))}
        </Box>
      )}
      <Box flexDirection="row" gap={1} marginTop={1}>
        <Button key="refresh-changes" label="refresh" hotkey="r" onPress={() => void refreshChanges($)} />
        {changes.files.length > 0 && <Button key="explain-changes" label="explain these changes" hotkey="e" onPress={() => void explainChanges($)} />}
      </Box>
    </Box>
  )
}

function componentsView($: EngineInterface, t: T, outline: Outline | null, recent: readonly string[], columns: number): RenderNode {
  const { Box, Text, Button } = t
  const longest = Math.max(1, ...(outline?.entries ?? []).map(entry => entry.endLine - entry.line + 1))
  const barWidth = Math.max(6, Math.min(24, Math.floor(columns * 0.2)))

  return (
    <Box flexDirection="column">
      {recent.length > 0 && (
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          <Text dimColor>Files:</Text>
          {recent.slice(0, 8).map((path, index) => (
            <Button key={`rf:${index}`} label={path.split('/').pop() ?? path} plain onPress={() => void loadOutline($, path)} />
          ))}
        </Box>
      )}
      {outline === null && <Text dimColor>Pick a file above, or a file in Map or Changes, to see its classes, functions and what each calls.</Text>}
      {outline?.status === 'loading' && <Text color="cyan">Reading {outline.file}…</Text>}
      {outline?.status === 'error' && <Text color="red">{outline.error}</Text>}
      {outline?.status === 'ready' && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>
            {outline.file} · {outline.lines} lines · {outline.entries.length} components ·{' '}
            <Text color="yellow">{outline.entries.filter(entry => entry.isChanged).length} changed</Text>
          </Text>
          {outline.entries.length === 0 && <Text dimColor>No functions or classes found.</Text>}
          {outline.entries.map((entry, index) => {
            const size = entry.endLine - entry.line + 1
            const fill = Math.max(1, Math.round((size / longest) * barWidth))
            return (
              <Box key={`oe-${index}`} flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Text>{'  '.repeat(entry.depth)}</Text>
                  <Text color={entry.isChanged ? 'yellow' : entry.kind === 'class' ? 'magenta' : 'cyan'}>{KIND_ICON[entry.kind]}</Text>
                  {entry.kind === 'class' ? (
                    <Text bold color={entry.isChanged ? 'yellow' : undefined}>
                      {entry.name}
                    </Text>
                  ) : (
                    <Button key={`oc:${index}`} label={entry.name} plain onPress={() => void loadCalls($, entry.name)} />
                  )}
                  <Text dimColor>
                    L{entry.line}-{entry.endLine}
                  </Text>
                  <Text color={entry.isChanged ? 'yellow' : 'gray'}>{'▇'.repeat(fill)}</Text>
                  <Text dimColor>{size}</Text>
                  {entry.isChanged && <Text color="yellow">● changed</Text>}
                </Box>
                {entry.calls.length > 0 && (
                  <Text dimColor wrap="truncate-end">
                    {'  '.repeat(entry.depth + 2)}→ {entry.calls.join(', ')}
                  </Text>
                )}
              </Box>
            )
          })}
        </Box>
      )}
    </Box>
  )
}

function siteRow($: EngineInterface, t: T, site: Site, key: string, arrow: string): RenderNode {
  const { Box, Text, Button } = t
  return (
    <Box key={`row-${key}`} flexDirection="row" gap={1}>
      <Text dimColor>{arrow}</Text>
      {site.isKnown ? (
        <Button key={key} label={site.symbol} plain onPress={() => void loadCalls($, site.symbol)} />
      ) : (
        <Text dimColor>{site.symbol}</Text>
      )}
      <Text dimColor wrap="truncate-end">
        {site.file === '' ? '(outside the repo)' : filePath(site.file, site.line)}
      </Text>
    </Box>
  )
}

function callsView($: EngineInterface, t: T, call: CallView | null, trail: readonly string[], ask: RenderNode | null): RenderNode {
  const { Box, Text, Button } = t
  const previous = call === null ? undefined : trail[trail.indexOf(call.symbol) - 1]

  return (
    <Box flexDirection="column">
      {ask}
      <Box flexDirection="row" gap={1}>
        <Button
          key="from-selection"
          label="use my selection"
          hotkey="s"
          onPress={async () => {
            const selected = await $.ui.selection()
            const symbol = selected === undefined ? null : symbolFromSelection(selected.text)
            if (symbol === null) $.ui.toast('Codebase Atlas: select a function name in the transcript first.')
            else await loadCalls($, symbol)
          }}
        />
        {previous !== undefined && <Button key="back" label={`back to ${previous}`} hotkey="b" onPress={() => void loadCalls($, previous, true)} />}
      </Box>
      {call === null && <Text dimColor>Type a function name, or select one in the transcript and press "use my selection".</Text>}
      {call?.status === 'loading' && <Text color="cyan">Tracing {call.symbol}…</Text>}
      {(call?.status === 'error' || call?.status === 'missing') && (
        <Text color="red">{call.status === 'missing' ? `No definition or calls of ${call.symbol} found in source files.` : call.error}</Text>
      )}
      {call?.status === 'ready' && (
        <Box flexDirection="column" marginTop={1}>
          {trail.length > 1 && (
            <Text dimColor wrap="truncate-start">
              {trail.join(' › ')}
            </Text>
          )}
          <Box flexDirection="row" gap={1}>
            <Text bold color="cyan">
              ƒ {call.symbol}
            </Text>
            <Text dimColor>{call.definition === undefined ? 'definition not found' : filePath(call.definition.file, call.definition.line)}</Text>
          </Box>
          <Text bold color="magenta">
            ▲ Called by ({call.callers.length})
          </Text>
          {call.callers.length === 0 && <Text dimColor>{'   no callers found: an entry point, or only called dynamically'}</Text>}
          {call.callers.map((site, index) => siteRow($, t, site, `caller:${index}`, '   ├'))}
          <Text bold color="green">
            ▼ Calls ({call.callees.filter(site => site.isKnown).length} in the repo)
          </Text>
          {call.callees.length === 0 && <Text dimColor>{'   calls nothing'}</Text>}
          {call.callees.map((site, index) => siteRow($, t, site, `callee:${index}`, '   ├'))}
          <Box marginTop={1}>
            <Button key="explain-function" label="explain this function" hotkey="e" onPress={() => void explainFunction($, call)} />
          </Box>
        </Box>
      )}
    </Box>
  )
}

function decisionsView($: EngineInterface, t: T, decisions: readonly Decision[], isExtracting: boolean, isAuto: boolean): RenderNode {
  const { Box, Text } = t
  return (
    <Box flexDirection="column">
      <Text dimColor>
        {isAuto ? 'Decisions are pulled out after each turn that edits code or answers at length.' : 'Automatic extraction is off (extractDecisions in /config).'}
        {isExtracting ? '  Reading the last turn…' : ''}
      </Text>
      {decisions.length === 0 && <Text dimColor>No decisions recorded yet.</Text>}
      {[...decisions].reverse().map((decision, index) => (
        <Box key={`dec-${decision.id}`} flexDirection="row" marginTop={1}>
          <Box flexDirection="column" width={2} flexShrink={0}>
            <Text color="magenta">●</Text>
            {index < decisions.length - 1 && <Text color="magenta">│</Text>}
          </Box>
          <Box flexDirection="column" flexShrink={1}>
            <Text bold>{decision.decision}</Text>
            {decision.because !== '' && <Text>because {decision.because}</Text>}
            {decision.alternatives.length > 0 && <Text dimColor>instead of: {decision.alternatives.join(' · ')}</Text>}
            <Text dimColor wrap="truncate-end">
              from “{decision.prompt}”
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}

function explainView(t: T, insight: Insight | null): RenderNode {
  const { Box, Text, Markdown } = t
  if (insight === null) {
    return <Text dimColor>Use an "explain" button in Map, Changes or Calls. Answers appear here and never enter your conversation.</Text>
  }
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        {insight.title}
      </Text>
      {insight.status === 'loading' && <Text color="cyan">Thinking it through…</Text>}
      {insight.status === 'error' && <Text color="red">{insight.text}</Text>}
      {insight.status === 'ready' && <Markdown key="insight" text={insight.text} />}
    </Box>
  )
}

async function openTab($: EngineInterface, args: string): Promise<void> {
  const [word = '', ...rest] = args.trim().split(/\s+/)
  const value = rest.join(' ')
  if (word === 'rescan') {
    await update($, tabAtom, () => 'map')
    await scan($)
  } else if (word === 'changes') {
    await update($, tabAtom, () => 'changes')
    await refreshChanges($)
  } else if ((word === 'components' || word === 'file') && value !== '') {
    await loadOutline($, value)
  } else if (word === 'calls' && value !== '') {
    await loadCalls($, value)
  } else if (TABS.some(one => one.tab === word)) {
    await update($, tabAtom, () => word as Tab)
  }
}

export const register: Register = (on, options) => {
  const isAutoDecisions = options.extractDecisions !== false
  let request = ''
  const editedThisTurn = new Set<string>()
  let hasNewFile = false

  on('session.start', async ($, e, next) => {
    setCwd(e.cwd)
    await $.command.register({
      name: 'atlas',
      description: 'Codebase Atlas: architecture map, changes by function, components, call graph, decisions',
      argumentHint: '[map|changes|components <file>|calls <name>|decisions|explain|rescan]',
      immediate: true,
    })
    $.clock.after(1500, () => void scan($).catch(() => undefined))

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    try {
      const tool = String(e.tool)
      if (ran.deny !== undefined || ran.isError === true || (!READ_TOOLS.has(tool) && !EDIT_TOOLS.has(tool))) return ran
      const input = e as unknown as { file_path?: unknown; notebook_path?: unknown; type?: unknown }
      const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null
      if (path === null) return ran
      const isEdit = EDIT_TOOLS.has(tool)
      await recordActivity($, path, isEdit ? 'edit' : 'read')
      if (isEdit) {
        editedThisTurn.add(path)
        if (tool === 'Write' && (ran.result as { type?: unknown } | undefined)?.type === 'create') hasNewFile = true
      }
    } catch {
      // Tracking is best effort: the tool's own result always goes back unchanged.
    }
    return ran
  })

  on('turn.start', async ($, e, next) => {
    request = e.text
    editedThisTurn.clear()
    hasNewFile = false

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || e.isAborted) return ran

    const edited = [...editedThisTurn]
    const isNewFile = hasNewFile
    if (edited.length > 0) {
      $.clock.after(300, () => {
        void (async () => {
          if (isNewFile) await scan($)
          await refreshChanges($)
        })().catch(() => undefined)
      })
    }
    if (isAutoDecisions && (edited.length > 0 || e.answer.length > LONG_ANSWER)) {
      const turnRequest = request
      const answer = e.answer
      $.clock.after(0, () => void extractDecisions($, turnRequest, answer, edited).catch(() => undefined))
    }
    return ran
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, activityAtom, () => [])
      await update($, decisionsAtom, () => [])
      await update($, changesAtom, (): ChangeMap => ({ status: 'idle', files: [], layers: [], dependents: [] }))
    }
    return next(e)
  })

  on('command.run', { command: 'atlas' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: TITLE })
    await openTab($, e.args)

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const t: T = table
    const { Box, Text, Button } = t
    const tab = await read($, tabAtom)
    const status = await read($, scanStatusAtom)
    const graph = await read($, graphAtom)
    const activity = await read($, activityAtom)
    const root = graph?.root ?? ''

    const ask =
      'Input' in table ? (
        <table.Input
          key="symbol"
          label="Function"
          placeholder="name of a function or class"
          submitLabel="trace"
          onSubmit={value => void loadCalls($, value)}
        />
      ) : null

    let body: RenderNode
    if (tab === 'map') {
      body =
        status === 'scanning' ? <Text color="cyan">Scanning the repository…</Text>
        : status === 'no-folder' ? <Text color="red">Codebase Atlas could not tell which folder to read. Start Claude Code inside your project.</Text>
        : status === 'error' ? <Text color="red">Scan failed: {await read($, scanErrorAtom)}</Text>
        : graph === null ? <Text dimColor>Starting the first scan…</Text>
        : mapView($, t, graph, activity, await read($, focusAtom))
    } else if (tab === 'changes') {
      body = changesView($, t, await read($, changesAtom), graph?.isGit ?? true)
    } else if (tab === 'components') {
      const recent = [...new Set([...(await read($, changesAtom)).files.map(file => file.path), ...activity.map(one => relative(one.path, root))])]
      body = componentsView($, t, await read($, outlineAtom), recent, e.props.bodyColumns)
    } else if (tab === 'calls') {
      body = callsView($, t, await read($, callAtom), await read($, trailAtom), ask)
    } else if (tab === 'decisions') {
      body = decisionsView($, t, await read($, decisionsAtom), await read($, isExtractingAtom), isAutoDecisions)
    } else {
      body = explainView(t, await read($, insightAtom))
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {TABS.map(one => (
            <Button
              key={`tab:${one.tab}`}
              label={one.label}
              hotkey={one.key}
              variant={one.tab === tab ? 'primary' : 'secondary'}
              onPress={async () => {
                await update($, tabAtom, () => one.tab)
                if (one.tab === 'changes' && (await read($, changesAtom)).status === 'idle') await refreshChanges($)
              }}
            />
          ))}
          <Button key="rescan" label="rescan" hotkey="x" onPress={() => void scan($)} />
        </Box>
        <Box marginTop={1} flexDirection="column">
          {body}
        </Box>
      </Box>
    )
  })
}
