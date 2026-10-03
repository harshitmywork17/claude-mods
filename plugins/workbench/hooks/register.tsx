import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, RenderNode, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type {
  Artifact,
  CallView,
  EditHunk,
  EditRecord,
  FileSummary,
  Graph,
  Limit,
  Outline,
  Preview,
  Reading,
  Site,
  Step,
  Tab,
  Turn,
} from '../types'
import { bodyOf, calleesIn, enclosingSymbol, isDefinitionLine, symbolFromSelection } from './calls'
import { escapeRegex, lineDiff, markChanged, outlineOf, symbolChanges } from './changes'
import type { Range } from './changes'
import { HISTORY_LENGTH, kilo, outlook, sky, sparkline } from './forecast'
import { KIND_ICON, KIND_LABEL, ago, artifactKind, bytes, htmlOutline, jsonTree, parseCsv, parseJson, previewKind } from './files'
import { duration, meter, sortLimits, viewOf } from './limits'
import {
  IMPORT_PATTERN,
  IMPORT_RE,
  SKIPPED_DIRS,
  SOURCE_GLOBS,
  SYMBOL_PATTERN,
  SYMBOL_RE,
  buildScan,
  countTexts,
  grepLine,
  grepMatches,
  grepTexts,
  groupOf,
  isSource,
  shortCount,
} from './scan'
import type { Scan } from './scan'
import { fit, sideBySide } from './sidebyside'
import { BADGE, MAX_TURNS, bar, colorOf, modelTime, onNewest, preview, relabel, seconds, statusOf, summarize, withStep, withStepChange } from './trace'

// ── State ───────────────────────────────────────────────────────────────

const tabAtom = atom({ plugin: 'workbench', key: 'tab' } as const, 'now')
const hudHiddenAtom = atom({ plugin: 'workbench', key: 'isHudHidden' } as const, false)
const startedAtAtom = atom({ plugin: 'workbench', key: 'startedAt' } as const, 0)
const turnsAtom = atom({ plugin: 'workbench', key: 'turns' } as const, [])
const turnBackAtom = atom({ plugin: 'workbench', key: 'turnBack' } as const, 0)
const showOutputsAtom = atom({ plugin: 'workbench', key: 'showOutputs' } as const, false)
const editsAtom = atom({ plugin: 'workbench', key: 'edits' } as const, [])
const changeFileAtom = atom({ plugin: 'workbench', key: 'changeFile' } as const, null)
const changeEditAtom = atom({ plugin: 'workbench', key: 'changeEdit' } as const, null)
const fileSummaryAtom = atom({ plugin: 'workbench', key: 'fileSummary' } as const, null)
const previewAtom = atom({ plugin: 'workbench', key: 'preview' } as const, null)
const followAtom = atom({ plugin: 'workbench', key: 'isFollowing' } as const, true)
const artifactsAtom = atom({ plugin: 'workbench', key: 'artifacts' } as const, [])
const graphAtom = atom({ plugin: 'workbench', key: 'graph' } as const, null)
const scanStatusAtom = atom({ plugin: 'workbench', key: 'scanStatus' } as const, 'idle')
const scanErrorAtom = atom({ plugin: 'workbench', key: 'scanError' } as const, '')
const mapViewAtom = atom({ plugin: 'workbench', key: 'mapView' } as const, 'map')
const mapFocusAtom = atom({ plugin: 'workbench', key: 'mapFocus' } as const, null)
const outlineAtom = atom({ plugin: 'workbench', key: 'outline' } as const, null)
const callAtom = atom({ plugin: 'workbench', key: 'call' } as const, null)
const trailAtom = atom({ plugin: 'workbench', key: 'trail' } as const, [])
const limitsAtom = atom({ plugin: 'workbench', key: 'limits' } as const, [])
const readingAtom = atom({ plugin: 'workbench', key: 'reading' } as const, null)
const historyAtom = atom({ plugin: 'workbench', key: 'history' } as const, [])
const costAtom = atom({ plugin: 'workbench', key: 'costUsd' } as const, null)

const PANE = 'workbench'
const TITLE = 'Workbench'
const MAX_EDITS = 300
const MAX_HUNK_LINES = 400
const MAX_DIFF_ROWS = 220
const MAX_PREVIEW_CHARS = 200_000
const MAX_CODE_CHARS = 9000
const MAX_MARKDOWN_CHARS = 30_000
const MAX_CSV_ROWS = 40
const MAX_ARTIFACTS = 200
const MAX_WALK_FILES = 5000
const MAX_WALK_DIRS = 3000
const MAX_FOLDER_FILES = 1500
const MAX_FILE_BYTES = 512 * 1024
const MAX_CALLERS = 40
const GIT_TIMEOUT_MS = 20_000
const SCREENSHOT_TIMEOUT_MS = 30_000
const BROWSERS = [
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'msedge',
]

type Source = { root: string; isGit: boolean }
type ListedFile = { path: string; size: number; mtimeMs: number }

let cwd = ''
let source: Source | null = null
let cache: Scan | null = null
let isScanning = false
/** Folder mode: each source file's text and modification time as last read. */
const current = new Map<string, { text: string; mtimeMs: number }>()
/** Each file as it was before Claude first touched it this session; null for a file Claude created. */
const editBaselines = new Map<string, string | null>()
/** Every file in the folder when the session began: what Artifacts compares against. */
let startListing: Set<string> | null = null
const claudeCreated = new Set<string>()
/** The browser used for HTML screenshots: undefined until looked for, null when none was found. */
let browser: string | null | undefined
let isBusy = false
let turnCostStart: number | null = null
let previewGeneration = 0

// ── Files and folders ───────────────────────────────────────────────────

type GitResult = { isOk: boolean; out: string; err: string }

async function git($: EngineInterface, root: string, args: readonly string[]): Promise<GitResult> {
  const run = await $.process.run(['git', '-C', root, ...args], { timeoutMs: GIT_TIMEOUT_MS })
  const isEmptyGrep = args[0] === 'grep' && run.exitCode === 1 && run.stderr.trim() === ''
  return { isOk: run.exitCode === 0 || isEmptyGrep, out: run.stdout, err: run.stderr.trim() }
}

/** The folder Workbench reads: the git repository around the session, or else the session's own folder. */
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

function relative(path: string, root: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
}

function absolute(path: string, root: string): string {
  return path.startsWith('/') ? path : `${root}/${path}`
}

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

async function rootOf($: EngineInterface): Promise<string> {
  return (await findSource($))?.root ?? cwd
}

/** Every file under the root, leaving out dependencies, environments, caches, build output and hidden folders. */
async function walk($: EngineInterface, root: string, isWanted: (name: string, size: number) => boolean, maxFiles: number): Promise<ListedFile[]> {
  const found: ListedFile[] = []
  const queue = ['']
  let dirs = 0
  while (queue.length > 0 && found.length < maxFiles && dirs < MAX_WALK_DIRS) {
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
      else if (entry.kind === 'file' && isWanted(entry.name, entry.size)) found.push({ path, size: entry.size, mtimeMs: entry.mtimeMs })
    }
  }
  return found.slice(0, maxFiles)
}

// ── Code Map: scanning, components and calls ───────────────────────────

async function syncFolder($: EngineInterface, root: string): Promise<void> {
  const listed = await walk($, root, (name, size) => isSource(name) && size <= MAX_FILE_BYTES, MAX_FOLDER_FILES)
  const seen = new Set<string>()
  for (const file of listed) {
    seen.add(file.path)
    if (current.get(file.path)?.mtimeMs === file.mtimeMs) continue
    current.set(file.path, { text: await readText($, `${root}/${file.path}`), mtimeMs: file.mtimeMs })
  }
  for (const path of [...current.keys()]) if (!seen.has(path)) current.delete(path)
}

function currentTexts(): Map<string, string> {
  return new Map([...current].map(([path, file]) => [path, file.text]))
}

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
      const texts = currentTexts()
      cache = buildScan(src.root, [...texts.keys()].join('\n'), countTexts(texts), grepTexts(texts, IMPORT_RE), grepTexts(texts, SYMBOL_RE), false)
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

async function searchSources($: EngineInterface, src: Source, gitPattern: string, jsPattern: RegExp): Promise<string> {
  if (src.isGit) return (await git($, src.root, ['grep', '-n', '-I', '-E', gitPattern, '--', ...SOURCE_GLOBS])).out
  return grepTexts(currentTexts(), jsPattern)
}

/** Lines changed this session in a file, from the text it had before Claude first touched it. */
function sessionRanges(path: string, text: string): Range[] {
  if (!editBaselines.has(path)) return []
  return lineDiff(path, editBaselines.get(path) ?? null, text).ranges
}

async function loadOutline($: EngineInterface, path: string): Promise<void> {
  await update($, outlineAtom, (): Outline => ({ file: path, status: 'loading', lines: 0, entries: [] }))
  await update($, tabAtom, (): Tab => 'map')
  await update($, mapViewAtom, () => 'components')
  try {
    const root = await rootOf($)
    const scanned = await ensureScan($)
    const text = await readText($, absolute(path, root))
    if (text === '') throw new Error(`Could not read ${path}.`)
    const entries = markChanged(outlineOf(text, path), sessionRanges(path, text)).map(entry => ({
      ...entry,
      calls:
        entry.kind === 'class'
          ? []
          : calleesIn(bodyOf(text, entry.line, path), entry.name, scanned?.symbols ?? new Map())
              .filter(site => site.isKnown)
              .map(site => site.symbol)
              .slice(0, 8),
    }))
    await update($, outlineAtom, (): Outline => ({ file: path, status: 'ready', lines: lineTotal(text), entries }))
  } catch (error) {
    await update($, outlineAtom, (): Outline => ({ file: path, status: 'error', lines: 0, entries: [], error: String(error) }))
  }
}

async function loadCalls($: EngineInterface, symbol: string, isFromTrail = false): Promise<void> {
  const name = symbol.trim()
  await update($, tabAtom, (): Tab => 'map')
  await update($, mapViewAtom, () => 'calls')
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
    await update($, callAtom, (): CallView => ({ symbol: name, status: 'error', callers: [], callees: [], error: 'Type one function or class name.' }))
    return
  }
  await update($, callAtom, (): CallView => ({ symbol: name, status: 'loading', callers: [], callees: [] }))
  if (!isFromTrail) await update($, trailAtom, trail => [...trail.filter(one => one !== name), name].slice(-20))
  try {
    const src = await findSource($)
    if (src === null) throw new Error('Workbench could not tell which folder to read.')
    const scanned = await ensureScan($)
    const index = scanned?.symbols ?? new Map<string, Site[]>()
    const definition = index.get(name)?.[0]
    const texts = new Map<string, string>()
    const textOf = async (file: string): Promise<string> => {
      if (!texts.has(file)) texts.set(file, current.get(file)?.text ?? (await readText($, `${src.root}/${file}`)))
      return texts.get(file) ?? ''
    }
    const escaped = escapeRegex(name)
    const hits = await searchSources($, src, `(^|[^A-Za-z0-9_$])${escaped}[[:space:]]*\\(`, new RegExp(`(^|[^A-Za-z0-9_$])${escaped}\\s*\\(`))
    const callers: Site[] = []
    const seen = new Set<string>()
    for (const row of hits.split('\n')) {
      const hit = grepLine(row)
      if (hit === null || isDefinitionLine(hit.text, name)) continue
      const caller = enclosingSymbol(await textOf(hit.file), hit.line, hit.file)
      if (seen.has(`${caller}@${hit.file}`)) continue
      seen.add(`${caller}@${hit.file}`)
      callers.push({ symbol: caller, file: hit.file, line: hit.line, isKnown: index.has(caller) })
      if (callers.length >= MAX_CALLERS) break
    }
    const callees = definition === undefined ? [] : calleesIn(bodyOf(await textOf(definition.file), definition.line, definition.file), name, index)
    const view: CallView = { symbol: name, status: definition === undefined && callers.length === 0 ? 'missing' : 'ready', definition, callers, callees }
    await update($, callAtom, () => view)
  } catch (error) {
    await update($, callAtom, (): CallView => ({ symbol: name, status: 'error', callers: [], callees: [], error: String(error) }))
  }
}

// ── Changes: recording edits ────────────────────────────────────────────

type FileResult = {
  filePath?: string
  structuredPatch?: readonly EditHunk[]
  originalFile?: string | null
  content?: string
  type?: 'create' | 'update'
  staged?: boolean
}

function hunksOf(result: FileResult): { hunks: EditHunk[]; isCut: boolean } {
  let hunks: EditHunk[] = (result.structuredPatch ?? []).map(hunk => ({ ...hunk, lines: [...hunk.lines] }))
  if (hunks.length === 0 && result.type === 'create' && result.content !== undefined) {
    const lines = result.content.replace(/\n$/, '').split('\n')
    hunks = [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map(line => `+${line}`) }]
  }
  let budget = MAX_HUNK_LINES
  let isCut = false
  const kept: EditHunk[] = []
  for (const hunk of hunks) {
    if (budget <= 0) {
      isCut = true
      break
    }
    const lines = hunk.lines.slice(0, budget).map(line => (line.length > 400 ? `${line.slice(0, 400)}…` : line))
    if (lines.length < hunk.lines.length) isCut = true
    budget -= lines.length
    kept.push({ ...hunk, lines })
  }
  return { hunks: kept, isCut }
}

async function recordEdit($: EngineInterface, tool: string, input: Record<string, unknown>, result: FileResult, turnId: string): Promise<EditRecord | null> {
  if (result.staged === true) return null
  const root = await rootOf($)
  const abs = typeof result.filePath === 'string' ? result.filePath : typeof input.file_path === 'string' ? input.file_path : null
  if (abs === null) return null
  const file = relative(abs, root)
  const isCreate = result.type === 'create'
  if (!editBaselines.has(file)) editBaselines.set(file, isCreate ? null : (result.originalFile ?? null))
  if (isCreate) claudeCreated.add(file)

  const { hunks, isCut } = hunksOf(result)
  const lines = hunks.flatMap(hunk => hunk.lines)
  const text = await readText($, abs)
  const ranges: Range[] = hunks.map(hunk => [Math.max(1, hunk.newStart), Math.max(1, hunk.newStart + Math.max(hunk.newLines, 1) - 1)])
  const symbols = markChanged(outlineOf(text, file), ranges)
    .filter(entry => entry.isChanged)
    .map(entry => entry.name)
  const record: EditRecord = {
    id: `${tool}-${await $.clock.now()}-${Math.random().toString(36).slice(2, 7)}`,
    turnId,
    file,
    kind: tool === 'Write' ? (isCreate ? 'create' : 'overwrite') : 'edit',
    hunks,
    added: lines.filter(line => line.startsWith('+')).length,
    removed: lines.filter(line => line.startsWith('-')).length,
    symbols: [...new Set(symbols)],
    at: await $.clock.now(),
    isCut,
  }
  await update($, editsAtom, list => [...list, record].slice(-MAX_EDITS))
  return record
}

async function loadFileSummary($: EngineInterface, file: string): Promise<void> {
  await update($, fileSummaryAtom, (): FileSummary => ({ file, status: 'loading', symbols: [], added: 0, removed: 0 }))
  try {
    const root = await rootOf($)
    const after = await readText($, absolute(file, root))
    const before = editBaselines.has(file) ? (editBaselines.get(file) ?? null) : after
    const diff = lineDiff(file, before, after === '' && before !== null ? null : after)
    const symbols = symbolChanges(outlineOf(after, file), outlineOf(before ?? '', file), diff.ranges)
    await update($, fileSummaryAtom, (): FileSummary => ({ file, status: 'ready', symbols, added: diff.added, removed: diff.removed }))
  } catch (error) {
    await update($, fileSummaryAtom, (): FileSummary => ({ file, status: 'error', symbols: [], added: 0, removed: 0, error: String(error) }))
  }
}

async function openFile($: EngineInterface, file: string): Promise<void> {
  await update($, tabAtom, (): Tab => 'changes')
  await update($, changeFileAtom, () => file)
  await update($, changeEditAtom, () => null)
  await loadFileSummary($, file)
}

// ── Preview ─────────────────────────────────────────────────────────────

function hashOf(text: string): string {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0
  return hash.toString(36)
}

async function findBrowser($: EngineInterface): Promise<string | null> {
  if (browser !== undefined) return browser
  for (const candidate of BROWSERS) {
    try {
      const run = await $.process.run([candidate, '--version'], { timeoutMs: 5000 })
      if (run.exitCode === 0) {
        browser = candidate
        return browser
      }
    } catch {
      // Not installed under this name; try the next.
    }
  }
  browser = null
  return browser
}

/** Renders an HTML file to a PNG with a headless browser; null when no browser is available or it fails. */
async function screenshot($: EngineInterface, abs: string): Promise<string | null> {
  const binary = await findBrowser($)
  if (binary === null) return null
  const out = `/tmp/workbench-preview-${hashOf(abs)}.png`
  try {
    const run = await $.process.run(
      [binary, '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--window-size=1280,800', `--screenshot=${out}`, `file://${abs}`],
      { timeoutMs: SCREENSHOT_TIMEOUT_MS },
    )
    return run.exitCode === 0 ? out : null
  } catch {
    return null
  }
}

async function openPreview($: EngineInterface, file: string, isFocus = true): Promise<void> {
  previewGeneration += 1
  const generation = previewGeneration
  const kind = previewKind(file)
  await update($, previewAtom, (): Preview => ({ path: file, kind, status: 'loading', text: '', size: 0, generation }))
  if (isFocus) await update($, tabAtom, (): Tab => 'preview')
  try {
    const root = await rootOf($)
    const abs = absolute(file, root)
    const stat = await $.fs.stat(abs)
    let next: Preview = { path: file, kind, status: 'ready', text: '', size: stat.size, generation }
    if (kind === 'image') {
      next = abs.toLowerCase().endsWith('.png') ? { ...next, image: abs } : { ...next, note: 'Only PNG images draw in the terminal; open the file to see it.' }
    } else if (kind === 'html') {
      const text = (await readText($, abs)).slice(0, MAX_PREVIEW_CHARS)
      const shot = await screenshot($, abs)
      next = { ...next, text, image: shot ?? undefined, note: shot === null ? 'No headless Chrome or Chromium found: showing the page outline.' : undefined }
    } else {
      next = { ...next, text: (await readText($, abs)).slice(0, MAX_PREVIEW_CHARS) }
    }
    if (generation === previewGeneration) await update($, previewAtom, () => next)
  } catch (error) {
    if (generation === previewGeneration) {
      await update($, previewAtom, (): Preview => ({ path: file, kind, status: 'error', text: String(error), size: 0, generation }))
    }
  }
}

// ── Artifacts ───────────────────────────────────────────────────────────

async function snapshotFolder($: EngineInterface): Promise<void> {
  const root = await rootOf($)
  if (root === '') return
  startListing = new Set((await walk($, root, () => true, MAX_WALK_FILES)).map(file => file.path))
}

async function refreshArtifacts($: EngineInterface): Promise<void> {
  const root = await rootOf($)
  if (root === '') return
  const listed = await walk($, root, () => true, MAX_WALK_FILES)
  if (startListing === null) {
    startListing = new Set(listed.map(file => file.path).filter(path => !claudeCreated.has(path)))
  }
  const before = startListing
  const made: Artifact[] = listed
    .filter(file => !before.has(file.path) || claudeCreated.has(file.path))
    .map(file => ({ path: file.path, kind: artifactKind(file.path), size: file.size, mtimeMs: file.mtimeMs, isByClaude: claudeCreated.has(file.path) }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_ARTIFACTS)
  await update($, artifactsAtom, () => made)
}

// ── Usage ───────────────────────────────────────────────────────────────

function toReading(context: SessionContextUsage): Reading | null {
  if (context.percent === undefined) return null
  return { percent: context.percent, tokens: context.tokens ?? 0, window: context.window }
}

function toLimits(windows: readonly SessionRateLimit[]): Limit[] {
  return sortLimits(windows.map(window => ({ kind: window.kind, percentUsed: window.percentUsed, resetsAt: window.resetsAt })))
}

// ── Views ───────────────────────────────────────────────────────────────

type T = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Markdown' | 'Code'>

const TABS: { tab: Tab; label: string; key: string }[] = [
  { tab: 'now', label: 'Now', key: '1' },
  { tab: 'changes', label: 'Changes', key: '2' },
  { tab: 'preview', label: 'Preview', key: '3' },
  { tab: 'artifacts', label: 'Artifacts', key: '4' },
  { tab: 'map', label: 'Code Map', key: '5' },
  { tab: 'usage', label: 'Usage', key: '6' },
]

const C = { ok: 'green', bad: 'red', warn: 'yellow', live: 'cyan', accent: 'magenta' } as const
const CHANGE_MARK = { added: ['+', 'green'], modified: ['~', 'yellow'], removed: ['−', 'red'] } as const
const KIND_ICON_CODE = { class: '◆', function: 'ƒ', method: '·' } as const

function heading(t: T, title: string, detail?: string): RenderNode {
  const { Box, Text } = t
  return (
    <Box flexDirection="row" gap={1}>
      <Text bold color={C.accent}>
        ▌{title}
      </Text>
      {detail !== undefined && <Text dimColor>{detail}</Text>}
    </Box>
  )
}

function empty(t: T, text: string): RenderNode {
  const { Box, Text } = t
  return (
    <Box marginTop={1}>
      <Text dimColor>{text}</Text>
    </Box>
  )
}

function nowView($: EngineInterface, t: T, turns: readonly Turn[], back: number, showOutputs: boolean, now: number, columns: number): RenderNode {
  const { Box, Button, Text } = t
  const offset = Math.min(back, Math.max(0, turns.length - 1))
  const turn = turns[turns.length - 1 - offset]
  if (turn === undefined) return empty(t, 'Waiting for the next turn. Each tool call, its output, subagents and timings show here live.')

  const total = (turn.endedAt ?? now) - turn.startedAt
  const barWidth = Math.max(10, Math.floor(columns * 0.3))
  const summaryWidth = Math.max(8, columns - barWidth - 26)
  const failed = turn.steps.filter(step => step.status === 'error' || step.status === 'denied').length
  const status = { running: ['● running', C.live], done: ['✓ done', C.ok], interrupted: ['⊘ interrupted', C.warn], failed: ['✗ failed', C.bad] } as const

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text bold color={status[turn.status][1]}>
          {status[turn.status][0]}
        </Text>
        <Text dimColor>
          turn {turns.length - offset}/{turns.length} · {seconds(total)} · {turn.steps.length} tools{failed > 0 ? ` · ${failed} failed` : ''} · model{' '}
          {seconds(modelTime(turn, now))}
        </Text>
      </Box>
      <Text wrap="truncate-end">“{turn.prompt}”</Text>
      {turn.lanes.map(lane => {
        const steps = turn.steps.filter(step => step.lane === lane.id)
        if (steps.length === 0 && lane.id !== 'main') return null
        return (
          <Box key={`lane-${lane.id}`} flexDirection="column" marginTop={1}>
            <Text bold color={lane.id === 'main' ? undefined : C.accent} wrap="truncate-end">
              {lane.id === 'main' ? '▌Main' : `▌⑂ ${lane.label}`}
            </Text>
            {steps.length === 0 && <Text dimColor> no tool calls yet</Text>}
            {steps.map(step => {
              const color = colorOf(step, now)
              const { pad, fill } = bar(step, turn, now, barWidth)
              return (
                <Box key={`step-${step.id}`} flexDirection="column">
                  <Box flexDirection="row">
                    <Box width={3} flexShrink={0}>
                      <Text color={color}> {BADGE[step.status]}</Text>
                    </Box>
                    <Box width={11} flexShrink={0}>
                      <Text bold wrap="truncate-end">
                        {step.tool}
                      </Text>
                    </Box>
                    <Box width={summaryWidth} flexShrink={1}>
                      <Text dimColor wrap="truncate-end">
                        {step.summary}
                      </Text>
                    </Box>
                    <Box width={barWidth} flexShrink={0}>
                      <Text>{pad}</Text>
                      <Text color={color}>{fill}</Text>
                    </Box>
                    <Box width={8} flexShrink={0} justifyContent="flex-end">
                      <Text color={color}>{seconds((step.endedAt ?? now) - step.startedAt)}</Text>
                    </Box>
                  </Box>
                  {step.agent !== undefined && (
                    <Text color={C.accent}>
                      {'    '}⑂ {step.agent.type}
                      {step.agent.toolCount === undefined ? '' : ` · ${step.agent.toolCount} tools`}
                      {step.agent.tokens === undefined ? '' : ` · ${kilo(step.agent.tokens)} tokens`}
                    </Text>
                  )}
                  {showOutputs && step.output !== '' && (
                    <Text dimColor wrap="truncate-end">
                      {'    ↳ '}
                      {step.output.replace(/\n/g, ' ⏎ ')}
                    </Text>
                  )}
                </Box>
              )
            })}
          </Box>
        )
      })}
      <Box flexDirection="row" gap={1} marginTop={1}>
        <Button key="now-outputs" label={showOutputs ? 'hide outputs' : 'show outputs'} hotkey="v" onPress={() => update($, showOutputsAtom, value => !value)} />
        {offset < turns.length - 1 && <Button key="now-older" label="older turn" hotkey="o" onPress={() => update($, turnBackAtom, n => n + 1)} />}
        {offset > 0 && <Button key="now-newer" label="newer turn" hotkey="w" onPress={() => update($, turnBackAtom, n => n - 1)} />}
      </Box>
    </Box>
  )
}

function diffView($: EngineInterface, t: T, edits: readonly EditRecord[], edit: EditRecord, turns: readonly Turn[], columns: number): RenderNode {
  const { Box, Button, Text } = t
  const index = edits.findIndex(one => one.id === edit.id)
  const turn = turns.find(one => one.id === edit.turnId)
  const half = Math.max(20, Math.floor((columns - 3) / 2))
  const textWidth = Math.max(8, half - 7)
  const rows = sideBySide(edit.hunks)
  const shown = rows.slice(0, MAX_DIFF_ROWS)
  const go = async (to: number): Promise<void> => {
    const target = edits[to]
    if (target !== undefined) await update($, changeEditAtom, () => target.id)
  }

  const cell = (side: 'left' | 'right', value: { line: number; text: string; kind: ' ' | '-' | '+' } | undefined): RenderNode => {
    const color = value?.kind === '-' ? C.bad : value?.kind === '+' ? C.ok : undefined
    return (
      <Box width={half} flexShrink={0} flexDirection="row">
        <Box width={5} flexShrink={0} justifyContent="flex-end">
          <Text dimColor>{value === undefined ? '' : String(value.line)}</Text>
        </Box>
        <Box width={2} flexShrink={0}>
          <Text color={color}>{value === undefined || value.kind === ' ' ? ' ' : side === 'left' ? '-' : '+'}</Text>
        </Box>
        <Text color={color} dimColor={value?.kind === ' '}>
          {value === undefined ? '' : fit(value.text, textWidth)}
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text bold>{edit.file}</Text>
        <Text color={C.ok}>+{edit.added}</Text>
        <Text color={C.bad}>−{edit.removed}</Text>
        <Text dimColor>
          {edit.kind} · edit {index + 1} of {edits.length}
        </Text>
      </Box>
      <Text dimColor wrap="truncate-end">
        turn “{turn?.prompt ?? '?'}”{edit.symbols.length > 0 ? ` · touches ${edit.symbols.join(', ')}` : ''}
      </Text>
      <Box flexDirection="row" marginTop={1}>
        <Box width={half} flexShrink={0}>
          <Text bold color={C.bad}>
            {'      before'}
          </Text>
        </Box>
        <Text color="gray">│</Text>
        <Box width={half} flexShrink={0}>
          <Text bold color={C.ok}>
            {'      after'}
          </Text>
        </Box>
      </Box>
      {shown.map((row, rowIndex) =>
        row.isGap === true ? (
          <Text key={`gap-${rowIndex}`} dimColor>
            {'      ⋯'}
          </Text>
        ) : (
          <Box key={`row-${rowIndex}`} flexDirection="row">
            {cell('left', row.left)}
            <Text color="gray">│</Text>
            {cell('right', row.right)}
          </Box>
        ),
      )}
      {(rows.length > shown.length || edit.isCut) && <Text dimColor>… diff cut to fit</Text>}
      <Box flexDirection="row" gap={1} marginTop={1}>
        <Button key="diff-prev" label="◀ prev edit" hotkey="p" onPress={() => go(index - 1)} />
        <Button key="diff-next" label="next edit ▶" hotkey="n" variant="primary" onPress={() => go(index + 1)} />
        <Button key="diff-file" label="whole file" hotkey="f" onPress={() => openFile($, edit.file)} />
        <Button key="diff-preview" label="preview" hotkey="v" onPress={() => openPreview($, edit.file)} />
        <Button key="diff-back" label="back" hotkey="b" onPress={() => update($, changeEditAtom, () => null)} />
      </Box>
    </Box>
  )
}

function fileView($: EngineInterface, t: T, file: string, summary: FileSummary | null, edits: readonly EditRecord[], turns: readonly Turn[]): RenderNode {
  const { Box, Button, Text } = t
  const mine = edits.filter(edit => edit.file === file)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text bold>{file}</Text>
        {summary?.status === 'ready' && <Text color={C.ok}>+{summary.added}</Text>}
        {summary?.status === 'ready' && <Text color={C.bad}>−{summary.removed}</Text>}
        <Text dimColor>since Claude first touched it this session</Text>
      </Box>
      {summary?.status === 'loading' && <Text color={C.live}>Comparing…</Text>}
      {summary?.status === 'error' && <Text color={C.bad}>{summary.error}</Text>}
      <Box marginTop={1}>{heading(t, 'Functions changed')}</Box>
      {summary?.status === 'ready' && summary.symbols.length === 0 && <Text dimColor> no function-level change (imports, constants or top-level code)</Text>}
      {summary?.symbols.map((change, index) => (
        <Box key={`fs-${index}`} flexDirection="row" gap={1}>
          <Text color={CHANGE_MARK[change.change][1]}>
            {' '}
            {CHANGE_MARK[change.change][0]} {KIND_ICON_CODE[change.kind]}
          </Text>
          {change.change === 'removed' ? (
            <Text strikethrough dimColor>
              {change.name}
            </Text>
          ) : (
            <Button key={`fs-sym:${index}`} label={change.name} plain onPress={() => loadCalls($, change.name)} />
          )}
          <Text dimColor>
            {change.change} · L{change.line}
          </Text>
        </Box>
      ))}
      <Box marginTop={1}>{heading(t, 'Edits', `${mine.length}, oldest first`)}</Box>
      {mine.map((edit, index) => (
        <Box key={`fe-${edit.id}`} flexDirection="row" gap={1}>
          <Button key={`fe:${index}`} label={`#${index + 1}`} plain onPress={() => update($, changeEditAtom, () => edit.id)} />
          <Text color={C.ok}>+{edit.added}</Text>
          <Text color={C.bad}>−{edit.removed}</Text>
          <Text dimColor wrap="truncate-end">
            “{turns.find(turn => turn.id === edit.turnId)?.prompt ?? ''}”{edit.symbols.length > 0 ? ` · ${edit.symbols.join(', ')}` : ''}
          </Text>
        </Box>
      ))}
      <Box flexDirection="row" gap={1} marginTop={1}>
        <Button key="file-preview" label="preview" hotkey="v" onPress={() => openPreview($, file)} />
        <Button key="file-components" label="components" hotkey="m" onPress={() => loadOutline($, file)} />
        <Button key="file-back" label="back" hotkey="b" onPress={() => update($, changeFileAtom, () => null)} />
      </Box>
    </Box>
  )
}

function changesOverview($: EngineInterface, t: T, edits: readonly EditRecord[], turns: readonly Turn[]): RenderNode {
  const { Box, Button, Text } = t
  if (edits.length === 0) return empty(t, 'No edits yet this session. Every file Claude changes appears here, grouped by turn, down to the functions and a side-by-side diff.')
  const files = new Set(edits.map(edit => edit.file))
  const added = edits.reduce((sum, edit) => sum + edit.added, 0)
  const removed = edits.reduce((sum, edit) => sum + edit.removed, 0)
  const turnIds = [...new Set(edits.map(edit => edit.turnId))].reverse()

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text bold>
          {files.size} file{files.size === 1 ? '' : 's'}
        </Text>
        <Text color={C.ok}>+{added}</Text>
        <Text color={C.bad}>−{removed}</Text>
        <Text dimColor>
          · {edits.length} edits over {turnIds.length} turn{turnIds.length === 1 ? '' : 's'}
        </Text>
      </Box>
      {turnIds.map(turnId => {
        const inTurn = edits.filter(edit => edit.turnId === turnId)
        const byFile = [...new Set(inTurn.map(edit => edit.file))]
        const prompt = turns.find(turn => turn.id === turnId)?.prompt ?? 'earlier'
        return (
          <Box key={`ct-${turnId}`} flexDirection="column" marginTop={1}>
            {heading(t, `“${prompt.length > 70 ? `${prompt.slice(0, 70)}…` : prompt}”`, `${inTurn.length} edit${inTurn.length === 1 ? '' : 's'}`)}
            {byFile.map((file, index) => {
              const fileEdits = inTurn.filter(edit => edit.file === file)
              const symbols = [...new Set(fileEdits.flatMap(edit => edit.symbols))]
              const isNew = fileEdits.some(edit => edit.kind === 'create')
              return (
                <Box key={`cf-${turnId}-${index}`} flexDirection="row" gap={1}>
                  <Text> </Text>
                  <Button key={`cfile:${turnId}:${index}`} label={file} plain onPress={() => openFile($, file)} />
                  {isNew && <Text color={C.live}>new</Text>}
                  <Text color={C.ok}>+{fileEdits.reduce((sum, edit) => sum + edit.added, 0)}</Text>
                  <Text color={C.bad}>−{fileEdits.reduce((sum, edit) => sum + edit.removed, 0)}</Text>
                  {symbols.length > 0 && (
                    <Text color={C.warn} wrap="truncate-end">
                      ƒ {symbols.join(', ')}
                    </Text>
                  )}
                  <Button key={`cdiff:${turnId}:${index}`} label="diff" plain onPress={() => update($, changeEditAtom, () => fileEdits[0]?.id ?? null)} />
                </Box>
              )
            })}
          </Box>
        )
      })}
      <Box flexDirection="row" gap={1} marginTop={1}>
        <Button key="replay" label="replay from the start" hotkey="r" variant="primary" onPress={() => update($, changeEditAtom, () => edits[0]?.id ?? null)} />
      </Box>
    </Box>
  )
}

function csvTable(t: T, text: string, isTab: boolean, columns: number): RenderNode {
  const { Box, Text } = t
  const rows = parseCsv(text, MAX_CSV_ROWS + 1, isTab)
  const header = rows[0] ?? []
  const count = Math.max(1, Math.min(header.length, Math.floor(columns / 10)))
  const width = Math.max(6, Math.min(24, Math.floor((columns - count) / count)))
  const total = text.split('\n').filter(line => line.trim() !== '').length - 1
  return (
    <Box flexDirection="column">
      {rows.map((row, rowIndex) => (
        <Box key={`csv-${rowIndex}`} flexDirection="row">
          {row.slice(0, count).map((value, column) => (
            <Box key={`csv-${rowIndex}-${column}`} width={width + 1} flexShrink={0}>
              <Text bold={rowIndex === 0} color={rowIndex === 0 ? C.live : undefined} dimColor={rowIndex > 0 && rowIndex % 2 === 0}>
                {fit(value, width)}
              </Text>
            </Box>
          ))}
        </Box>
      ))}
      <Text dimColor>
        {Math.min(total, MAX_CSV_ROWS)} of {total} rows{header.length > count ? ` · ${count} of ${header.length} columns` : ''}
      </Text>
    </Box>
  )
}

function previewBody(t: T, table: Record<string, unknown>, surface: string, preview: Preview, columns: number): RenderNode {
  const { Box, Text, Markdown, Code } = t
  // A surface without an element still lists it, as a fragment that draws nothing: choose by surface.
  const Image = surface === 'terminal' ? (table as { Image?: Elements['terminal']['Image'] }).Image : undefined
  const picture = (file: string, alt: string): RenderNode =>
    Image === undefined ? (
      <Text dimColor>Pictures draw in the terminal (kitty, Ghostty). Saved at {file}</Text>
    ) : (
      <Image key="preview-image" source={{ file, format: 'png', generation: preview.generation }} columns={Math.max(10, columns - 2)} rows={Math.max(6, Math.round((columns - 2) * 0.31))} alt={alt} />
    )

  if (preview.kind === 'markdown') return <Markdown key="preview-md" text={preview.text.slice(0, MAX_MARKDOWN_CHARS)} />
  if (preview.kind === 'csv') return csvTable(t, preview.text, preview.path.toLowerCase().endsWith('.tsv'), columns)
  if (preview.kind === 'json') {
    let lines: ReturnType<typeof jsonTree>
    try {
      lines = jsonTree(parseJson(preview.text, preview.path))
    } catch (error) {
      return (
        <Box flexDirection="column">
          <Text color={C.bad}>Not valid JSON: {String(error)}</Text>
          <Code source={preview.text.slice(0, MAX_CODE_CHARS)} language="json" wrap="truncate-end" />
        </Box>
      )
    }
    const color = { object: C.accent, array: C.accent, string: C.ok, number: C.warn, boolean: C.live, null: 'gray' } as const
    return (
      <Box flexDirection="column">
        {lines.map((line, index) => (
          <Box key={`json-${index}`} flexDirection="row">
            <Text>{'  '.repeat(line.depth)}</Text>
            <Text color={C.live}>{line.key}</Text>
            <Text dimColor>: </Text>
            <Text color={color[line.kind]} wrap="truncate-end">
              {line.value}
            </Text>
          </Box>
        ))}
      </Box>
    )
  }
  if (preview.kind === 'html') {
    return (
      <Box flexDirection="column">
        {preview.image !== undefined && picture(preview.image, `Screenshot of ${preview.path}`)}
        {(preview.image === undefined || Image === undefined) && <Markdown key="preview-outline" text={htmlOutline(preview.text)} />}
      </Box>
    )
  }
  if (preview.kind === 'image') return preview.image === undefined ? <Text dimColor>{preview.note}</Text> : picture(preview.image, preview.path)
  if (preview.kind === 'svg') {
    const Svg = surface === 'desktop' || surface === 'mobile' ? (table as { Svg?: Elements['desktop']['Svg'] }).Svg : undefined
    return Svg === undefined ? (
      <Code source={preview.text.slice(0, MAX_CODE_CHARS)} language="xml" wrap="truncate-end" />
    ) : (
      <Svg source={preview.text} alt={preview.path} />
    )
  }
  const language = preview.kind === 'yaml' ? (preview.path.endsWith('.toml') ? 'toml' : 'yaml') : undefined
  return (
    <Box flexDirection="column">
      <Code source={preview.text.slice(0, MAX_CODE_CHARS)} path={preview.path} language={language} startLine={1} wrap="truncate-end" />
      {preview.text.length > MAX_CODE_CHARS && <Text dimColor>… showing the first {MAX_CODE_CHARS} characters</Text>}
    </Box>
  )
}

function previewView($: EngineInterface, t: T, table: Record<string, unknown>, surface: string, preview: Preview | null, isFollowing: boolean, columns: number): RenderNode {
  const { Box, Button, Text } = t
  const kindLabel = preview === null ? '' : preview.kind.toUpperCase()
  return (
    <Box flexDirection="column">
      {preview !== null && (
        <Box flexDirection="row" gap={1}>
          <Text bold>{preview.path}</Text>
          <Text color={C.live}>{kindLabel}</Text>
          <Text dimColor>{bytes(preview.size)}</Text>
          {preview.note !== undefined && preview.kind !== 'image' && <Text color={C.warn}>{preview.note}</Text>}
        </Box>
      )}
      <Box flexDirection="row" gap={1} marginBottom={1}>
        <Button key="pv-follow" label={isFollowing ? '● following edits' : '○ pinned'} hotkey="f" onPress={() => update($, followAtom, value => !value)} />
        {preview !== null && <Button key="pv-refresh" label="refresh" hotkey="r" onPress={() => openPreview($, preview.path)} />}
        {preview !== null && (
          <Button
            key="pv-copy"
            label="copy path"
            hotkey="c"
            onPress={async press => {
              const copied = await $.ui.copy({ text: absolute(preview.path, await rootOf($)), surface: press.surface })
              $.ui.toast(copied.isCopied ? 'Workbench: path copied.' : 'Workbench: could not copy here.')
            }}
          />
        )}
        {preview !== null && <Button key="pv-changes" label="changes" hotkey="g" onPress={() => openFile($, preview.path)} />}
      </Box>
      {preview === null && empty(t, 'Nothing to preview yet. Files Claude edits open here automatically, or pick one in Changes or Artifacts.')}
      {preview?.status === 'loading' && <Text color={C.live}>Rendering {preview.path}…</Text>}
      {preview?.status === 'error' && <Text color={C.bad}>{preview.text}</Text>}
      {preview?.status === 'ready' && previewBody(t, table, surface, preview, columns)}
    </Box>
  )
}

function artifactsView($: EngineInterface, t: T, artifacts: readonly Artifact[], now: number): RenderNode {
  const { Box, Button, Text } = t
  const kinds = (['doc', 'image', 'data', 'web', 'code', 'other'] as const).filter(kind => artifacts.some(one => one.kind === kind))
  const total = artifacts.reduce((sum, one) => sum + one.size, 0)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text bold>
          {artifacts.length} new file{artifacts.length === 1 ? '' : 's'}
        </Text>
        <Text dimColor>· {bytes(total)} · created this session by Claude ✦ or by commands it ran</Text>
        <Button key="art-refresh" label="refresh" hotkey="r" onPress={() => refreshArtifacts($)} />
      </Box>
      {artifacts.length === 0 && empty(t, 'Nothing created yet. Reports, images, data files and code Claude makes appear here.')}
      {kinds.map(kind => (
        <Box key={`ak-${kind}`} flexDirection="column" marginTop={1}>
          {heading(t, `${KIND_ICON[kind]} ${KIND_LABEL[kind]}`, String(artifacts.filter(one => one.kind === kind).length))}
          {artifacts
            .filter(one => one.kind === kind)
            .map(one => {
              const index = artifacts.indexOf(one)
              return (
                <Box key={`art-${index}`} flexDirection="row" gap={1}>
                  <Text color={one.isByClaude ? C.accent : 'gray'}>{one.isByClaude ? ' ✦' : '  '}</Text>
                  <Button key={`art:${index}`} label={one.path} plain onPress={() => openPreview($, one.path)} />
                  <Text dimColor>
                    {bytes(one.size)} · {ago(now - one.mtimeMs)}
                  </Text>
                  <Button
                    key={`art-copy:${index}`}
                    label="copy path"
                    plain
                    dimColor
                    onPress={async press => {
                      const copied = await $.ui.copy({ text: absolute(one.path, await rootOf($)), surface: press.surface })
                      $.ui.toast(copied.isCopied ? `Copied ${one.path}` : 'Workbench: could not copy here.')
                    }}
                  />
                </Box>
              )
            })}
        </Box>
      ))}
    </Box>
  )
}

function mapGraphView($: EngineInterface, t: T, graph: Graph, edits: readonly EditRecord[], focus: string | null): RenderNode {
  const { Box, Button, Text } = t
  const edited = new Map<string, number>()
  for (const edit of edits) edited.set(groupOf(edit.file), (edited.get(groupOf(edit.file)) ?? 0) + 1)
  const levels = [...new Set(graph.groups.map(group => group.level))].sort((a, b) => b - a)
  const focused = graph.groups.find(group => group.id === focus)
  const files = [...new Set(edits.map(edit => edit.file))].filter(file => focused !== undefined && groupOf(file) === focused.id)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={2}>
        <Text dimColor>
          {graph.files} files · {graph.groups.length} folders{graph.isGit ? '' : ' · folder mode (no git)'}
        </Text>
        <Text color={C.warn}>■ edited this session</Text>
        <Text dimColor>■ untouched</Text>
      </Box>
      {levels.map((level, index) => (
        <Box key={`lv-${level}`} flexDirection="column">
          {index > 0 && <Text dimColor>{'   ▼ imports'}</Text>}
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            <Box width={4} flexShrink={0}>
              <Text dimColor>L{level}</Text>
            </Box>
            {graph.groups
              .filter(group => group.level === level)
              .map(group => {
                const count = edited.get(group.id)
                return (
                  <Box key={`grp-${group.id}`} flexDirection="column" borderStyle={group.id === focus ? 'double' : 'round'} borderColor={count === undefined ? 'gray' : C.warn} paddingX={1}>
                    <Button key={`g:${group.id}`} label={group.id} plain onPress={() => update($, mapFocusAtom, now => (now === group.id ? null : group.id))} />
                    <Text dimColor>
                      {group.files} files · {shortCount(group.lines)} lines
                    </Text>
                    {count !== undefined && <Text color={C.warn}>✎ {count}</Text>}
                  </Box>
                )
              })}
          </Box>
        </Box>
      ))}
      {focused !== undefined && (
        <Box flexDirection="column" borderStyle="round" borderColor={C.accent} paddingX={1} marginTop={1}>
          <Text bold color={C.accent}>
            {focused.id} · {focused.symbols} functions and classes · layer L{focused.level}
          </Text>
          <Text>imports → {graph.edges.filter(edge => edge.from === focused.id).map(edge => `${edge.to} (${edge.count})`).join(', ') || 'nothing in the repo'}</Text>
          <Text>used by ← {graph.edges.filter(edge => edge.to === focused.id).map(edge => `${edge.from} (${edge.count})`).join(', ') || 'nothing in the repo'}</Text>
          {files.map((file, index) => (
            <Button key={`mf:${index}`} label={`▸ ${file}`} plain onPress={() => loadOutline($, file)} />
          ))}
        </Box>
      )}
    </Box>
  )
}

function componentsView($: EngineInterface, t: T, outline: Outline | null, columns: number): RenderNode {
  const { Box, Button, Text } = t
  if (outline === null) return empty(t, 'Pick a file in Changes, or a touched file in the map, to see its classes, functions and what each calls.')
  if (outline.status === 'loading') return <Text color={C.live}>Reading {outline.file}…</Text>
  if (outline.status === 'error') return <Text color={C.bad}>{outline.error}</Text>
  const longest = Math.max(1, ...outline.entries.map(entry => entry.endLine - entry.line + 1))
  const barWidth = Math.max(6, Math.min(24, Math.floor(columns * 0.2)))
  return (
    <Box flexDirection="column">
      <Text bold>
        {outline.file} · {outline.lines} lines · {outline.entries.length} components ·{' '}
        <Text color={C.warn}>{outline.entries.filter(entry => entry.isChanged).length} changed</Text>
      </Text>
      {outline.entries.map((entry, index) => {
        const size = entry.endLine - entry.line + 1
        return (
          <Box key={`oe-${index}`} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text>{'  '.repeat(entry.depth)}</Text>
              <Text color={entry.isChanged ? C.warn : entry.kind === 'class' ? C.accent : C.live}>{KIND_ICON_CODE[entry.kind]}</Text>
              {entry.kind === 'class' ? (
                <Text bold>{entry.name}</Text>
              ) : (
                <Button key={`oc:${index}`} label={entry.name} plain onPress={() => loadCalls($, entry.name)} />
              )}
              <Text dimColor>
                L{entry.line}-{entry.endLine}
              </Text>
              <Text color={entry.isChanged ? C.warn : 'gray'}>{'▇'.repeat(Math.max(1, Math.round((size / longest) * barWidth)))}</Text>
              {entry.isChanged && <Text color={C.warn}>● changed</Text>}
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
  )
}

function callsView($: EngineInterface, t: T, call: CallView | null, trail: readonly string[], ask: RenderNode | null): RenderNode {
  const { Box, Button, Text } = t
  const previous = call === null ? undefined : trail[trail.indexOf(call.symbol) - 1]
  const site = (one: Site, key: string): RenderNode => (
    <Box key={`row-${key}`} flexDirection="row" gap={1}>
      <Text dimColor>{'   ├'}</Text>
      {one.isKnown ? <Button key={key} label={one.symbol} plain onPress={() => loadCalls($, one.symbol)} /> : <Text dimColor>{one.symbol}</Text>}
      <Text dimColor wrap="truncate-end">
        {one.file === '' ? '(outside the repo)' : `${one.file}:${one.line}`}
      </Text>
    </Box>
  )
  return (
    <Box flexDirection="column">
      {ask}
      <Box flexDirection="row" gap={1}>
        <Button
          key="calls-selection"
          label="use my selection"
          hotkey="s"
          onPress={async () => {
            const selected = await $.ui.selection()
            const symbol = selected === undefined ? null : symbolFromSelection(selected.text)
            if (symbol === null) $.ui.toast('Workbench: select a function name in the transcript first.')
            else await loadCalls($, symbol)
          }}
        />
        {previous !== undefined && <Button key="calls-back" label={`back to ${previous}`} hotkey="b" onPress={() => loadCalls($, previous, true)} />}
      </Box>
      {call === null && empty(t, 'Type a function name, or select one in the transcript.')}
      {call?.status === 'loading' && <Text color={C.live}>Tracing {call.symbol}…</Text>}
      {(call?.status === 'error' || call?.status === 'missing') && (
        <Text color={C.bad}>{call.status === 'missing' ? `No definition or calls of ${call.symbol} found.` : call.error}</Text>
      )}
      {call?.status === 'ready' && (
        <Box flexDirection="column" marginTop={1}>
          {trail.length > 1 && (
            <Text dimColor wrap="truncate-start">
              {trail.join(' › ')}
            </Text>
          )}
          <Box flexDirection="row" gap={1}>
            <Text bold color={C.live}>
              ƒ {call.symbol}
            </Text>
            <Text dimColor>{call.definition === undefined ? 'definition not found' : `${call.definition.file}:${call.definition.line}`}</Text>
          </Box>
          <Text bold color={C.accent}>
            ▲ Called by ({call.callers.length})
          </Text>
          {call.callers.length === 0 && <Text dimColor> no callers found</Text>}
          {call.callers.map((one, index) => site(one, `caller:${index}`))}
          <Text bold color={C.ok}>
            ▼ Calls ({call.callees.filter(one => one.isKnown).length} in the repo)
          </Text>
          {call.callees.map((one, index) => site(one, `callee:${index}`))}
        </Box>
      )}
    </Box>
  )
}

function usageView(t: T, limits: readonly Limit[], reading: Reading | null, history: readonly number[], turns: readonly Turn[], costUsd: number | null, now: number, columns: number): RenderNode {
  const { Box, Text } = t
  const barWidth = Math.max(16, Math.min(40, Math.floor(columns * 0.35)))
  const costed = turns.filter(turn => turn.costUsd !== undefined || turn.outputTokens !== undefined).slice(-12)
  const maxCost = Math.max(0.0001, ...costed.map(turn => turn.costUsd ?? 0))
  const maxTokens = Math.max(1, ...costed.map(turn => (turn.inputTokens ?? 0) + (turn.outputTokens ?? 0)))
  return (
    <Box flexDirection="column">
      {heading(t, 'Plan limits')}
      {limits.length === 0 && <Text dimColor> No reading yet: limits appear after a reply on a Claude subscription.</Text>}
      {limits.map(limit => {
        const view = viewOf(limit, now)
        const filled = meter(view.percent, barWidth)
        const reset = limit.resetsAt === undefined ? Number.NaN : Date.parse(limit.resetsAt)
        const windowMs = limit.kind === 'five_hour' ? 5 * 3_600_000 : limit.kind === 'seven_day' ? 7 * 86_400_000 : 0
        const elapsed = Number.isNaN(reset) || windowMs === 0 ? 0 : now - (reset - windowMs)
        const projected = elapsed > 5 * 60_000 ? Math.round((limit.percentUsed / elapsed) * windowMs) : undefined
        return (
          <Box key={`ul-${limit.kind}`} flexDirection="column" marginTop={1}>
            <Box flexDirection="row" gap={1}>
              <Box width={8} flexShrink={0}>
                <Text bold>{view.label}</Text>
              </Box>
              <Text>
                <Text color={view.color}>{filled.used}</Text>
                <Text dimColor>{filled.left}</Text>
              </Text>
              <Text bold color={view.color}>
                {Math.round(view.percent)}%
              </Text>
            </Box>
            <Text dimColor>
              {'         '}
              {view.resetIn === undefined ? 'reset time unknown' : `↻ resets in ${view.resetIn} · at ${view.resetAt}`}
              {projected === undefined ? '' : ` · on pace for ${projected}% by the reset`}
            </Text>
            {view.runsOutIn !== undefined && (
              <Text color={view.percent >= 70 ? C.bad : C.warn}>
                {'         '}⚠ at this pace you run out in {view.runsOutIn}, before the reset
              </Text>
            )}
          </Box>
        )
      })}
      <Box marginTop={1}>{heading(t, 'Context window')}</Box>
      {reading === null ? (
        <Text dimColor> No reading yet.</Text>
      ) : (
        <Box flexDirection="row" gap={1}>
          <Text color={sky(reading.percent).color} bold>
            {' '}
            {sky(reading.percent).icon} {sky(reading.percent).label}
          </Text>
          <Text>
            {reading.percent}% · {kilo(reading.tokens)} of {kilo(reading.window)}
          </Text>
          <Text color={C.live}>{sparkline(history)}</Text>
          <Text dimColor>{outlook(history, reading)}</Text>
        </Box>
      )}
      <Box marginTop={1}>{heading(t, 'Cost per turn', costUsd === null ? 'tokens only: no cost ledger here' : `session total $${costUsd.toFixed(2)}`)}</Box>
      {costed.length === 0 && <Text dimColor> Turns appear here as they finish.</Text>}
      {costed.map((turn, index) => {
        const value = turn.costUsd ?? 0
        const tokens = (turn.inputTokens ?? 0) + (turn.outputTokens ?? 0)
        const share = turn.costUsd === undefined ? tokens / maxTokens : value / maxCost
        return (
          <Box key={`uc-${turn.id}`} flexDirection="row" gap={1}>
            <Box width={5} flexShrink={0}>
              <Text dimColor>T{turns.indexOf(turn) + 1}</Text>
            </Box>
            <Box width={barWidth} flexShrink={0}>
              <Text color={index === costed.length - 1 ? C.live : C.accent}>{'█'.repeat(Math.max(1, Math.round(share * barWidth)))}</Text>
            </Box>
            <Box width={8} flexShrink={0}>
              <Text>{turn.costUsd === undefined ? '' : `$${value.toFixed(3)}`}</Text>
            </Box>
            <Text dimColor wrap="truncate-end">
              {kilo(turn.inputTokens ?? 0)} in · {kilo(turn.outputTokens ?? 0)} out · “{turn.prompt.slice(0, 40)}”
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

// ── Hooks ───────────────────────────────────────────────────────────────

async function openTab($: EngineInterface, args: string): Promise<void> {
  const [word = '', ...rest] = args.trim().split(/\s+/)
  const value = rest.join(' ')
  if (word === 'preview' && value !== '') await openPreview($, value)
  else if ((word === 'file' || word === 'changes') && value !== '') await openFile($, value)
  else if (word === 'calls' && value !== '') await loadCalls($, value)
  else if (word === 'components' && value !== '') await loadOutline($, value)
  else if (word === 'hud') await update($, hudHiddenAtom, () => value === 'off')
  else if (word === 'rescan') {
    await update($, tabAtom, (): Tab => 'map')
    await scan($)
  } else {
    const found = TABS.find(one => one.tab === word || one.key === word || one.label.toLowerCase().startsWith(word.toLowerCase()))
    if (found !== undefined && word !== '') await update($, tabAtom, () => found.tab)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({
      name: 'wb',
      description: 'Workbench: Now · Changes · Preview · Artifacts · Code Map · Usage',
      argumentHint: '[now|changes|preview <file>|artifacts|map|usage|calls <name>|hud on|off]',
      immediate: true,
    })
    await update($, startedAtAtom, () => 0)
    $.clock.after(0, () => {
      void (async () => {
        const usage = await $.session.usage()
        await update($, startedAtAtom, () => usage.startedAt)
        await snapshotFolder($)
      })().catch(() => undefined)
    })
    $.clock.after(1500, () => void scan($).catch(() => undefined))
    let ticks = 0
    $.clock.every(1000, () => {
      ticks += 1
      if (isBusy || ticks % 30 === 0) $.ui.invalidate('ui.render')
    })

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    const turn: Turn = { id: e.turnId, prompt: e.text.replace(/\s+/g, ' ').slice(0, 100), startedAt: now, status: 'running', steps: [], lanes: [{ id: 'main', label: 'Main' }] }
    await update($, turnsAtom, list => [...list, turn].slice(-Math.max(MAX_TURNS, 30)))
    await update($, turnBackAtom, () => 0)
    isBusy = true
    try {
      turnCostStart = (await $.session.usage()).cost?.usd ?? null
    } catch {
      turnCostStart = null
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const tool = String(e.tool)
    const lane = e.agentId ?? 'main'
    const startedAt = await $.clock.now()
    const step: Step = { id: e.tool_use_id, lane, tool, summary: summarize(tool, input), startedAt, status: 'running', output: '' }
    let label = ''
    if (lane !== 'main' && !((await read($, turnsAtom)).at(-1)?.lanes.some(one => one.id === lane) ?? false)) {
      try {
        const agent = (await $.agent.list()).find(one => one.id === lane)
        label = agent === undefined ? `Subagent ${lane.slice(0, 8)}` : `${agent.name ?? agent.type}: ${agent.description}`
      } catch {
        label = `Subagent ${lane.slice(0, 8)}`
      }
    }
    await update($, turnsAtom, list => onNewest(list, startedAt, turn => withStep(turn, step, label)))
    isBusy = true

    const ran = await next(e)

    try {
      const status = statusOf(ran)
      const endedAt = await $.clock.now()
      const output = preview(status === 'denied' ? ran.deny : ran.text)
      await update($, turnsAtom, list => withStepChange(list, step.id, { endedAt, status, output }))
      if (tool === 'Agent' && status === 'ok') {
        const record = (ran.result ?? {}) as Record<string, unknown>
        const agentId = typeof record.agentId === 'string' ? record.agentId : undefined
        const type = typeof input.subagent_type === 'string' ? input.subagent_type : 'general-purpose'
        const description = typeof input.description === 'string' ? input.description : ''
        await update($, turnsAtom, list =>
          withStepChange(list, step.id, {
            agent: {
              agentId,
              type,
              description,
              toolCount: typeof record.totalToolUseCount === 'number' ? record.totalToolUseCount : undefined,
              tokens: typeof record.totalTokens === 'number' ? record.totalTokens : undefined,
            },
          }),
        )
        if (agentId !== undefined) await update($, turnsAtom, list => relabel(list, agentId, `${type}${description === '' ? '' : `: ${description}`}`))
      }
      if ((tool === 'Edit' || tool === 'Write') && status === 'ok') {
        const turnId = (await read($, turnsAtom)).at(-1)?.id ?? 'earlier'
        const record = await recordEdit($, tool, input, (ran.result ?? {}) as FileResult, turnId)
        if (record !== null && (await read($, followAtom))) await openPreview($, record.file, false)
      }
    } catch {
      // Watching is best effort: the tool's own result always goes back unchanged.
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined) return ran

    const endedAt = await $.clock.now()
    const usage = await $.session.usage()
    const status = e.reason === 'aborted' ? 'interrupted' : e.reason === 'answer' ? 'done' : 'failed'
    const costNow = usage.cost?.usd
    const costUsd = costNow === undefined || turnCostStart === null ? undefined : Math.max(0, costNow - turnCostStart)
    await update($, turnsAtom, list =>
      onNewest(list, endedAt, turn => ({ ...turn, endedAt, status, inputTokens: e.usage?.input_tokens, outputTokens: e.usage?.output_tokens, costUsd })),
    )
    isBusy = false
    const reading = toReading(usage.context)
    if (reading !== null) {
      await update($, readingAtom, () => reading)
      await update($, historyAtom, list => [...list, reading.percent].slice(-HISTORY_LENGTH))
    }
    if (usage.rateLimits.length > 0) {
      const limits = toLimits(usage.rateLimits)
      await update($, limitsAtom, () => limits)
    }
    if (costNow !== undefined) await update($, costAtom, () => costNow)
    $.clock.after(200, () => void refreshArtifacts($).catch(() => undefined))

    return ran
  })

  on('session.measure', async ($, e, next) => {
    const reading = toReading(e.context)
    if (e.changed.includes('context') && reading !== null) await update($, readingAtom, () => reading)
    if (e.changed.includes('rateLimits')) {
      const limits = toLimits(e.rateLimits)
      await update($, limitsAtom, () => limits)
    }
    if (e.changed.includes('cost') && e.cost !== undefined) {
      const usd = e.cost.usd
      await update($, costAtom, () => usd)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, turnsAtom, () => [])
      await update($, editsAtom, () => [])
      await update($, changeFileAtom, () => null)
      await update($, changeEditAtom, () => null)
      await update($, historyAtom, () => [])
      editBaselines.clear()
    }
    return next(e)
  })

  on('command.run', { command: 'wb' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: TITLE })
    await openTab($, e.args)
    if ((await read($, tabAtom)) === 'artifacts') await refreshArtifacts($)

    return {}
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Other mods draw in this band too: draw theirs first and stack the HUD above it, never in its place.
    const below = await next(e)
    if (e.props.hasSurvey || (await read($, hudHiddenAtom))) return below
    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const limits = await read($, limitsAtom)
    const reading = await read($, readingAtom)
    const turns = await read($, turnsAtom)
    const edits = await read($, editsAtom)
    const artifacts = await read($, artifactsAtom)
    const startedAt = await read($, startedAtAtom)
    if (limits.length === 0 && reading === null && turns.length === 0) return below

    const tools = turns.reduce((sum, turn) => sum + turn.steps.length, 0)
    const files = new Set(edits.map(edit => edit.file)).size
    const added = edits.reduce((sum, edit) => sum + edit.added, 0)
    const removed = edits.reduce((sum, edit) => sum + edit.removed, 0)
    const running = turns.at(-1)?.steps.findLast(step => step.status === 'running')
    const last = edits.at(-1)
    const firstMinus = last?.hunks.flatMap(hunk => hunk.lines).find(line => line.startsWith('-'))
    const firstPlus = last?.hunks.flatMap(hunk => hunk.lines).find(line => line.startsWith('+'))
    const sep = <Text color="gray">│</Text>

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {limits.slice(0, 2).map(limit => {
            const view = viewOf(limit, now)
            const gauge = meter(view.percent, 8)
            return (
              <Box key={`hud-${limit.kind}`} flexDirection="row" gap={1}>
                <Text bold>{limit.kind === 'five_hour' ? '5h' : limit.kind === 'seven_day' ? 'Wk' : view.label}</Text>
                <Text>
                  <Text color={view.color}>{gauge.used}</Text>
                  <Text dimColor>{gauge.left}</Text>
                </Text>
                <Text color={view.color}>{Math.round(view.percent)}%</Text>
                {view.resetIn !== undefined && <Text dimColor>↻{view.resetIn}</Text>}
                {view.runsOutIn !== undefined && <Text color={C.bad}>⚠</Text>}
                {sep}
              </Box>
            )
          })}
          {reading !== null && (
            <Text>
              <Text bold>Ctx </Text>
              <Text color={sky(reading.percent).color}>
                {sky(reading.percent).icon} {reading.percent}%
              </Text>
            </Text>
          )}
          {reading !== null && sep}
          <Text dimColor>
            ⏱ {startedAt > 0 ? duration(now - startedAt) : '–'} · {tools} tools
          </Text>
          {sep}
          <Text>
            ✎ {files} file{files === 1 ? '' : 's'} <Text color={C.ok}>+{added}</Text> <Text color={C.bad}>−{removed}</Text>
          </Text>
          {artifacts.length > 0 && sep}
          {artifacts.length > 0 && <Text color={C.accent}>✦ {artifacts.length} new</Text>}
        </Box>
        <Box flexDirection="row" gap={1}>
          {running !== undefined ? (
            <Text color={C.live} wrap="truncate-end">
              ● {running.tool} {running.summary} · {seconds(now - running.startedAt)}
            </Text>
          ) : last !== undefined ? (
            <Box flexDirection="row" gap={1} flexShrink={1}>
              <Text color={C.warn}>✎ {last.file.split('/').pop()}</Text>
              {firstMinus !== undefined && (
                <Text color={C.bad} wrap="truncate-end">
                  {firstMinus.trim().slice(0, 60)}
                </Text>
              )}
              {firstPlus !== undefined && (
                <Text color={C.ok} wrap="truncate-end">
                  {firstPlus.trim().slice(0, 60)}
                </Text>
              )}
            </Box>
          ) : (
            <Text dimColor>Workbench · /wb opens the pane</Text>
          )}
          <Button
            key="hud-open"
            label="open ▸"
            plain
            onPress={async () => {
              await update($, tabAtom, (): Tab => (running !== undefined ? 'now' : last !== undefined ? 'changes' : 'now'))
              await $.ui.open({ id: PANE, title: TITLE })
            }}
          />
          <Button key="hud-hide" label="hide" plain dimColor onPress={() => update($, hudHiddenAtom, () => true)} />
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const t: T = table
    const { Box, Button, Text } = t
    const tab = await read($, tabAtom)
    const now = await $.clock.now()
    const columns = e.props.bodyColumns
    const turns = await read($, turnsAtom)
    const edits = await read($, editsAtom)

    let body: RenderNode
    if (tab === 'now') {
      body = nowView($, t, turns, await read($, turnBackAtom), await read($, showOutputsAtom), now, columns)
    } else if (tab === 'changes') {
      const editId = await read($, changeEditAtom)
      const file = await read($, changeFileAtom)
      const edit = edits.find(one => one.id === editId)
      body =
        edit !== undefined ? diffView($, t, edits, edit, turns, columns)
        : file !== null ? fileView($, t, file, await read($, fileSummaryAtom), edits, turns)
        : changesOverview($, t, edits, turns)
    } else if (tab === 'preview') {
      body = previewView($, t, table as unknown as Record<string, unknown>, e.surface, await read($, previewAtom), await read($, followAtom), columns)
    } else if (tab === 'artifacts') {
      body = artifactsView($, t, await read($, artifactsAtom), now)
    } else if (tab === 'map') {
      const view = await read($, mapViewAtom)
      const status = await read($, scanStatusAtom)
      const graph = await read($, graphAtom)
      const ask =
        e.surface !== 'mobile' && 'Input' in table ? (
          <table.Input key="calls-symbol" label="Function" placeholder="name of a function or class" submitLabel="trace" onSubmit={value => void loadCalls($, value)} />
        ) : null
      const inner =
        view === 'components' ? componentsView($, t, await read($, outlineAtom), columns)
        : view === 'calls' ? callsView($, t, await read($, callAtom), await read($, trailAtom), ask)
        : status === 'scanning' ? <Text color={C.live}>Scanning the code…</Text>
        : status === 'error' ? <Text color={C.bad}>Scan failed: {await read($, scanErrorAtom)}</Text>
        : status === 'no-folder' ? <Text color={C.bad}>Workbench could not tell which folder to read.</Text>
        : graph === null ? <Text dimColor>Starting the first scan…</Text>
        : mapGraphView($, t, graph, edits, await read($, mapFocusAtom))
      body = (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1} marginBottom={1}>
            {(['map', 'components', 'calls'] as const).map((one, index) => (
              <Button
                key={`mv:${one}`}
                label={one === 'map' ? 'architecture' : one}
                hotkey={['a', 'm', 'k'][index]}
                variant={one === view ? 'primary' : 'secondary'}
                onPress={() => update($, mapViewAtom, () => one)}
              />
            ))}
            <Button key="mv-rescan" label="rescan" hotkey="x" onPress={() => scan($)} />
          </Box>
          {inner}
        </Box>
      )
    } else {
      body = usageView(t, await read($, limitsAtom), await read($, readingAtom), await read($, historyAtom), turns, await read($, costAtom), now, columns)
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
                if (one.tab === 'artifacts') await refreshArtifacts($)
              }}
            />
          ))}
        </Box>
        <Text color="gray">{'─'.repeat(Math.max(10, columns - 1))}</Text>
        <Box flexDirection="column">{body}</Box>
      </Box>
    )
  })
}
