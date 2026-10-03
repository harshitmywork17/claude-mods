import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, RenderNode, Register, SessionContextUsage, SessionRateLimit, UiPressArgument } from 'claude-code'

import type {
  Artifact,
  Baselines,
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
import { escapeRegex, innermostChanged, lineDiff, markChanged, outlineOf, symbolChanges } from './changes'
import { changedRanges, fit, hunksText, unifiedDiff } from './diff'
import type { Range } from './changes'
import { HISTORY_LENGTH, kilo, outlook, sky, sparkline } from './forecast'
import { KIND_LABEL, ago, artifactKind, bytes, htmlOutline, jsonTree, parseCsv, parseJson, previewKind } from './files'
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
import { C, diffstat, hasContent, head, hue, pill, tail } from './theme'
import { BADGE, MAX_TURNS, modelTime, onNewest, preview, promptLabel, relabel, seconds, statusOf, summarize, withStep, withStepChange } from './trace'

// ── State ───────────────────────────────────────────────────────────────

const tabAtom = atom({ plugin: 'workbench', key: 'tab' } as const, 'now')
const hudHiddenAtom = atom({ plugin: 'workbench', key: 'isHudHidden' } as const, false)
const slideAtom = atom({ plugin: 'workbench', key: 'slide' } as const, 'workbench')
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
/** Each file as it was before Claude first touched it this session, in state so a reload keeps it. */
const baselinesAtom = atom({ plugin: 'workbench', key: 'baselines' } as const, {})

const PANE = 'workbench'
const TITLE = 'Workbench'
/** The sidebar width asked for: room for the tabs, a diff and the change bars on one line. */
const PANE_COLUMNS = 76
const MAX_EDITS = 300
/** Larger files keep no baseline: their whole-file diff falls back to the recorded edits. */
const MAX_BASELINE_CHARS = 400_000
const MAX_HUNK_LINES = 400
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
/** Every file in the folder when the session began: what Artifacts compares against. */
let startListing: Set<string> | null = null
const claudeCreated = new Set<string>()
/** The browser used for HTML screenshots: undefined until looked for, null when none was found. */
let browser: string | null | undefined
let isBusy = false
let turnCostStart: number | null = null
let previewGeneration = 0
let hasHinted = false

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
async function sessionRanges($: EngineInterface, path: string, text: string): Promise<Range[]> {
  const baselines = await read($, baselinesAtom)
  if (!(path in baselines)) return []
  return lineDiff(path, baselines[path] ?? null, text).ranges
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
    const entries = markChanged(outlineOf(text, path), await sessionRanges($, path, text)).map(entry => ({
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
  const baseline = isCreate ? null : (result.originalFile ?? null)
  if (!(file in (await read($, baselinesAtom))) && (baseline === null || baseline.length <= MAX_BASELINE_CHARS)) {
    await update($, baselinesAtom, (all): Baselines => ({ ...all, [file]: baseline }))
  }
  if (isCreate) claudeCreated.add(file)

  const { hunks, isCut } = hunksOf(result)
  const lines = hunks.flatMap(hunk => hunk.lines)
  const text = await readText($, abs)
  const symbols = innermostChanged(markChanged(outlineOf(text, file), changedRanges(hunks))).map(entry => entry.name)
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
  await update($, fileSummaryAtom, (): FileSummary => ({ file, status: 'loading', symbols: [], added: 0, removed: 0, diff: '', isDiffCut: false }))
  try {
    const root = await rootOf($)
    const after = await readText($, absolute(file, root))
    const baselines = await read($, baselinesAtom)
    if (!(file in baselines)) {
      // No baseline kept (a very large file): show the recorded edits one after another instead.
      const mine = (await read($, editsAtom)).filter(edit => edit.file === file)
      const joined = hunksText(mine.flatMap(edit => edit.hunks))
      const summary: FileSummary = {
        file,
        status: 'ready',
        symbols: [],
        added: mine.reduce((sum, edit) => sum + edit.added, 0),
        removed: mine.reduce((sum, edit) => sum + edit.removed, 0),
        diff: joined.text,
        isDiffCut: joined.isCut,
      }
      await update($, fileSummaryAtom, () => summary)
      return
    }
    const before = baselines[file] ?? null
    const diff = lineDiff(file, before, after === '' && before !== null ? null : after)
    const symbols = symbolChanges(outlineOf(after, file), outlineOf(before ?? '', file), diff.ranges)
    const unified = unifiedDiff(before, after === '' && before !== null ? null : after)
    await update($, fileSummaryAtom, (): FileSummary => ({ file, status: 'ready', symbols, added: diff.added, removed: diff.removed, diff: unified.text, isDiffCut: unified.isCut }))
  } catch (error) {
    await update($, fileSummaryAtom, (): FileSummary => ({ file, status: 'error', symbols: [], added: 0, removed: 0, diff: '', isDiffCut: false, error: String(error) }))
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
  // Files Claude wrote come from the edit record as well, which outlives a reload of this module.
  const created = new Set([...claudeCreated, ...(await read($, editsAtom)).filter(edit => edit.kind === 'create').map(edit => edit.file)])
  if (startListing === null) {
    startListing = new Set(listed.map(file => file.path).filter(path => !created.has(path)))
  }
  const before = startListing
  const made: Artifact[] = listed
    .filter(file => !before.has(file.path) || created.has(file.path))
    .map(file => ({ path: file.path, kind: artifactKind(file.path), size: file.size, mtimeMs: file.mtimeMs, isByClaude: created.has(file.path) }))
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

type Action = { key: string; hotkey: string; label: string; onPress: (press: UiPressArgument) => unknown }

const TABS: { tab: Tab; label: string; key: string }[] = [
  { tab: 'now', label: 'Now', key: '1' },
  { tab: 'changes', label: 'Changes', key: '2' },
  { tab: 'preview', label: 'Preview', key: '3' },
  { tab: 'artifacts', label: 'Artifacts', key: '4' },
  { tab: 'map', label: 'Map', key: '5' },
  { tab: 'usage', label: 'Usage', key: '6' },
]

const CHANGE_MARK = { added: ['+', C.ok], modified: ['~', C.warn], removed: ['−', C.bad] } as const
const KIND_ICON_CODE = { class: '◆', function: 'ƒ', method: '·' } as const
const TURN_STATUS = { running: ['● running', C.live], done: ['✓ done', C.ok], interrupted: ['⊘ stopped', C.warn], failed: ['✗ failed', C.bad] } as const

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}

function turnNumber(turns: readonly Turn[], turnId: string): string {
  const index = turns.findIndex(turn => turn.id === turnId)
  return index < 0 ? 'T–' : `T${index + 1}`
}

/** A section title, a rule to the right edge, and an optional note at the end: TITLE ──────── note */
function section(t: T, title: string, width: number, note = '', noteColor: string = C.soft): RenderNode {
  const { Box, Text } = t
  const label = head(title, Math.max(4, width - 8))
  const room = width - label.length - 1 - (note === '' ? 0 : note.length + 1)
  return (
    <Box flexDirection="row" marginTop={1}>
      <Text bold color={C.accent}>
        {label}
      </Text>
      <Text color={C.line}> {'─'.repeat(Math.max(2, room))}</Text>
      {note !== '' && <Text color={noteColor}> {note}</Text>}
    </Box>
  )
}

/** The key legend at the bottom of a view: each action a plain button drawn as `k: label`. */
function footer(t: T, actions: readonly Action[], width: number): RenderNode | null {
  const { Box, Button, Text } = t
  if (actions.length === 0) return null
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={C.line}>{'─'.repeat(width)}</Text>
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {actions.map(action => (
          <Button key={action.key} label={action.label} hotkey={action.hotkey} plain dimColor onPress={action.onPress} />
        ))}
      </Box>
    </Box>
  )
}

function empty(t: T, icon: string, title: string, hint: string): RenderNode {
  const { Box, Text } = t
  return (
    <Box flexDirection="column" marginTop={1} paddingX={1}>
      <Text bold color={C.soft}>
        {icon} {title}
      </Text>
      <Text dimColor>{hint}</Text>
    </Box>
  )
}

/** Fixed-width cell: content truncated, never wrapped, so columns line up. */
function cell(t: T, width: number, child: RenderNode, isRight = false): RenderNode {
  const { Box } = t
  return (
    <Box width={width} flexShrink={0} justifyContent={isRight ? 'flex-end' : 'flex-start'}>
      {child}
    </Box>
  )
}

function plusMinus(t: T, added: number, removed: number): RenderNode {
  const { Text } = t
  return (
    <Text>
      <Text color={C.ok}>+{added}</Text> <Text color={C.bad}>−{removed}</Text>
    </Text>
  )
}

// ── Now ─────────────────────────────────────────────────────────────────

function stepColor(step: Step, now: number): string {
  if (step.status === 'running') return C.live
  if (step.status === 'error') return C.bad
  if (step.status === 'denied') return C.pink
  const took = (step.endedAt ?? now) - step.startedAt
  return took >= 30_000 ? C.bad : took >= 10_000 ? C.warn : C.soft
}

function stepRows(t: T, step: Step, now: number, width: number, indent: number, showOutputs: boolean): RenderNode {
  const { Box, Text } = t
  const color = stepColor(step, now)
  const badge = step.status === 'ok' ? C.ok : color
  const lead = indent + 2
  const summaryWidth = Math.max(6, width - lead - 8 - 8)
  const isProblem = step.status === 'error' || step.status === 'denied'
  const output = step.output.replace(/\s*\n\s*/g, ' ⏎ ')
  return (
    <Box key={`step-${step.id}`} flexDirection="column">
      <Box flexDirection="row">
        {cell(t, lead, <Text color={badge}>{`${' '.repeat(indent)}${BADGE[step.status]}`}</Text>)}
        {cell(
          t,
          8,
          <Text bold color={C.text} wrap="truncate-end">
            {step.tool}
          </Text>,
        )}
        {cell(
          t,
          summaryWidth,
          <Text color={C.soft} wrap="truncate-end">
            {step.summary === '' ? '—' : step.summary}
          </Text>,
        )}
        {cell(t, 8, <Text color={color}>{seconds((step.endedAt ?? now) - step.startedAt)}</Text>, true)}
      </Box>
      {(showOutputs || isProblem) && output !== '' && (
        <Box paddingLeft={lead}>
          <Text color={isProblem ? C.bad : C.line} wrap="truncate-end">
            ↳ {output}
          </Text>
        </Box>
      )}
    </Box>
  )
}

function nowView($: EngineInterface, t: T, turns: readonly Turn[], back: number, showOutputs: boolean, now: number, width: number): RenderNode {
  const { Box, Text } = t
  const offset = Math.min(back, Math.max(0, turns.length - 1))
  const turn = turns[turns.length - 1 - offset]
  if (turn === undefined) {
    return empty(t, '●', 'Waiting for the first turn', 'Every tool call shows here as it runs: what ran, how long it took, its output, and the subagents it started.')
  }

  const total = (turn.endedAt ?? now) - turn.startedAt
  const failed = turn.steps.filter(step => step.status === 'error' || step.status === 'denied').length
  const counts = new Map<string, number>()
  for (const step of turn.steps) counts.set(step.tool, (counts.get(step.tool) ?? 0) + 1)
  const [statusText, statusColor] = TURN_STATUS[turn.status]

  // Subagent lanes sit under the Agent call that started them; lanes still unclaimed follow the main steps.
  const claimed = new Set(turn.steps.map(step => step.agent?.agentId).filter((id): id is string => id !== undefined))
  const loose = turn.lanes.filter(lane => lane.id !== 'main' && !claimed.has(lane.id) && turn.steps.some(step => step.lane === lane.id))
  const laneSteps = (id: string): Step[] => turn.steps.filter(step => step.lane === id)

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          <Text bold color={C.text}>
            Turn {turns.length - offset}
          </Text>
          <Text color={C.soft}> of {turns.length}</Text>
        </Text>
        <Text>
          <Text bold color={statusColor}>
            {statusText}
          </Text>
          <Text color={C.soft}> · {seconds(total)}</Text>
        </Text>
      </Box>
      <Text italic color={C.soft} wrap="truncate-end">
        “{turn.prompt}”
      </Text>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
        {[...counts].map(([tool, count]) => (
          <Text key={`count-${tool}`} backgroundColor={C.chip} color={C.text}>
            {` ${tool} ${count} `}
          </Text>
        ))}
        <Text color={C.soft}>model {seconds(modelTime(turn, now))}</Text>
      </Box>
      {section(t, 'STEPS', width, `${turn.steps.length} call${turn.steps.length === 1 ? '' : 's'}${failed > 0 ? ` · ${failed} failed` : ''}`, failed > 0 ? C.bad : C.soft)}
      {turn.steps.length === 0 && <Text dimColor> Thinking: no tool calls yet.</Text>}
      {laneSteps('main').map(step => (
        <Box key={`main-${step.id}`} flexDirection="column">
          {stepRows(t, step, now, width, 0, showOutputs)}
          {step.agent !== undefined && (
            <Box flexDirection="column">
              <Text color={C.accent} wrap="truncate-end">
                {'  '}⑂ {step.agent.type}
                {step.agent.toolCount === undefined ? '' : ` · ${step.agent.toolCount} tools`}
                {step.agent.tokens === undefined ? '' : ` · ${kilo(step.agent.tokens)} tokens`}
              </Text>
              {step.agent.agentId !== undefined && laneSteps(step.agent.agentId).map(inner => stepRows(t, inner, now, width, 2, showOutputs))}
            </Box>
          )}
        </Box>
      ))}
      {loose.map(lane => (
        <Box key={`lane-${lane.id}`} flexDirection="column">
          <Text color={C.accent} wrap="truncate-end">
            {'  '}⑂ {lane.label}
          </Text>
          {laneSteps(lane.id).map(inner => stepRows(t, inner, now, width, 2, showOutputs))}
        </Box>
      ))}
      {footer(
        t,
        [
          { key: 'now-outputs', hotkey: 'v', label: showOutputs ? 'hide outputs' : 'show outputs', onPress: () => update($, showOutputsAtom, value => !value) },
          ...(offset < turns.length - 1 ? [{ key: 'now-older', hotkey: 'o', label: 'older turn', onPress: () => update($, turnBackAtom, n => n + 1) }] : []),
          ...(offset > 0 ? [{ key: 'now-newer', hotkey: 'w', label: 'newer turn', onPress: () => update($, turnBackAtom, n => n - 1) }] : []),
        ],
        width,
      )}
    </Box>
  )
}

// ── Changes ─────────────────────────────────────────────────────────────

type FileStat = { file: string; added: number; removed: number; isNew: boolean; symbols: string[]; edits: EditRecord[] }

function fileStats(edits: readonly EditRecord[]): FileStat[] {
  const byFile = new Map<string, FileStat>()
  for (const edit of edits) {
    const stat = byFile.get(edit.file) ?? { file: edit.file, added: 0, removed: 0, isNew: false, symbols: [], edits: [] }
    stat.added += edit.added
    stat.removed += edit.removed
    stat.isNew = stat.isNew || edit.kind === 'create'
    stat.symbols = [...new Set([...stat.symbols, ...edit.symbols])]
    stat.edits.push(edit)
    byFile.set(edit.file, stat)
  }
  return [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file))
}

function changesOverview($: EngineInterface, t: T, edits: readonly EditRecord[], turns: readonly Turn[], width: number): RenderNode {
  const { Box, Button, Text } = t
  if (edits.length === 0) {
    return empty(t, '±', 'No changes yet', 'Each file Claude edits appears here with the functions it touched and a highlighted diff. Replay walks through every edit in order.')
  }
  const files = fileStats(edits)
  const added = files.reduce((sum, file) => sum + file.added, 0)
  const removed = files.reduce((sum, file) => sum + file.removed, 0)
  const most = Math.max(1, ...files.map(file => file.added + file.removed))
  const turnIds = [...new Set(edits.map(edit => edit.turnId))].reverse()
  const barWidth = width >= 70 ? 12 : 8
  const pathWidth = Math.max(10, width - 3 - 7 - 7 - barWidth - 1)

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          <Text bold color={C.text}>
            {files.length} file{files.length === 1 ? '' : 's'} changed
          </Text>
          {'  '}
          {plusMinus(t, added, removed)}
        </Text>
        <Text color={C.soft}>
          {edits.length} edit{edits.length === 1 ? '' : 's'} · {turnIds.length} turn{turnIds.length === 1 ? '' : 's'}
        </Text>
      </Box>
      {section(t, 'FILES', width)}
      {files.map((stat, index) => {
        const bars = diffstat(stat.added, stat.removed, most, barWidth)
        return (
          <Box key={`cf-${index}`} flexDirection="column">
            <Box flexDirection="row">
              {cell(
                t,
                3,
                <Text bold color={stat.isNew ? C.ok : C.warn}>
                  {stat.isNew ? ' A' : ' M'}
                </Text>,
              )}
              {cell(t, pathWidth, <Button key={`cfile:${index}`} label={tail(stat.file, pathWidth - 1)} plain onPress={() => openFile($, stat.file)} />)}
              {cell(t, 7, <Text color={C.ok}>+{stat.added}</Text>, true)}
              {cell(t, 7, <Text color={stat.removed === 0 ? C.line : C.bad}>−{stat.removed}</Text>, true)}
              <Text> </Text>
              <Text>
                <Text color={C.ok}>{bars.plus}</Text>
                <Text color={C.bad}>{bars.minus}</Text>
              </Text>
            </Box>
            {stat.symbols.length > 0 && (
              <Text color={C.line} wrap="truncate-end">
                {'   '}ƒ {stat.symbols.join(' · ')}
              </Text>
            )}
          </Box>
        )
      })}
      {section(t, 'BY TURN', width, 'newest first')}
      {turnIds.map(turnId => {
        const inTurn = edits.filter(edit => edit.turnId === turnId)
        const turnFiles = new Set(inTurn.map(edit => edit.file)).size
        const prompt = turns.find(turn => turn.id === turnId)?.prompt ?? 'an earlier turn'
        const stats = `${turnFiles} file${turnFiles === 1 ? '' : 's'}`
        return (
          <Box key={`ct-${turnId}`} flexDirection="row">
            {cell(t, 5, <Button key={`cturn:${turnId}`} label={turnNumber(turns, turnId)} plain onPress={() => update($, changeEditAtom, () => inTurn[0]?.id ?? null)} />)}
            {cell(
              t,
              Math.max(8, width - 5 - 22),
              <Text italic color={C.soft} wrap="truncate-end">
                “{prompt}”
              </Text>,
            )}
            {cell(
              t,
              22,
              <Text>
                <Text color={C.soft}>{stats} </Text>
                {plusMinus(
                  t,
                  inTurn.reduce((sum, edit) => sum + edit.added, 0),
                  inTurn.reduce((sum, edit) => sum + edit.removed, 0),
                )}
              </Text>,
              true,
            )}
          </Box>
        )
      })}
      {footer(t, [{ key: 'replay', hotkey: 'r', label: 'replay every edit', onPress: () => update($, changeEditAtom, () => edits[0]?.id ?? null) }], width)}
    </Box>
  )
}

function topBar(t: T, back: Action, title: string, right: RenderNode, width: number): RenderNode {
  const { Box, Button, Text } = t
  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Box flexDirection="row" gap={1}>
        <Button key={back.key} label={back.label} hotkey={back.hotkey} plain dimColor onPress={back.onPress} />
        <Text bold color={C.text}>
          {tail(title, Math.max(10, width - 30))}
        </Text>
      </Box>
      {right}
    </Box>
  )
}

function diffBlock(t: T, diff: { text: string; isCut: boolean }, path: string, hint: string): RenderNode {
  const { Box, Code, Text } = t
  if (diff.text === '') return <Text dimColor> No line changes to show.</Text>
  return (
    <Box flexDirection="column">
      <Code key={`diff-${path}`} source={diff.text} format="diff" path={path} wrap="truncate-end" />
      {diff.isCut && <Text dimColor>… cut to fit: {hint}</Text>}
    </Box>
  )
}

function diffView($: EngineInterface, t: T, edits: readonly EditRecord[], edit: EditRecord, turns: readonly Turn[], width: number): RenderNode {
  const { Box, Text } = t
  const index = edits.findIndex(one => one.id === edit.id)
  const turn = turns.find(one => one.id === edit.turnId)
  const go = async (to: number): Promise<void> => {
    const target = edits[to]
    if (target !== undefined) await update($, changeEditAtom, () => target.id)
  }
  const diff = hunksText(edit.hunks)
  return (
    <Box flexDirection="column">
      {topBar(
        t,
        { key: 'diff-back', hotkey: 'b', label: '‹ back', onPress: () => update($, changeEditAtom, () => null) },
        edit.file,
        <Text color={C.soft}>
          edit {index + 1} of {edits.length}
        </Text>,
        width,
      )}
      <Box flexDirection="row" columnGap={1} flexWrap="wrap">
        <Text backgroundColor={C.chip} color={C.text}>
          {` ${edit.kind} `}
        </Text>
        {plusMinus(t, edit.added, edit.removed)}
        <Text color={C.soft} wrap="truncate-end">
          · {turnNumber(turns, edit.turnId)} “{head(turn?.prompt ?? '', 40)}”
        </Text>
      </Box>
      {edit.symbols.length > 0 && (
        <Text color={C.warn} wrap="truncate-end">
          ƒ {edit.symbols.join(' · ')}
        </Text>
      )}
      <Box marginTop={1}>{diffBlock(t, { text: diff.text, isCut: diff.isCut || edit.isCut }, edit.file, 'open the whole file for the full change')}</Box>
      {footer(
        t,
        [
          ...(index > 0 ? [{ key: 'diff-prev', hotkey: 'p', label: '‹ previous', onPress: () => go(index - 1) }] : []),
          ...(index < edits.length - 1 ? [{ key: 'diff-next', hotkey: 'n', label: 'next ›', onPress: () => go(index + 1) }] : []),
          { key: 'diff-file', hotkey: 'f', label: 'whole file', onPress: () => openFile($, edit.file) },
          { key: 'diff-preview', hotkey: 'v', label: 'preview', onPress: () => openPreview($, edit.file) },
        ],
        width,
      )}
    </Box>
  )
}

function fileView($: EngineInterface, t: T, file: string, summary: FileSummary | null, edits: readonly EditRecord[], turns: readonly Turn[], width: number): RenderNode {
  const { Box, Button, Text } = t
  const mine = edits.filter(edit => edit.file === file)
  const isNew = mine.some(edit => edit.kind === 'create')
  return (
    <Box flexDirection="column">
      {topBar(
        t,
        { key: 'file-back', hotkey: 'b', label: '‹ back', onPress: () => update($, changeFileAtom, () => null) },
        file,
        summary?.status === 'ready' ? (
          <Text>
            <Text bold color={isNew ? C.ok : C.warn}>
              {isNew ? 'A ' : 'M '}
            </Text>
            {plusMinus(t, summary.added, summary.removed)}
          </Text>
        ) : (
          <Text> </Text>
        ),
        width,
      )}
      {summary?.status === 'loading' && <Text color={C.live}>Comparing with the file as it was…</Text>}
      {summary?.status === 'error' && <Text color={C.bad}>{summary.error}</Text>}

      {section(t, 'FUNCTIONS', width, summary?.status === 'ready' ? String(summary.symbols.length) : '')}
      {summary?.status === 'ready' && summary.symbols.length === 0 && <Text dimColor> No function changed: imports, constants or top-level code.</Text>}
      {summary?.symbols.map((change, index) => (
        <Box key={`fs-${index}`} flexDirection="row">
          {cell(
            t,
            5,
            <Text color={CHANGE_MARK[change.change][1]}>
              {' '}
              {CHANGE_MARK[change.change][0]} {KIND_ICON_CODE[change.kind]}
            </Text>,
          )}
          {cell(
            t,
            Math.max(10, width - 5 - 18),
            change.change === 'removed' ? (
              <Text strikethrough dimColor>
                {change.name}
              </Text>
            ) : (
              <Button key={`fs-sym:${index}`} label={change.name} plain onPress={() => loadCalls($, change.name)} />
            ),
          )}
          {cell(
            t,
            18,
            <Text color={C.soft}>
              {change.change} · L{change.line}
            </Text>,
            true,
          )}
        </Box>
      ))}

      {section(t, 'EDITS', width, `${mine.length}, oldest first`)}
      {mine.map((edit, index) => (
        <Box key={`fe-${edit.id}`} flexDirection="row">
          {cell(t, 5, <Button key={`fe:${index}`} label={`#${index + 1}`} plain onPress={() => update($, changeEditAtom, () => edit.id)} />)}
          {cell(t, 4, <Text color={C.accent}>{turnNumber(turns, edit.turnId)}</Text>)}
          {cell(t, 12, plusMinus(t, edit.added, edit.removed))}
          <Text color={C.soft} wrap="truncate-end">
            {edit.symbols.length > 0 ? `ƒ ${edit.symbols.join(' · ')}` : edit.kind}
          </Text>
        </Box>
      ))}

      {section(t, 'DIFF', width, 'since Claude first touched it')}
      {summary?.status === 'ready' && <Box marginTop={1}>{diffBlock(t, { text: summary.diff, isCut: summary.isDiffCut }, file, 'step through the edits above for the rest')}</Box>}
      {footer(
        t,
        [
          { key: 'file-preview', hotkey: 'v', label: 'preview', onPress: () => openPreview($, file) },
          { key: 'file-components', hotkey: 'm', label: 'components', onPress: () => loadOutline($, file) },
        ],
        width,
      )}
    </Box>
  )
}

// ── Preview ─────────────────────────────────────────────────────────────

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
              <Text bold={rowIndex === 0} color={rowIndex === 0 ? C.live : rowIndex % 2 === 0 ? C.soft : C.text}>
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
    const color = { object: C.accent, array: C.accent, string: C.ok, number: C.warn, boolean: C.live, null: C.line } as const
    return (
      <Box flexDirection="column">
        {lines.map((line, index) => (
          <Box key={`json-${index}`} flexDirection="row">
            <Text color={C.line}>{'│ '.repeat(line.depth)}</Text>
            <Text color={C.blue}>{line.key}</Text>
            <Text color={C.line}>: </Text>
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
    return Svg === undefined ? <Code source={preview.text.slice(0, MAX_CODE_CHARS)} language="xml" wrap="truncate-end" /> : <Svg source={preview.text} alt={preview.path} />
  }
  const language = preview.kind === 'yaml' ? (preview.path.endsWith('.toml') ? 'toml' : 'yaml') : undefined
  return (
    <Box flexDirection="column">
      <Code source={preview.text.slice(0, MAX_CODE_CHARS)} path={preview.path} language={language} startLine={1} wrap="truncate-end" />
      {preview.text.length > MAX_CODE_CHARS && <Text dimColor>… showing the first {MAX_CODE_CHARS} characters</Text>}
    </Box>
  )
}

/** Files worth a quick switch: the latest edited and created ones, newest first. */
function recentFiles(edits: readonly EditRecord[], artifacts: readonly Artifact[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const path of [...edits.map(edit => edit.file).reverse(), ...artifacts.map(one => one.path)]) {
    if (seen.has(path)) continue
    seen.add(path)
    out.push(path)
  }
  return out.slice(0, 6)
}

function previewView(
  $: EngineInterface,
  t: T,
  table: Record<string, unknown>,
  surface: string,
  preview: Preview | null,
  isFollowing: boolean,
  recent: readonly string[],
  width: number,
): RenderNode {
  const { Box, Button, Text } = t
  const others = recent.filter(path => path !== preview?.path)
  const recentRow =
    others.length === 0 ? null : (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Text color={C.line}>recent</Text>
        {others.map((path, index) => (
          <Button key={`pv-recent:${index}`} label={path.split('/').pop() ?? path} plain dimColor onPress={() => openPreview($, path)} />
        ))}
      </Box>
    )
  if (preview === null) {
    return (
      <Box flexDirection="column">
        {empty(t, '◉', 'Nothing to preview yet', 'Files Claude edits open here as they change. Pick one in Changes or Artifacts, or run /wb preview <file>.')}
        {recentRow !== null && <Box marginTop={1}>{recentRow}</Box>}
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={C.text}>
          {tail(preview.path, Math.max(10, width - 28))}
        </Text>
        <Box flexDirection="row" columnGap={1}>
          <Text backgroundColor={C.chip} color={C.live}>
            {` ${preview.kind.toUpperCase()} `}
          </Text>
          <Text color={C.soft}>{bytes(preview.size)}</Text>
          <Text color={isFollowing ? C.ok : C.soft}>{isFollowing ? '● live' : '○ pinned'}</Text>
        </Box>
      </Box>
      {recentRow}
      {preview.note !== undefined && preview.kind !== 'image' && <Text color={C.warn}>{preview.note}</Text>}
      <Text color={C.line}>{'─'.repeat(width)}</Text>
      {preview.status === 'loading' && <Text color={C.live}>Rendering {preview.path}…</Text>}
      {preview.status === 'error' && <Text color={C.bad}>{preview.text}</Text>}
      {preview.status === 'ready' && previewBody(t, table, surface, preview, width)}
      {footer(
        t,
        [
          { key: 'pv-follow', hotkey: 'f', label: isFollowing ? 'pin this file' : 'follow edits', onPress: () => update($, followAtom, value => !value) },
          { key: 'pv-refresh', hotkey: 'r', label: 'refresh', onPress: () => openPreview($, preview.path) },
          {
            key: 'pv-copy',
            hotkey: 'c',
            label: 'copy path',
            onPress: async press => {
              const copied = await $.ui.copy({ text: absolute(preview.path, await rootOf($)), surface: press.surface })
              $.ui.toast(copied.isCopied ? 'Workbench: path copied.' : 'Workbench: could not copy here.')
            },
          },
          { key: 'pv-changes', hotkey: 'g', label: 'changes', onPress: () => openFile($, preview.path) },
        ],
        width,
      )}
    </Box>
  )
}

// ── Artifacts ───────────────────────────────────────────────────────────

function artifactsView($: EngineInterface, t: T, artifacts: readonly Artifact[], now: number, width: number): RenderNode {
  const { Box, Button, Text } = t
  const kinds = (['doc', 'image', 'data', 'web', 'code', 'other'] as const).filter(kind => artifacts.some(one => one.kind === kind))
  const total = artifacts.reduce((sum, one) => sum + one.size, 0)
  const pathWidth = Math.max(10, width - 2 - 9 - 9 - 3)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          <Text bold color={C.text}>
            {artifacts.length} new file{artifacts.length === 1 ? '' : 's'}
          </Text>
          <Text color={C.soft}> · {bytes(total)}</Text>
        </Text>
        <Text color={C.soft}>
          <Text color={C.accent}>✦</Text> written by Claude
        </Text>
      </Box>
      {artifacts.length === 0 && empty(t, '✦', 'No new files yet', 'Reports, images, data and code that Claude writes, or that its commands produce, collect here.')}
      {kinds.map(kind => {
        const inKind = artifacts.filter(one => one.kind === kind)
        return (
          <Box key={`ak-${kind}`} flexDirection="column">
            {section(t, KIND_LABEL[kind].toUpperCase(), width, String(inKind.length))}
            {inKind.map(one => {
              const index = artifacts.indexOf(one)
              return (
                <Box key={`art-${index}`} flexDirection="row">
                  {cell(t, 2, <Text color={C.accent}>{one.isByClaude ? '✦' : ' '}</Text>)}
                  {cell(t, pathWidth, <Button key={`art:${index}`} label={tail(one.path, pathWidth - 1)} plain onPress={() => openPreview($, one.path)} />)}
                  {cell(t, 9, <Text color={C.soft}>{bytes(one.size)}</Text>, true)}
                  {cell(t, 9, <Text color={C.line}>{ago(now - one.mtimeMs)}</Text>, true)}
                  {cell(
                    t,
                    3,
                    <Button
                      key={`art-copy:${index}`}
                      label="⧉"
                      plain
                      dimColor
                      onPress={async press => {
                        const copied = await $.ui.copy({ text: absolute(one.path, await rootOf($)), surface: press.surface })
                        $.ui.toast(copied.isCopied ? `Copied ${one.path}` : 'Workbench: could not copy here.')
                      }}
                    />,
                    true,
                  )}
                </Box>
              )
            })}
          </Box>
        )
      })}
      {footer(t, [{ key: 'art-refresh', hotkey: 'r', label: 'refresh', onPress: () => refreshArtifacts($) }], width)}
    </Box>
  )
}

// ── Code Map ────────────────────────────────────────────────────────────

function layerName(level: number, top: number): string {
  if (level === top && top > 0) return `LAYER ${level} · entry points`
  if (level === 0) return 'LAYER 0 · foundations'
  return `LAYER ${level}`
}

function mapGraphView($: EngineInterface, t: T, graph: Graph, edits: readonly EditRecord[], focus: string | null, width: number): RenderNode {
  const { Box, Button, Text } = t
  const editedFiles = new Set(edits.map(edit => edit.file))
  const edited = new Map<string, number>()
  for (const file of editedFiles) edited.set(groupOf(file), (edited.get(groupOf(file)) ?? 0) + 1)
  const levels = [...new Set(graph.groups.map(group => group.level))].sort((a, b) => b - a)
  const top = levels[0] ?? 0
  const most = Math.max(1, ...graph.groups.map(group => group.lines))
  const barWidth = width >= 70 ? 14 : 8
  const nameWidth = Math.max(10, width - 2 - (barWidth + 1) - 9 - 8 - 5)
  const names = (list: readonly string[]): string => (list.length === 0 ? 'nothing in the repo' : list.join(', '))

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={C.soft}>
          {graph.files} files · {graph.groups.length} folders · {graph.isGit ? 'git' : 'folder mode (no git)'}
          {graph.isTruncated ? ' · largest shown' : ''}
        </Text>
        <Text color={C.warn}>✎ edited</Text>
      </Box>
      {levels.map(level => (
        <Box key={`lv-${level}`} flexDirection="column">
          {section(t, layerName(level, top), width)}
          {graph.groups
            .filter(group => group.level === level)
            .map(group => {
              const count = edited.get(group.id)
              const isFocused = group.id === focus
              const cells = Math.max(1, Math.round((group.lines / most) * barWidth))
              const outgoing = graph.edges.filter(edge => edge.from === group.id).map(edge => `${edge.to} (${edge.count})`)
              const incoming = graph.edges.filter(edge => edge.to === group.id).map(edge => `${edge.from} (${edge.count})`)
              return (
                <Box key={`grp-${group.id}`} flexDirection="column">
                  <Box flexDirection="row">
                    {cell(t, 2, <Text color={isFocused ? C.accent : C.line}>{isFocused ? '▾' : '▸'}</Text>)}
                    {cell(
                      t,
                      nameWidth,
                      <Button key={`g:${group.id}`} label={tail(group.id, nameWidth - 1)} plain onPress={() => update($, mapFocusAtom, now => (now === group.id ? null : group.id))} />,
                    )}
                    {cell(t, barWidth + 1, <Text color={count === undefined ? C.accent : C.warn}>{'▮'.repeat(cells)}</Text>)}
                    {cell(t, 9, <Text color={C.soft}>{group.files} file{group.files === 1 ? '' : 's'}</Text>, true)}
                    {cell(t, 8, <Text color={C.line}>{shortCount(group.lines)} ln</Text>, true)}
                    {cell(t, 5, <Text color={C.warn}>{count === undefined ? '' : `✎${count}`}</Text>, true)}
                  </Box>
                  {isFocused && (
                    <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
                      <Text color={C.soft} wrap="truncate-end">
                        <Text color={C.ok}>→ imports </Text>
                        {names(outgoing)}
                      </Text>
                      <Text color={C.soft} wrap="truncate-end">
                        <Text color={C.blue}>← used by </Text>
                        {names(incoming)}
                      </Text>
                      <Text color={C.soft}>
                        {group.symbols} functions and classes{group.files > group.paths.length ? ` · first ${group.paths.length} files` : ''}
                      </Text>
                      {group.paths.map((file, index) => (
                        <Box key={`mfr-${index}`} flexDirection="row">
                          {cell(t, 2, <Text color={C.warn}>{editedFiles.has(file) ? '✎' : ' '}</Text>)}
                          <Button key={`mf:${group.id}:${index}`} label={file.slice(group.id === '.' ? 0 : group.id.length + 1) || file} plain dimColor={!editedFiles.has(file)} onPress={() => loadOutline($, file)} />
                        </Box>
                      ))}
                    </Box>
                  )}
                </Box>
              )
            })}
        </Box>
      ))}
    </Box>
  )
}

function componentsView($: EngineInterface, t: T, outline: Outline | null, width: number): RenderNode {
  const { Box, Button, Text } = t
  if (outline === null) return empty(t, 'ƒ', 'No file open', 'Pick a file in Changes, or a file under a folder in Architecture, to see its classes and functions and what each calls.')
  if (outline.status === 'loading') return <Text color={C.live}>Reading {outline.file}…</Text>
  if (outline.status === 'error') return <Text color={C.bad}>{outline.error}</Text>
  const changed = outline.entries.filter(entry => entry.isChanged).length
  const longest = Math.max(1, ...outline.entries.map(entry => entry.endLine - entry.line + 1))
  const barWidth = width >= 70 ? 12 : 6
  const nameWidth = Math.max(10, width - 12 - barWidth - 3)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={C.text}>
          {tail(outline.file, Math.max(10, width - 30))}
        </Text>
        <Text color={C.soft}>
          {outline.lines} lines · {outline.entries.length} parts{changed > 0 ? ' · ' : ''}
          {changed > 0 && <Text color={C.warn}>{changed} changed</Text>}
        </Text>
      </Box>
      {outline.entries.length === 0 && <Text dimColor> No classes or functions found in this file.</Text>}
      <Box flexDirection="column" marginTop={1}>
        {outline.entries.map((entry, index) => {
          const size = entry.endLine - entry.line + 1
          const indent = '  '.repeat(entry.depth)
          const color = entry.isChanged ? C.warn : entry.kind === 'class' ? C.accent : C.live
          return (
            <Box key={`oe-${index}`} flexDirection="column">
              <Box flexDirection="row">
                {cell(
                  t,
                  nameWidth,
                  <Box flexDirection="row">
                    <Text color={color}>
                      {indent}
                      {KIND_ICON_CODE[entry.kind]}{' '}
                    </Text>
                    {entry.kind === 'class' ? (
                      <Text bold color={C.text}>
                        {entry.name}
                      </Text>
                    ) : (
                      <Button key={`oc:${index}`} label={entry.name} plain onPress={() => loadCalls($, entry.name)} />
                    )}
                  </Box>,
                )}
                {cell(
                  t,
                  12,
                  <Text color={C.line}>
                    L{entry.line}–{entry.endLine}
                  </Text>,
                )}
                {cell(t, barWidth + 1, <Text color={entry.isChanged ? C.warn : C.chip}>{'▮'.repeat(Math.max(1, Math.round((size / longest) * barWidth)))}</Text>)}
                {cell(t, 2, <Text color={C.warn}>{entry.isChanged ? '●' : ''}</Text>)}
              </Box>
              {entry.calls.length > 0 && (
                <Text color={C.line} wrap="truncate-end">
                  {indent}
                  {'    '}→ {entry.calls.join(', ')}
                </Text>
              )}
            </Box>
          )
        })}
      </Box>
      {changed > 0 && (
        <Text color={C.line}>
          <Text color={C.warn}>●</Text> changed this session
        </Text>
      )}
    </Box>
  )
}

function callsView($: EngineInterface, t: T, call: CallView | null, trail: readonly string[], ask: RenderNode | null, width: number): RenderNode {
  const { Box, Button, Text } = t
  const previous = call === null ? undefined : trail[trail.indexOf(call.symbol) - 1]
  const site = (one: Site, key: string, arrow: string, color: string): RenderNode => (
    <Box key={`row-${key}`} flexDirection="row">
      {cell(t, 3, <Text color={color}>{arrow}</Text>)}
      {cell(
        t,
        Math.max(10, Math.floor((width - 3) / 2)),
        one.isKnown ? (
          <Button key={key} label={one.symbol} plain onPress={() => loadCalls($, one.symbol)} />
        ) : (
          <Text color={C.line} wrap="truncate-end">
            {one.symbol}
          </Text>
        ),
      )}
      <Text color={C.line} wrap="truncate-start">
        {one.file === '' ? 'outside the repo' : `${one.file}:${one.line}`}
      </Text>
    </Box>
  )
  return (
    <Box flexDirection="column">
      {ask}
      <Box flexDirection="row" columnGap={2}>
        <Button
          key="calls-selection"
          label="trace my selection"
          hotkey="s"
          plain
          dimColor
          onPress={async () => {
            const selected = await $.ui.selection()
            const symbol = selected === undefined ? null : symbolFromSelection(selected.text)
            if (symbol === null) $.ui.toast('Workbench: select a function name in the transcript first.')
            else await loadCalls($, symbol)
          }}
        />
        {previous !== undefined && <Button key="calls-back" label={`‹ ${previous}`} hotkey="b" plain dimColor onPress={() => loadCalls($, previous, true)} />}
      </Box>
      {call === null && empty(t, 'ƒ', 'Trace a function', 'Type a function or class name above, select one in the transcript, or click a function in Changes or Components.')}
      {call?.status === 'loading' && <Text color={C.live}>Tracing {call.symbol}…</Text>}
      {(call?.status === 'error' || call?.status === 'missing') && <Text color={C.bad}>{call.status === 'missing' ? `No definition or calls of ${call.symbol} found.` : call.error}</Text>}
      {call?.status === 'ready' && (
        <Box flexDirection="column" marginTop={1}>
          {trail.length > 1 && (
            <Text color={C.line} wrap="truncate-start">
              {trail.join(' › ')}
            </Text>
          )}
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold color={C.live}>
              ƒ {call.symbol}
            </Text>
            <Text color={C.soft}>{call.definition === undefined ? 'definition not found' : `${call.definition.file}:${call.definition.line}`}</Text>
          </Box>
          {section(t, 'CALLED BY', width, String(call.callers.length))}
          {call.callers.length === 0 && <Text dimColor> No callers found.</Text>}
          {call.callers.map((one, index) => site(one, `caller:${index}`, '←', C.blue))}
          {section(t, 'CALLS', width, `${call.callees.filter(one => one.isKnown).length} in the repo`)}
          {call.callees.length === 0 && <Text dimColor> Calls nothing.</Text>}
          {call.callees.map((one, index) => site(one, `callee:${index}`, '→', C.ok))}
        </Box>
      )}
    </Box>
  )
}

// ── Usage ───────────────────────────────────────────────────────────────

function usageView(t: T, limits: readonly Limit[], reading: Reading | null, history: readonly number[], turns: readonly Turn[], costUsd: number | null, now: number, width: number): RenderNode {
  const { Box, Text } = t
  const barWidth = clamp(width - 8 - 6 - 22, 8, 32)
  const costed = turns.filter(turn => turn.costUsd !== undefined || turn.outputTokens !== undefined).slice(-12)
  const maxCost = Math.max(0.0001, ...costed.map(turn => turn.costUsd ?? 0))
  const maxTokens = Math.max(1, ...costed.map(turn => (turn.inputTokens ?? 0) + (turn.outputTokens ?? 0)))
  return (
    <Box flexDirection="column">
      {section(t, 'PLAN LIMITS', width)}
      {limits.length === 0 && <Text dimColor> No reading yet: limits appear after a reply on a Claude subscription.</Text>}
      {limits.map(limit => {
        const view = viewOf(limit, now)
        const filled = meter(view.percent, barWidth)
        const color = hue(view.color)
        const reset = limit.resetsAt === undefined ? Number.NaN : Date.parse(limit.resetsAt)
        const windowMs = limit.kind === 'five_hour' ? 5 * 3_600_000 : limit.kind === 'seven_day' ? 7 * 86_400_000 : 0
        const elapsed = Number.isNaN(reset) || windowMs === 0 ? 0 : now - (reset - windowMs)
        const projected = elapsed > 5 * 60_000 ? Math.round((limit.percentUsed / elapsed) * windowMs) : undefined
        return (
          <Box key={`ul-${limit.kind}`} flexDirection="column">
            <Box flexDirection="row">
              {cell(
                t,
                8,
                <Text bold color={C.text}>
                  {view.label}
                </Text>,
              )}
              <Text>
                <Text color={color}>{filled.used}</Text>
                <Text color={C.chip}>{filled.left}</Text>
              </Text>
              {cell(
                t,
                6,
                <Text bold color={color}>
                  {Math.round(view.percent)}%
                </Text>,
                true,
              )}
              <Text color={C.soft} wrap="truncate-end">
                {view.resetIn === undefined ? '' : `  ↻ ${view.resetIn} · ${view.resetAt}`}
              </Text>
            </Box>
            {(projected !== undefined || view.runsOutIn !== undefined) && (
              <Box paddingLeft={8}>
                {view.runsOutIn !== undefined ? (
                  <Text color={view.percent >= 70 ? C.bad : C.warn} wrap="truncate-end">
                    ⚠ runs out in {view.runsOutIn} at this pace{projected === undefined ? '' : ` (on pace for ${projected}%)`}
                  </Text>
                ) : (
                  <Text color={C.line} wrap="truncate-end">
                    on pace for {projected}% by the reset
                  </Text>
                )}
              </Box>
            )}
          </Box>
        )
      })}

      {section(t, 'CONTEXT WINDOW', width)}
      {reading === null ? (
        <Text dimColor> No reading yet.</Text>
      ) : (
        <Box flexDirection="column">
          <Box flexDirection="row">
            {cell(
              t,
              8,
              <Text bold color={hue(sky(reading.percent).color)}>
                {sky(reading.percent).icon} {sky(reading.percent).label}
              </Text>,
            )}
            <Text>
              <Text color={hue(sky(reading.percent).color)}>{meter(reading.percent, barWidth).used}</Text>
              <Text color={C.chip}>{meter(reading.percent, barWidth).left}</Text>
            </Text>
            {cell(
              t,
              6,
              <Text bold color={hue(sky(reading.percent).color)}>
                {reading.percent}%
              </Text>,
              true,
            )}
            <Text color={C.soft}>
              {'  '}
              {kilo(reading.tokens)} / {kilo(reading.window)}
            </Text>
          </Box>
          <Box paddingLeft={8} flexDirection="row" columnGap={1}>
            <Text color={C.live}>{sparkline(history)}</Text>
            <Text color={C.line} wrap="truncate-end">
              {outlook(history, reading)}
              {sky(reading.percent).advice === undefined ? '' : ` · ${sky(reading.percent).advice}`}
            </Text>
          </Box>
        </Box>
      )}

      {section(t, 'COST PER TURN', width, costUsd === null ? 'tokens only' : `$${costUsd.toFixed(2)} this session`)}
      {costed.length === 0 && <Text dimColor> Turns appear here as they finish.</Text>}
      {costed.map((turn, index) => {
        const value = turn.costUsd ?? 0
        const tokens = (turn.inputTokens ?? 0) + (turn.outputTokens ?? 0)
        const share = turn.costUsd === undefined ? tokens / maxTokens : value / maxCost
        return (
          <Box key={`uc-${turn.id}`} flexDirection="row">
            {cell(t, 5, <Text color={C.soft}>T{turns.indexOf(turn) + 1}</Text>)}
            {cell(t, barWidth + 1, <Text color={index === costed.length - 1 ? C.live : C.accent}>{'▮'.repeat(Math.max(1, Math.round(share * barWidth)))}</Text>)}
            {cell(t, 8, <Text color={C.text}>{turn.costUsd === undefined ? '' : `$${value.toFixed(3)}`}</Text>, true)}
            <Text color={C.line} wrap="truncate-end">
              {'  '}
              {kilo(turn.inputTokens ?? 0)} in · {kilo(turn.outputTokens ?? 0)} out
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
  else if (word === 'forecast' || word === 'workbench') {
    await update($, slideAtom, () => word)
    await update($, hudHiddenAtom, () => false)
  }
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
    const turn: Turn = { id: e.turnId, prompt: promptLabel(e.text), startedAt: now, status: 'running', steps: [], lanes: [{ id: 'main', label: 'Main' }] }
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
    // Cached reads and writes are input too: without them a turn reads as a handful of tokens.
    const inputTokens =
      e.usage === undefined ? undefined : (e.usage.input_tokens ?? 0) + (e.usage.cache_creation_input_tokens ?? 0) + (e.usage.cache_read_input_tokens ?? 0)
    await update($, turnsAtom, list =>
      onNewest(list, endedAt, turn => ({ ...turn, endedAt, status, inputTokens, outputTokens: e.usage?.output_tokens, costUsd })),
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
      await update($, baselinesAtom, (): Baselines => ({}))
    }
    return next(e)
  })

  on('command.run', { command: 'wb' }, async ($, e) => {
    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true, columns: PANE_COLUMNS })
    if (!opened.isPlaced) $.ui.toast(`Workbench is waiting for room: ${opened.reason}`)
    else if (!hasHinted) {
      hasHinted = true
      $.ui.toast("Workbench is open. If Claude Code's diff panel covers it, run /diff to hide that panel.")
    }
    await openTab($, e.args)
    if ((await read($, tabAtom)) === 'artifacts') await refreshArtifacts($)

    return {}
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Other mods draw in this band too. The Forecast slide shows theirs when there is one, so ◀ moves to it.
    const below = await next(e)
    if (e.props.hasSurvey || (await read($, hudHiddenAtom))) return below
    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const limits = await read($, limitsAtom)
    const reading = await read($, readingAtom)
    const history = await read($, historyAtom)
    const turns = await read($, turnsAtom)
    const edits = await read($, editsAtom)
    const artifacts = await read($, artifactsAtom)
    const startedAt = await read($, startedAtAtom)
    const slide = await read($, slideAtom)
    const isBelowDrawn = hasContent(below)
    if (limits.length === 0 && reading === null && turns.length === 0 && !isBelowDrawn) return below

    const columns = e.props.bodyColumns
    const isForecast = slide === 'forecast'
    const sep = <Text color={C.line}> · </Text>

    const nav = (
      <Box flexDirection="row" columnGap={1}>
        <Button key="hud-left" label="◀" plain dimColor={isForecast} onPress={() => update($, slideAtom, () => 'forecast')} />
        <Text bold color={C.accent}>
          {isForecast ? 'Forecast' : 'Workbench'}
        </Text>
        <Text color={C.line}>{isForecast ? '●○' : '○●'}</Text>
        <Button key="hud-right" label="▶" plain dimColor={!isForecast} onPress={() => update($, slideAtom, () => 'workbench')} />
      </Box>
    )
    // The engine draws its own collapse mark at the band's right edge: keep clear of it.
    const controls = (
      <Box flexDirection="row" columnGap={2} marginRight={4}>
        <Button
          key="hud-open"
          label="open ▸"
          plain
          dimColor
          onPress={async () => {
            const isRunning = (await read($, turnsAtom)).at(-1)?.steps.some(step => step.status === 'running') ?? false
            const target: Tab = isForecast ? 'usage' : isRunning ? 'now' : (await read($, editsAtom)).length > 0 ? 'changes' : 'now'
            await update($, tabAtom, () => target)
            await $.ui.open({ id: PANE, title: TITLE, focus: true, columns: PANE_COLUMNS })
          }}
        />
        <Button key="hud-hide" label="✕" plain dimColor onPress={() => update($, hudHiddenAtom, () => true)} />
      </Box>
    )
    const topRow = (content: RenderNode | null): RenderNode => (
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" columnGap={2} flexWrap="wrap" flexShrink={1}>
          {nav}
          {content}
        </Box>
        {controls}
      </Box>
    )

    if (isForecast) {
      if (isBelowDrawn) {
        return (
          <Box flexDirection="column">
            {topRow(null)}
            {below}
          </Box>
        )
      }
      const barWidth = columns >= 120 ? 18 : 10
      return (
        <Box flexDirection="column">
          {topRow(null)}
          {limits.length === 0 && reading === null && <Text color={C.soft}> No plan or context reading yet: it appears after the first reply.</Text>}
          {limits.map(limit => {
            const view = viewOf(limit, now)
            const gauge = meter(view.percent, barWidth)
            return (
              <Box key={`fc-${limit.kind}`} flexDirection="row" columnGap={1}>
                <Box width={8} flexShrink={0}>
                  <Text bold>{view.label}</Text>
                </Box>
                <Text>
                  <Text color={hue(view.color)}>{gauge.used}</Text>
                  <Text color={C.chip}>{gauge.left}</Text>
                </Text>
                <Box width={5} flexShrink={0} justifyContent="flex-end">
                  <Text bold color={hue(view.color)}>
                    {Math.round(view.percent)}%
                  </Text>
                </Box>
                {view.resetIn !== undefined && (
                  <Text color={C.soft} wrap="truncate-end">
                    ↻ resets in {view.resetIn} · {view.resetAt}
                  </Text>
                )}
                {view.runsOutIn !== undefined && (
                  <Text color={view.percent >= 70 ? C.bad : C.warn} wrap="truncate-end">
                    ⚠ at this pace, out in {view.runsOutIn}
                  </Text>
                )}
              </Box>
            )
          })}
          {reading !== null && (
            <Box flexDirection="row" columnGap={1}>
              <Box width={8} flexShrink={0}>
                <Text bold>Context</Text>
              </Box>
              <Text bold color={hue(sky(reading.percent).color)}>
                {sky(reading.percent).icon} {sky(reading.percent).label}
              </Text>
              <Text>
                {reading.percent}% <Text color={C.soft}>({kilo(reading.tokens)}/{kilo(reading.window)})</Text>
              </Text>
              <Text color={C.live}>{sparkline(history)}</Text>
              <Text color={C.soft} wrap="truncate-end">
                {outlook(history, reading)}
                {sky(reading.percent).advice === undefined ? '' : ` · ${sky(reading.percent).advice}`}
              </Text>
            </Box>
          )}
        </Box>
      )
    }

    const tools = turns.reduce((sum, turn) => sum + turn.steps.length, 0)
    const files = new Set(edits.map(edit => edit.file)).size
    const added = edits.reduce((sum, edit) => sum + edit.added, 0)
    const removed = edits.reduce((sum, edit) => sum + edit.removed, 0)
    const running = turns.at(-1)?.steps.findLast(step => step.status === 'running')
    const last = edits.at(-1)
    const gaugeWidth = columns >= 140 ? 6 : 4

    const metrics = (
      <Box flexDirection="row" flexWrap="wrap">
        <Text>
          <Text color={C.soft}>⏱ </Text>
          <Text bold color={C.text}>
            {startedAt > 0 ? duration(now - startedAt) : '–'}
          </Text>
          <Text color={C.soft}> · {tools} tools</Text>
        </Text>
        {sep}
        <Text>
          <Text color={C.warn}>✎ </Text>
          <Text bold color={C.text}>
            {files}
          </Text>
          <Text color={C.soft}> file{files === 1 ? '' : 's'} </Text>
          <Text color={C.ok}>+{added}</Text> <Text color={C.bad}>−{removed}</Text>
        </Text>
        {artifacts.length > 0 && (
          <Text>
            <Text color={C.line}> · </Text>
            <Text color={C.accent}>✦ </Text>
            <Text bold color={C.text}>
              {artifacts.length}
            </Text>
            <Text color={C.soft}> new</Text>
          </Text>
        )}
        {(columns >= 110 ? limits.slice(0, 2) : []).map(limit => {
          const view = viewOf(limit, now)
          const gauge = pill(view.percent, gaugeWidth)
          return (
            <Box key={`hud-${limit.kind}`} flexDirection="row">
              {sep}
              <Text color={C.soft}>{limit.kind === 'five_hour' ? '5h ' : limit.kind === 'seven_day' ? 'wk ' : `${view.label} `}</Text>
              <Text color={hue(view.color)}>{gauge.used}</Text>
              <Text color={C.chip}>{gauge.left}</Text>
              <Text bold color={hue(view.color)}>
                {' '}
                {Math.round(view.percent)}%
              </Text>
              {view.runsOutIn !== undefined && <Text color={C.bad}> ⚠</Text>}
            </Box>
          )
        })}
        {reading !== null && (
          <Box flexDirection="row">
            {sep}
            <Text color={C.soft}>ctx </Text>
            <Text bold color={hue(sky(reading.percent).color)}>
              {reading.percent}%
            </Text>
          </Box>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {topRow(metrics)}
        {running !== undefined ? (
          <Box flexDirection="row" columnGap={1}>
            <Text color={C.live}>●</Text>
            <Text bold color={C.live}>
              {running.tool}
            </Text>
            <Text color={C.soft} wrap="truncate-end">
              {head(running.summary, Math.max(10, columns - 30))}
            </Text>
            <Text color={C.live}>{seconds(now - running.startedAt)}</Text>
          </Box>
        ) : last !== undefined ? (
          <Box flexDirection="row" columnGap={1}>
            <Text color={C.line}>last edit</Text>
            <Text bold color={C.text}>
              {tail(last.file, Math.max(10, columns - 50))}
            </Text>
            <Text>
              <Text color={C.ok}>+{last.added}</Text> <Text color={C.bad}>−{last.removed}</Text>
            </Text>
            {last.symbols.length > 0 && (
              <Text color={C.warn} wrap="truncate-end">
                ƒ {last.symbols.join(' · ')}
              </Text>
            )}
          </Box>
        ) : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const t: T = table
    const { Box, Button, Text } = t
    const tab = await read($, tabAtom)
    const now = await $.clock.now()
    const width = Math.max(30, e.props.bodyColumns)
    const turns = await read($, turnsAtom)
    const edits = await read($, editsAtom)
    const artifacts = await read($, artifactsAtom)

    let body: RenderNode
    if (tab === 'now') {
      body = nowView($, t, turns, await read($, turnBackAtom), await read($, showOutputsAtom), now, width)
    } else if (tab === 'changes') {
      const editId = await read($, changeEditAtom)
      const file = await read($, changeFileAtom)
      const edit = edits.find(one => one.id === editId)
      body =
        edit !== undefined ? diffView($, t, edits, edit, turns, width)
        : file !== null ? fileView($, t, file, await read($, fileSummaryAtom), edits, turns, width)
        : changesOverview($, t, edits, turns, width)
    } else if (tab === 'preview') {
      body = previewView($, t, table as unknown as Record<string, unknown>, e.surface, await read($, previewAtom), await read($, followAtom), recentFiles(edits, artifacts), width)
    } else if (tab === 'artifacts') {
      body = artifactsView($, t, artifacts, now, width)
    } else if (tab === 'map') {
      const view = await read($, mapViewAtom)
      const status = await read($, scanStatusAtom)
      const graph = await read($, graphAtom)
      const ask =
        e.surface !== 'mobile' && 'Input' in table ? (
          <table.Input key="calls-symbol" label="Function" placeholder="name of a function or class" submitLabel="trace" onSubmit={value => void loadCalls($, value)} />
        ) : null
      const inner =
        view === 'components' ? componentsView($, t, await read($, outlineAtom), width)
        : view === 'calls' ? callsView($, t, await read($, callAtom), await read($, trailAtom), ask, width)
        : status === 'scanning' ? <Text color={C.live}>Scanning the code…</Text>
        : status === 'error' ? <Text color={C.bad}>Scan failed: {await read($, scanErrorAtom)}</Text>
        : status === 'no-folder' ? <Text color={C.bad}>Workbench could not tell which folder to read.</Text>
        : graph === null ? <Text dimColor>Starting the first scan…</Text>
        : mapGraphView($, t, graph, edits, await read($, mapFocusAtom), width)
      const views = [
        { view: 'map', label: 'Architecture', hotkey: 'a' },
        { view: 'components', label: 'Components', hotkey: 'm' },
        { view: 'calls', label: 'Calls', hotkey: 'k' },
      ] as const
      body = (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
            <Box flexDirection="row" columnGap={1}>
              {views.map(one =>
                one.view === view ? (
                  <Text key={`mv-on:${one.view}`} backgroundColor={C.chip} color={C.text} bold>
                    {` ${one.label} `}
                  </Text>
                ) : (
                  <Button key={`mv:${one.view}`} label={` ${one.label} `} plain dimColor onPress={() => update($, mapViewAtom, () => one.view)} />
                ),
              )}
            </Box>
            <Button key="mv-rescan" label="↻ rescan" plain dimColor onPress={() => scan($)} />
          </Box>
          {inner}
        </Box>
      )
    } else {
      body = usageView(t, await read($, limitsAtom), await read($, readingAtom), await read($, historyAtom), turns, await read($, costAtom), now, width)
    }

    // Header: the name, and what Claude is doing right now.
    const running = turns.at(-1)?.steps.findLast(step => step.status === 'running')
    const latest = turns.at(-1)
    const activity =
      running !== undefined ? (
        <Text color={C.live} wrap="truncate-end">
          ● {running.tool} {head(running.summary, 18)} {seconds(now - running.startedAt)}
        </Text>
      ) : latest?.status === 'running' ? (
        <Text color={C.live}>● thinking {seconds(now - latest.startedAt)}</Text>
      ) : latest !== undefined ? (
        <Text color={C.soft}>✓ idle · {turns.length} turn{turns.length === 1 ? '' : 's'}</Text>
      ) : (
        <Text color={C.soft}>○ waiting</Text>
      )

    // Tabs: the open one a filled pill, the rest plain buttons; counts while there is room.
    const files = new Set(edits.map(edit => edit.file)).size
    const showCounts = width >= 58
    const badge = (one: Tab): string =>
      !showCounts ? ''
      : one === 'changes' && files > 0 ? ` ${files}`
      : one === 'artifacts' && artifacts.length > 0 ? ` ${artifacts.length}`
      : one === 'now' && running !== undefined ? ' ●'
      : ''

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" paddingRight={3}>
          <Text bold color={C.accent}>
            ◆ Workbench
          </Text>
          {activity}
        </Box>
        <Box flexDirection="row" columnGap={1} marginTop={1}>
          {TABS.map(one => {
            const label = ` ${one.label}${badge(one.tab)} `
            return one.tab === tab ? (
              <Text key={`tab-on:${one.tab}`} backgroundColor={C.accent} color={C.ink} bold>
                {label}
              </Text>
            ) : (
              <Button
                key={`tab:${one.tab}`}
                label={label}
                plain
                dimColor
                onPress={async () => {
                  await update($, tabAtom, () => one.tab)
                  if (one.tab === 'artifacts') await refreshArtifacts($)
                }}
              />
            )
          })}
        </Box>
        <Text color={C.line}>{'─'.repeat(width)}</Text>
        {body}
      </Box>
    )
  })
}
