import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'

import { calleesIn, enclosingSymbol } from '../hooks/calls'
import { outlineOf, parseDiff, symbolChanges } from '../hooks/changes'
import { parseDecisions } from '../hooks/prompts'
import { buildScan } from '../hooks/scan'

const ROOT = '/repo'

const FILES: Record<string, string> = {
  'app/run_poc.py': 'from app.services.sql_agent import run_query\n\n\ndef main():\n    print(run_query("hi"))\n',
  'app/services/sql_agent.py':
    'from app.core.config import settings\nfrom .tools import execute_sql\n\n\ndef build(question):\n    return f"SELECT {question}"\n\n\ndef run_query(question):\n    return execute_sql(build(question))\n',
  'app/services/tools.py':
    'from app.core.database import get_session\n\n\ndef execute_sql(sql):\n    session = get_session()\n    return retry(lambda: session.run(sql))\n\n\ndef retry(action):\n    return action()\n',
  'app/services/cache.py': 'def cached(fn):\n    return fn\n',
  'app/core/config.py': 'class Settings:\n    debug = False\n\n\nsettings = Settings()\n',
  'app/core/database.py': 'def get_session():\n    return object()\n',
}
const HEAD_TOOLS = 'from app.core.database import get_session\n\n\ndef execute_sql(sql):\n    session = get_session()\n    return session.run(sql)\n'
const TRACKED = Object.keys(FILES).filter(path => path !== 'app/services/cache.py')

const LS_FILES = TRACKED.join('\n') + '\n'
const COUNTS = TRACKED.map(path => `${path}:${(FILES[path] ?? '').split('\n').length - 1}`).join('\n')
const IMPORTS = [
  'app/run_poc.py:1:from app.services.sql_agent import run_query',
  'app/services/sql_agent.py:1:from app.core.config import settings',
  'app/services/sql_agent.py:2:from .tools import execute_sql',
  'app/services/tools.py:1:from app.core.database import get_session',
].join('\n')
const SYMBOLS = [
  'app/run_poc.py:4:def main():',
  'app/services/sql_agent.py:5:def build(question):',
  'app/services/sql_agent.py:9:def run_query(question):',
  'app/services/tools.py:4:def execute_sql(sql):',
  'app/services/tools.py:9:def retry(action):',
  'app/core/config.py:1:class Settings:',
  'app/core/database.py:1:def get_session():',
].join('\n')
const DIFF = [
  'diff --git a/app/services/tools.py b/app/services/tools.py',
  'index 1111111..2222222 100644',
  '--- a/app/services/tools.py',
  '+++ b/app/services/tools.py',
  '@@ -6 +6 @@ def execute_sql(sql):',
  '-    return session.run(sql)',
  '+    return retry(lambda: session.run(sql))',
  '@@ -6,0 +7,4 @@ def execute_sql(sql):',
  '+',
  '+',
  '+def retry(action):',
  '+    return action()',
].join('\n')
const CALL_SITES = [
  'app/services/sql_agent.py:10:execute_sql(',
  'app/services/tools.py:4:execute_sql(',
  'app/services/tools.py:6:retry(',
  'app/services/tools.py:9:retry(',
].join('\n')
const EXECUTE_SQL_HITS = ['app/services/sql_agent.py:10:    return execute_sql(build(question))', 'app/services/tools.py:4:def execute_sql(sql):'].join('\n')
const RUN_QUERY_HITS = ['app/run_poc.py:5:    print(run_query("hi"))', 'app/services/sql_agent.py:9:def run_query(question):'].join('\n')

const DECISION_REPLY = JSON.stringify({
  decisions: [{ decision: 'Wrap SQL execution in retry()', because: 'transient connection drops', alternatives: ['retry inside the driver'] }],
})

const PANE = {
  plugin: 'codebase-atlas',
  component: 'Pane',
  requestId: 'codebase-atlas',
  props: { title: 'Codebase Atlas', isFocused: true, bodyColumns: 140, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

function ok(stdout: string) {
  return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
}

function gitAnswer(argv: readonly string[]) {
  const args = argv.join(' ')
  if (args.startsWith('git rev-parse')) return ok(`${ROOT}\n`)
  if (args.includes(' ls-files --others')) return ok('app/services/cache.py\n')
  if (args.includes(' ls-files -- app/services/cache.py')) return ok('')
  if (args.includes(' ls-files -- app/')) return ok(`${argv[argv.length - 1]}\n`)
  if (args.includes(' ls-files')) return ok(LS_FILES)
  if (args.includes(' grep -c')) return ok(COUNTS)
  if (args.includes(' grep -n -o')) return ok(CALL_SITES)
  if (args.includes('execute_sql[[:space:]]')) return ok(EXECUTE_SQL_HITS)
  if (args.includes('run_query[[:space:]]')) return ok(RUN_QUERY_HITS)
  if (args.includes(' grep -n -I -E ^[[:space:]]*(import')) return ok(IMPORTS)
  if (args.includes(' grep -n -I -E')) return ok(SYMBOLS)
  if (args.includes(' diff -U0 HEAD -- app/services/tools.py')) return ok(DIFF)
  if (args.includes(' diff -U0 HEAD -- app/')) return ok('')
  if (args.includes(' diff -U0 HEAD')) return ok(DIFF)
  if (args.includes(' diff HEAD')) return ok(DIFF)
  if (args.includes(' show HEAD:app/services/tools.py')) return ok(HEAD_TOOLS)
  if (args.includes(' show HEAD:')) return ok('')
  return { value: { exitCode: 128, stdout: '', stderr: `unexpected: ${args}`, isStdoutTruncated: false, isStderrTruncated: false } }
}

type Seen = { forks: string[]; completions: string[] }

function engineBeneath(on: On, isGitRepo = true): { clock: MockClock; seen: Seen } {
  const seen: Seen = { forks: [], completions: [] }
  const clock = mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'atlas' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_$, e) =>
    !isGitRepo && e.argv[1] === 'rev-parse'
      ? { value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
      : gitAnswer(e.argv),
  )
  on('fs.read', (_$, e) => ({ value: FILES[e.path.replace(`${ROOT}/`, '')] ?? '' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} as never, text: 'ok' }))
  on('model.fork', (_$, e) => {
    seen.forks.push(e.prompt)
    return { value: { isAnswered: true, text: '## execute_sql\n\nRuns one validated query.', usage: USAGE } }
  })
  on('model.complete', (_$, e) => {
    seen.completions.push(e.prompt)
    return { value: { isAnswered: true, text: DECISION_REPLY, usage: USAGE } }
  })
  return { clock, seen }
}

async function startSession($: Engine, clock: MockClock): Promise<void> {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.advance(2000)
}

describe('parsing', () => {
  test('folders, edges and layers come from imports', () => {
    const { graph, imports } = buildScan(ROOT, LS_FILES, COUNTS, IMPORTS, SYMBOLS)
    expect(graph.groups.map(group => [group.id, group.level])).toEqual([
      ['app', 2],
      ['app/services', 1],
      ['app/core', 0],
    ])
    expect(graph.edges).toContainEqual({ from: 'app/services', to: 'app/core', count: 2 })
    expect([...(imports.get('app/services/sql_agent.py') ?? [])].sort()).toEqual(['app/core/config.py', 'app/services/tools.py'])
  })

  test('changes map to the functions they touch', () => {
    const [file] = parseDiff(DIFF)
    expect(file?.ranges).toEqual([
      [6, 6],
      [7, 10],
    ])
    const changes = symbolChanges(outlineOf(FILES['app/services/tools.py'] ?? '', 'x.py'), outlineOf(HEAD_TOOLS, 'x.py'), file?.ranges ?? [])
    expect(changes.map(change => [change.name, change.change])).toEqual([
      ['execute_sql', 'modified'],
      ['retry', 'added'],
    ])
  })

  test('callers, callees and decisions', () => {
    const { symbols } = buildScan(ROOT, LS_FILES, COUNTS, IMPORTS, SYMBOLS)
    expect(enclosingSymbol(FILES['app/services/sql_agent.py'] ?? '', 10, 'a.py')).toBe('run_query')
    const callees = calleesIn(['def execute_sql(sql):', '    session = get_session()', '    return retry(lambda: session.run(sql))'], 'execute_sql', symbols)
    expect(callees.map(site => [site.symbol, site.isKnown])).toEqual([
      ['get_session', true],
      ['retry', true],
      ['run', false],
    ])
    expect(parseDecisions(`Here:\n${DECISION_REPLY}`, 'p', 'd')[0]?.because).toBe('transient connection drops')
  })
})

test('the map draws layers, lights up edited folders and explains the focused one', async ($, on) => {
  const { clock, seen } = engineBeneath(on)
  await startSession($, clock)
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/app/services/tools.py`, old_string: 'a', new_string: 'b' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'L2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '5 files · 3 folders' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✎ 1 ' })).toBeDefined()
    await ui.press({ key: 'g:app/services' })
    expect(await ui.find({ type: 'Text', text: /imports → app\/core \(2\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /used by ← app \(1\)/ })).toBeDefined()
    await ui.press({ key: 'g:app/services' })
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'g:app/core' })
  await ui.press({ key: 'explain-folder' })
  expect(seen.forks[0]).toMatch(/Explain the "app\/core" folder/)
  expect(await ui.find({ type: 'Markdown' })).toBeDefined()
})

test('changes show each touched function, its call sites, the layers crossed and the impact', async ($, on) => {
  const { clock } = engineBeneath(on)
  await startSession($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:changes' })

  expect(await ui.find({ type: 'Button', text: 'app/services/tools.py' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'app/services/cache.py' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /modified · L4 · 1 call site$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /added · L9 · 1 call site$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /added · L1 · 0 call sites$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Layers crossed: app/services' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Affected elsewhere: 1 file import/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: '▸ app/services/sql_agent.py' })).toBeDefined()
})

test('components show each function with its size, what it calls and what changed', async ($, on) => {
  const { clock } = engineBeneath(on)
  await startSession($, clock)
  await $.command.run({ command: 'atlas', args: 'components app/services/tools.py', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /app\/services\/tools\.py · 10 lines · 2 components/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'execute_sql' })).toBeDefined()
    expect(await ui.findAll({ type: 'Text', text: '● changed' })).toHaveLength(2)
    expect(await ui.find({ type: 'Text', text: /→ get_session, retry/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the call graph walks callers and callees and comes back', async ($, on) => {
  const { clock, seen } = engineBeneath(on)
  await startSession($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:calls' })
  await ui.input({ key: 'symbol', text: 'execute_sql' })

  expect(await ui.find({ type: 'Text', text: 'app/services/tools.py:4' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '▲ Called by (1)' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'app/services/sql_agent.py:10' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '▼ Calls (2 in the repo)' })).toBeDefined()

  await ui.press({ key: 'caller:0' })
  expect(await ui.find({ type: 'Text', text: 'ƒ run_query' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'execute_sql › run_query' })).toBeDefined()
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Text', text: 'ƒ execute_sql' })).toBeDefined()

  await ui.press({ key: 'explain-function' })
  expect(seen.forks[0]).toMatch(/def execute_sql\(sql\):/)
  expect(await ui.find({ type: 'Text', text: 'Function execute_sql' })).toBeDefined()
})

test('decisions are pulled from a finished turn into the timeline', async ($, on) => {
  const { clock, seen } = engineBeneath(on)
  await startSession($, clock)
  await $.turn.start({ turnId: 't1', text: 'make SQL execution resilient' })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/app/services/tools.py`, old_string: 'a', new_string: 'b' })
  await $.turn.complete({ answer: 'Added retry().', durationMs: 1, isAborted: false, reason: 'answer', turnId: 't1' })
  await clock.advance(1000)

  expect(seen.completions[0]).toMatch(/Files edited this turn: \/repo\/app\/services\/tools\.py/)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:decisions' })
  expect(await ui.find({ type: 'Text', text: 'Wrap SQL execution in retry()' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'because transient connection drops' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'instead of: retry inside the driver' })).toBeDefined()
})

test('without git the map says so instead of failing', async ($, on) => {
  const { clock } = engineBeneath(on, false)
  await startSession($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /needs a git repository/ })).toBeDefined()
})
