import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'

import { jsonTree, parseCsv, previewKind } from '../hooks/files'
import { sideBySide } from '../hooks/sidebyside'

const ROOT = '/proj'
const NOW = Date.parse('2026-10-05T10:00:00Z')
const HOUR = 3_600_000

const HEAD_TOOLS = 'from app.core.database import get_session\n\n\ndef execute_sql(sql):\n    session = get_session()\n    return session.run(sql)\n'
const NEW_TOOLS =
  'from app.core.database import get_session\n\n\ndef execute_sql(sql):\n    session = get_session()\n    return retry(lambda: session.run(sql))\n\n\ndef retry(action):\n    return action()\n'
const TOOLS_HUNK = {
  oldStart: 6,
  oldLines: 1,
  newStart: 6,
  newLines: 5,
  lines: ['-    return session.run(sql)', '+    return retry(lambda: session.run(sql))', '+', '+', '+def retry(action):', '+    return action()'],
}

const START_FILES: Record<string, string> = {
  'app/run_poc.py': 'from app.services.sql_agent import run_query\n\n\ndef main():\n    print(run_query("hi"))\n',
  'app/services/sql_agent.py':
    'from app.core.config import settings\nfrom .tools import execute_sql\n\n\ndef build(question):\n    return f"SELECT {question}"\n\n\ndef run_query(question):\n    return execute_sql(build(question))\n',
  'app/services/tools.py': HEAD_TOOLS,
  'app/core/config.py': 'class Settings:\n    debug = False\n\n\nsettings = Settings()\n',
  'app/core/database.py': 'def get_session():\n    return object()\n',
  'data.csv': 'name,latency_ms,ok\nsearch,120,true\n"agent, sql",340,false\n',
  'config.json': '{"model": "sonnet", "retries": 3, "tags": ["a", "b"], "nested": {"on": true}}',
  'notes.md': '# Notes\n\n- one\n- two\n',
  'page.html': '<html><head><title>Report</title></head><body><h1>Latency</h1><a href="https://x.test">x</a></body></html>',
  'li/pyvenv.cfg': 'home = /usr/bin',
  'li/lib/site.py': 'def hidden():\n    pass\n',
}

type Disk = Map<string, { text: string; mtimeMs: number }>
type Seen = { copied: string[]; screenshots: string[]; reads: string[] }

const PANE = {
  plugin: 'workbench',
  component: 'Pane',
  requestId: 'workbench',
  props: { title: 'Workbench', isFocused: true, bodyColumns: 140, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const
const HUD = {
  plugin: 'workbench',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 160, scroll: { offset: 0, bodyRows: 6 }, view: {} },
} as const
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as const
const USAGE_TOKENS = { model: 'm', input_tokens: 12000, output_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

function listing(disk: Disk, dir: string) {
  const prefix = dir === ROOT ? '' : `${dir.slice(ROOT.length + 1)}/`
  const entries = new Map<string, { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: boolean }>()
  for (const [path, file] of disk) {
    if (!path.startsWith(prefix)) continue
    const [name = '', ...deeper] = path.slice(prefix.length).split('/')
    entries.set(name, deeper.length > 0 ? { name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false } : { name, kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs, isLink: false })
  }
  return [...entries.values()]
}

function engineBeneath(on: On, bandBelow = 'another mod band'): { clock: MockClock; disk: Disk; seen: Seen; spend: { usd: number } } {
  const disk: Disk = new Map(Object.entries(START_FILES).map(([path, text]) => [path, { text, mtimeMs: 1 }]))
  const seen: Seen = { copied: [], screenshots: [], reads: [] }
  const spend = { usd: 0.5 }
  const clock = mock.clock(on, { now: NOW })
  const rel = (path: string): string => path.replace(`${ROOT}/`, '')
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'wb' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.copy', (_$, e) => {
    seen.copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('process.run', (_$, e) => {
    const [bin = '', ...args] = e.argv
    const done = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (bin === 'git') return done(128)
    if (bin === 'chromium' && args[0] === '--version') return done(0, 'Chromium 140')
    if (bin === 'chromium') {
      seen.screenshots.push(e.argv.join(' '))
      return done(0)
    }
    throw new Error(`not installed: ${bin}`)
  })
  on('fs.list', (_$, e) => ({ value: listing(disk, e.path) }))
  on('fs.read', (_$, e) => {
    seen.reads.push(e.path)
    return { value: disk.get(rel(e.path))?.text ?? '' }
  })
  on('fs.stat', (_$, e) => ({ value: { kind: 'file', size: disk.get(rel(e.path))?.text.length ?? 0, mtimeMs: 1, isLink: false } }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW - 12 * 60_000,
      context: { percent: 40, tokens: 80000, window: 200000 },
      cost: { usd: spend.usd },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 75, resetsAt: new Date(NOW + 2 * HOUR).toISOString() },
        { kind: 'seven_day', percentUsed: 28, resetsAt: new Date(NOW + 76 * HOUR).toISOString() },
      ],
    },
  }))
  on('agent.list', () => ({ value: [] }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', () => ({ type: 'Box', children: bandBelow === '' ? [] : [{ type: 'Text', children: [bandBelow] }] }))
  on('tool.call', async (_$, e) => {
    if (e.tool === 'Bash') {
      await clock.advance(12_000)
      if (e.command.includes('plot')) disk.set('latency.png', { text: 'PNG', mtimeMs: 5 })
      return { result: { stdout: 'ok', stderr: '', interrupted: false } as never, text: 'ok\n2 passed' }
    }
    if (e.tool === 'Edit') {
      disk.set('app/services/tools.py', { text: NEW_TOOLS, mtimeMs: 2 })
      return {
        result: { filePath: e.file_path, oldString: e.old_string, newString: e.new_string, originalFile: HEAD_TOOLS, structuredPatch: [TOOLS_HUNK], userModified: false, replaceAll: false },
        text: 'updated',
      }
    }
    if (e.tool === 'Write') {
      disk.set(rel(e.file_path), { text: e.content, mtimeMs: 3 })
      return { result: { type: 'create', filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: null }, text: 'created' }
    }
    if (e.tool === 'Agent') {
      return { result: { agentId: 'a1', totalToolUseCount: 7, totalTokens: 12000, totalDurationMs: 1, content: [] } as never, text: 'done' }
    }
    return { result: {} as never, text: 'line one\nline two' }
  })
  return { clock, disk, seen, spend }
}

async function start($: Engine, clock: MockClock): Promise<void> {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.advance(2000)
}

/** One turn: read, test, edit tools.py, create cache.py and report.md, plot an image, and a subagent. */
async function workTurn($: Engine, clock: MockClock, spend: { usd: number }): Promise<void> {
  await $.turn.start({ turnId: 't1', text: 'make SQL execution resilient' })
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/app/services/tools.py` })
  await $.tool.call({ tool: 'Bash', command: 'pytest -q' })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/app/services/tools.py`, old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/app/services/cache.py`, content: 'def cached(fn):\n    return fn\n' })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/report.md`, content: '# Latency report\n\nAll good.\n' })
  await $.tool.call({ tool: 'Bash', command: 'python plot.py' })
  await $.tool.call({ tool: 'Agent', description: 'find callers', prompt: 'look', subagent_type: 'Explore' })
  spend.usd = 0.62
  await $.turn.complete({ answer: 'Added retry().', durationMs: 1, isAborted: false, reason: 'answer', turnId: 't1', usage: USAGE_TOKENS })
  await clock.advance(1000)
}

describe('helpers', () => {
  test('side-by-side pairs each removed line with the line that replaced it', () => {
    const rows = sideBySide([TOOLS_HUNK])
    expect(rows[0]).toEqual({ left: { line: 6, text: '    return session.run(sql)', kind: '-' }, right: { line: 6, text: '    return retry(lambda: session.run(sql))', kind: '+' } })
    expect(rows.slice(1).every(row => row.left === undefined && row.right?.kind === '+')).toBe(true)
    expect(sideBySide([TOOLS_HUNK, TOOLS_HUNK]).filter(row => row.isGap === true)).toHaveLength(1)
  })

  test('file kinds, CSV and JSON', () => {
    expect([previewKind('a.md'), previewKind('b.csv'), previewKind('c.html'), previewKind('d.png'), previewKind('e.py')]).toEqual(['markdown', 'csv', 'html', 'image', 'code'])
    expect(parseCsv(START_FILES['data.csv'] ?? '', 10)).toEqual([
      ['name', 'latency_ms', 'ok'],
      ['search', '120', 'true'],
      ['agent, sql', '340', 'false'],
    ])
    const tree = jsonTree(JSON.parse(START_FILES['config.json'] ?? '{}'))
    expect(tree.map(line => `${line.depth}:${line.key}=${line.value}`)).toContain('2:0="a"')
  })
})

test('Now shows each tool call with status, timing and the subagent', async ($, on) => {
  const { clock, spend } = engineBeneath(on)
  await start($, clock)
  await workTurn($, clock, spend)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: '✓ done' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'pytest -q' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '12.0s' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /⑂ Explore · 7 tools · 12k tokens/ })).toBeDefined()
    await ui.press({ key: 'now-outputs' })
    expect(await ui.find({ type: 'Text', text: /↳ ok ⏎ 2 passed/ })).toBeDefined()
    await ui.press({ key: 'now-outputs' })
    await ui.unmount()
  }
})

test('Changes goes from turns to files to functions to a side-by-side diff, and replays', async ($, on) => {
  const { clock, spend } = engineBeneath(on)
  await start($, clock)
  await workTurn($, clock, spend)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:changes' })
  expect(await ui.find({ type: 'Text', text: '3 files' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /make SQL execution resilient/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'ƒ execute_sql, retry' })).toBeDefined()

  await ui.press({ key: 'cfile:t1:0' })
  expect(await ui.find({ type: 'Text', text: /modified · L4/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /added · L9/ })).toBeDefined()

  await ui.press({ key: 'fe:0' })
  expect(await ui.find({ type: 'Text', text: /^ +before$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {4}return session\.run\(sql\) +$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {4}return retry\(lambda: session\.run\(sql\)\) +$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /edit 1 of 3/ })).toBeDefined()
  await ui.press({ key: 'diff-next' })
  expect(await ui.find({ type: 'Text', text: /edit 2 of 3/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'app/services/cache.py' })).toBeDefined()
})

test('Preview follows edits and renders Markdown, CSV, JSON and HTML', async ($, on) => {
  const { clock, spend, seen } = engineBeneath(on)
  await start($, clock)
  await workTurn($, clock, spend)
  const run = (args: string) => $.command.run({ command: 'wb', args, ...RUN })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:preview' })
  expect(await ui.find({ type: 'Text', text: 'report.md' })).toBeDefined()
  expect((await ui.find({ type: 'Markdown' }))?.props).toMatchObject({ text: '# Latency report\n\nAll good.\n' })

  await run('preview data.csv')
  expect(await ui.find({ type: 'Text', text: /^agent, sql +$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '2 of 2 rows' })).toBeDefined()

  await run('preview config.json')
  expect(await ui.find({ type: 'Text', text: '"sonnet"' })).toBeDefined()

  await run('preview page.html')
  expect(seen.screenshots[0]).toMatch(/--screenshot=\/tmp\/workbench-preview-.+\.png file:\/\/\/proj\/page\.html/)
  expect(await ui.find({ type: 'Image' })).toBeDefined()
  await ui.unmount()

  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await desktop.find({ type: 'Markdown' }))?.props).toMatchObject({ text: expect.stringContaining('# Report') })
  await desktop.press({ key: 'pv-copy' })
  expect(seen.copied).toEqual(['/proj/page.html'])
})

test('Artifacts lists what was created this session, by Claude or by commands', async ($, on) => {
  const { clock, spend, seen } = engineBeneath(on)
  await start($, clock)
  await workTurn($, clock, spend)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:artifacts' })
  expect(await ui.find({ type: 'Text', text: '3 new files' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /📄 Documents/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /🖼 Images/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'report.md' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'latency.png' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'li/lib/site.py' })).toBeUndefined()
  await ui.press({ key: 'art-copy:0' })
  expect(seen.copied).toHaveLength(1)
})

test('Code Map draws the layers, marks edited folders and outlines a file', async ($, on) => {
  const { clock, spend } = engineBeneath(on)
  await start($, clock)
  await workTurn($, clock, spend)
  await $.command.run({ command: 'wb', args: 'map', ...RUN })
  await $.command.run({ command: 'wb', args: 'rescan', ...RUN })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /folder mode \(no git\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'L2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '✎ 2' })).toBeDefined()
  await $.command.run({ command: 'wb', args: 'components app/services/tools.py', ...RUN })
  expect(await ui.findAll({ type: 'Text', text: '● changed' })).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: /→ get_session, retry/ })).toBeDefined()
})

test('Usage shows limits with reset and pace, the context, and cost per turn', async ($, on) => {
  const { clock, spend } = engineBeneath(on)
  await start($, clock)
  await workTurn($, clock, spend)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:usage' })
  expect(await ui.find({ type: 'Text', text: '75%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /↻ resets in 2h · at \d\d:\d\d · on pace for 125% by the reset/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /⚠ at this pace you run out in 1h( \d+m)?, before the reset/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '$0.120' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /session total \$0\.62/ })).toBeDefined()
})

test('the Workbench slide sums the session and shows the latest edit', async ($, on) => {
  const { clock, spend } = engineBeneath(on)
  await start($, clock)
  await workTurn($, clock, spend)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...HUD, surface })
    expect(await ui.find({ type: 'Text', text: 'Workbench' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '5h' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '↻2h' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /⏱ 1[23]m · 7 tools/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✎ 3 files +10 −1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✦ 3 new' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'report.md' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'another mod band' })).toBeUndefined()
    await ui.unmount()
  }
})

test('◀ moves to the Forecast slide: the forecast mod\'s band when it draws one', async ($, on) => {
  const { clock, spend } = engineBeneath(on)
  await start($, clock)
  await workTurn($, clock, spend)
  const ui = await $.ui.mount({ ...HUD, surface: 'terminal' })
  await ui.press({ key: 'hud-left' })
  expect(await ui.find({ type: 'Text', text: 'another mod band' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '✦ 3 new' })).toBeUndefined()
  await ui.press({ key: 'hud-right' })
  expect(await ui.find({ type: 'Text', text: '✦ 3 new' })).toBeDefined()
  await ui.press({ key: 'hud-hide' })
  expect(await ui.find({ type: 'Text', text: 'Workbench' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'another mod band' })).toBeDefined()
})

test('◀ draws its own Forecast slide when no forecast mod is on', async ($, on) => {
  const { clock, spend } = engineBeneath(on, '')
  await start($, clock)
  await workTurn($, clock, spend)
  await $.command.run({ command: 'wb', args: 'forecast', ...RUN })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...HUD, surface })
    expect(await ui.find({ type: 'Text', text: '5-hour' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Weekly' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '75%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /↻ resets in 2h · \d\d:\d\d/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /⚠ at this pace, out in 1h/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Context' })).toBeDefined()
    await ui.unmount()
  }
})
