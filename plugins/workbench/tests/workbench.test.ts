import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'
import type { OutlineEntry } from '../types'

import { innermostChanged } from '../hooks/changes'
import { changedRanges, unifiedDiff } from '../hooks/diff'
import { jsonTree, parseCsv, previewKind } from '../hooks/files'
import { diffstat } from '../hooks/theme'
import { promptLabel } from '../hooks/trace'

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
    if (e.tool === 'Bash' && e.command.includes('fastapi')) return { result: {} as never, text: 'ModuleNotFoundError: fastapi', isError: true }
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
  test('a whole-file diff keeps three lines of context and numbers each hunk', () => {
    const diff = unifiedDiff(HEAD_TOOLS, NEW_TOOLS)
    expect(diff.hunks).toBe(1)
    expect(diff.text.split('\n')[0]).toBe('@@ -3,4 +3,8 @@')
    expect(diff.text).toContain('\n     session = get_session()\n-    return session.run(sql)\n+    return retry(lambda: session.run(sql))')
    expect(unifiedDiff(null, 'a\nb\n').text).toBe('@@ -0,0 +1,2 @@\n+a\n+b')
    expect(unifiedDiff('same\n', 'same\n').text).toBe('')
  })

  test('an edit changes only its added and removed lines, not the context around them', () => {
    const hunk = { oldStart: 5, oldLines: 3, newStart: 5, newLines: 4, lines: [' keep', '-old', '+new', '+more', ' keep'] }
    expect(changedRanges([hunk])).toEqual([
      [6, 6],
      [6, 6],
      [7, 7],
    ])
  })

  test('a changed method names itself, not the whole class around it', () => {
    const entries: OutlineEntry[] = [
      { name: 'ChatService', kind: 'class', line: 1, endLine: 12, depth: 0, isChanged: true, calls: [] },
      { name: 'reply', kind: 'method', line: 5, endLine: 7, depth: 1, isChanged: false, calls: [] },
      { name: 'clear_history', kind: 'method', line: 9, endLine: 10, depth: 1, isChanged: true, calls: [] },
    ]
    expect(innermostChanged(entries).map(entry => entry.name)).toEqual(['clear_history'])
  })

  test('a background task notice reads as its summary', () => {
    expect(promptLabel('<task-notification> <task-id>a1</task-id> <status>completed</status> <summary>Agent "Find callers" completed</summary></task-notification>')).toBe(
      '↻ Agent "Find callers" completed',
    )
    expect(promptLabel('<task-notification><task-id>a1</task-id></task-notification>')).toBe('↻ a background task finished')
    expect(promptLabel('  fix   the\nbug ')).toBe('fix the bug')
  })

  test('change bars scale to the largest file and split added from removed', () => {
    expect(diffstat(10, 0, 10, 8)).toEqual({ plus: '▮▮▮▮▮▮▮▮', minus: '' })
    expect(diffstat(3, 1, 8, 8)).toEqual({ plus: '▮▮▮', minus: '▮' })
    expect(diffstat(0, 0, 8, 8)).toEqual({ plus: '', minus: '' })
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

test('the pane opens on one row of tabs, the open one drawn as a pill', async ($, on) => {
  const { clock, spend } = engineBeneath(on)
  await start($, clock)
  await workTurn($, clock, spend)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: ' Now ' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: ' Changes 3 ' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: ' Artifacts 3 ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '✓ idle · 1 turn' })).toBeDefined()
  await ui.press({ key: 'tab:changes' })
  expect(await ui.find({ type: 'Text', text: ' Changes 3 ' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: ' Now ' })).toBeDefined()
})

test('Now lists each call with status and timing, nests the subagent, and shows failures without asking', async ($, on) => {
  const { clock, spend } = engineBeneath(on)
  await start($, clock)
  await workTurn($, clock, spend)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: '✓ done' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' Bash 2 ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'pytest -q' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '12.0s' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /⑂ Explore · 7 tools · 12k tokens/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /↳ ok ⏎ 2 passed/ })).toBeUndefined()
    await ui.press({ key: 'now-outputs' })
    expect(await ui.find({ type: 'Text', text: /↳ ok ⏎ 2 passed/ })).toBeDefined()
    await ui.press({ key: 'now-outputs' })
    await ui.unmount()
  }
})

test('a failed call shows its error, and a background notice turn reads as its summary', async ($, on) => {
  const { clock } = engineBeneath(on)
  await start($, clock)
  await $.turn.start({ turnId: 't9', text: '<task-notification><summary>Agent "Find callers" completed</summary></task-notification>' })
  await $.tool.call({ tool: 'Bash', command: 'python -c "import fastapi"' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 't9', usage: USAGE_TOKENS })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '“↻ Agent "Find callers" completed”' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1 call · 1 failed' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '↳ ModuleNotFoundError: fastapi' })).toBeDefined()
})

test('Changes lists files with change bars, then a file with its functions and highlighted diff, then each edit', async ($, on) => {
  const { clock, spend } = engineBeneath(on)
  await start($, clock)
  await workTurn($, clock, spend)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:changes' })
  expect(await ui.find({ type: 'Text', text: '3 files changed' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'app/services/tools.py' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ƒ execute_sql · retry$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ƒ cached$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /make SQL execution resilient/ })).toBeDefined()

  await ui.press({ key: 'cfile:1' })
  expect(await ui.find({ type: 'Text', text: /modified · L4/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /added · L9/ })).toBeDefined()
  const whole = await ui.find({ type: 'Code' })
  expect(whole?.props).toMatchObject({ format: 'diff', path: 'app/services/tools.py' })
  expect(String(whole?.props.source)).toContain('     session = get_session()\n-    return session.run(sql)')

  await ui.press({ key: 'fe:0' })
  expect(await ui.find({ type: 'Text', text: /edit 1 of 3/ })).toBeDefined()
  expect(String((await ui.find({ type: 'Code' }))?.props.source)).toBe(
    '@@ -6,1 +6,5 @@\n-    return session.run(sql)\n+    return retry(lambda: session.run(sql))\n+\n+\n+def retry(action):\n+    return action()',
  )
  await ui.press({ key: 'diff-next' })
  expect(await ui.find({ type: 'Text', text: /edit 2 of 3/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'app/services/cache.py' })).toBeDefined()
  await ui.press({ key: 'diff-back' })
  await ui.press({ key: 'file-back' })
  await ui.press({ key: 'replay' })
  expect(await ui.find({ type: 'Text', text: /edit 1 of 3/ })).toBeDefined()
})

test('Preview follows edits and renders Markdown, CSV, JSON and HTML', async ($, on) => {
  const { clock, spend, seen } = engineBeneath(on)
  await start($, clock)
  await workTurn($, clock, spend)
  const run = (args: string) => $.command.run({ command: 'wb', args, ...RUN })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:preview' })
  expect(await ui.find({ type: 'Text', text: 'report.md' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' MARKDOWN ' })).toBeDefined()
  expect((await ui.find({ type: 'Markdown' }))?.props).toMatchObject({ text: '# Latency report\n\nAll good.\n' })
  expect(await ui.find({ type: 'Button', text: 'cache.py' })).toBeDefined()

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

test('Artifacts groups what was created this session, by Claude or by commands', async ($, on) => {
  const { clock, spend, seen } = engineBeneath(on)
  await start($, clock)
  await workTurn($, clock, spend)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:artifacts' })
  expect(await ui.find({ type: 'Text', text: '3 new files' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'DOCUMENTS' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'IMAGES' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'report.md' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'latency.png' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'li/lib/site.py' })).toBeUndefined()
  await ui.press({ key: 'art-copy:0' })
  expect(seen.copied).toHaveLength(1)
})

test('Code Map lists layers, marks edited folders, opens a folder and outlines a file', async ($, on) => {
  const { clock, spend } = engineBeneath(on)
  await start($, clock)
  await workTurn($, clock, spend)
  await $.command.run({ command: 'wb', args: 'map', ...RUN })
  await $.command.run({ command: 'wb', args: 'rescan', ...RUN })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /folder mode \(no git\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'LAYER 2 · entry points' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'LAYER 0 · foundations' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '✎2' })).toBeDefined()
  await ui.press({ key: 'g:app/services' })
  expect(await ui.find({ type: 'Text', text: /← used by app \(1\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'tools.py' })).toBeDefined()
  await ui.press({ key: 'mf:app/services:2' })
  expect(await ui.find({ type: 'Text', text: ' Components ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '2 changed' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /→ get_session, retry/ })).toBeDefined()
})

test('Usage shows limits with reset and pace, the context, and cost per turn', async ($, on) => {
  const { clock, spend } = engineBeneath(on)
  await start($, clock)
  await workTurn($, clock, spend)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:usage' })
  expect(await ui.find({ type: 'Text', text: '75%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /↻ 2h · \d\d:\d\d/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /⚠ runs out in 1h( \d+m)? at this pace \(on pace for 125%\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '$0.120' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '$0.62 this session' })).toBeDefined()
})

test('the Workbench slide sums the session on one line and shows the latest edit', async ($, on) => {
  const { clock, spend } = engineBeneath(on)
  await start($, clock)
  await workTurn($, clock, spend)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...HUD, surface })
    expect(await ui.find({ type: 'Text', text: 'Workbench' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /⏱ 1[23]m · 7 tools/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✎ 3 files +10 −1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: / · ✦ 3 new$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '5h ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'last edit' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'report.md' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'another mod band' })).toBeUndefined()
    await ui.unmount()
  }
  const narrow = await $.ui.mount({ ...HUD, surface: 'terminal', props: { ...HUD.props, bodyColumns: 90 } })
  expect(await narrow.find({ type: 'Text', text: '5h ' })).toBeUndefined()
})

test('◀ moves to the Forecast slide: the forecast mod\'s band when it draws one', async ($, on) => {
  const { clock, spend } = engineBeneath(on)
  await start($, clock)
  await workTurn($, clock, spend)
  const ui = await $.ui.mount({ ...HUD, surface: 'terminal' })
  await ui.press({ key: 'hud-left' })
  expect(await ui.find({ type: 'Text', text: 'Forecast' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'another mod band' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: / · ✦ 3 new$/ })).toBeUndefined()
  await ui.press({ key: 'hud-right' })
  expect(await ui.find({ type: 'Text', text: / · ✦ 3 new$/ })).toBeDefined()
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
