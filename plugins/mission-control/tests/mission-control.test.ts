import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { MockClock } from 'claude-code/testing'

import { bar, modelTime, onNewest, relabel, summarize, withStep, withStepChange } from '../hooks/trace'
import type { Turn } from '../types'

const PANE = {
  plugin: 'mission-control',
  component: 'Pane',
  requestId: 'mission-control',
  props: {
    title: 'Mission Control',
    isFocused: false,
    bodyColumns: 120,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const TURN_END = { answer: 'ok', isAborted: false, reason: 'answer', durationMs: 0 } as const

function engineBeneath(on: On, clock: () => MockClock): void {
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [{ id: 'a1', type: 'Explore', description: 'find auth code', status: 'running' }] }))
  on('tool.call', async (_$, e) => {
    await clock().advance(e.tool === 'Bash' ? 12_000 : 500)
    if (e.tool === 'Bash') return { isError: true, result: 'exit 1', text: 'FAILED tests/test_auth.py::test_login\n1 failed' }
    if (e.tool === 'Edit') return { deny: 'not allowed here' }
    if (e.tool === 'Agent') {
      return { result: { agentId: 'a1', totalToolUseCount: 7, totalTokens: 12000, totalDurationMs: 500, content: [] } as never, text: 'done' }
    }
    return { result: {} as never, text: 'line one\nline two' }
  })
}

test('summaries, waterfall bars and model time', () => {
  expect(summarize('Bash', { command: 'pytest -q' })).toBe('pytest -q')
  expect(summarize('Read', { file_path: '/repo/app/main.py' })).toBe('main.py')
  expect(summarize('Agent', { subagent_type: 'Explore', description: 'find auth' })).toBe('Explore: find auth')

  const turn: Turn = {
    id: 't',
    prompt: 'p',
    startedAt: 0,
    endedAt: 100,
    status: 'done',
    lanes: [{ id: 'main', label: 'Main' }],
    steps: [
      { id: 's1', lane: 'main', tool: 'Read', summary: '', startedAt: 10, endedAt: 30, status: 'ok', output: '' },
      { id: 's2', lane: 'main', tool: 'Bash', summary: '', startedAt: 20, endedAt: 60, status: 'ok', output: '' },
    ],
  }
  expect(modelTime(turn, 100)).toBe(50)
  expect(bar(turn.steps[1]!, turn, 100, 10)).toEqual({ pad: '  ', fill: '████' })
})

test('subagent tool calls open their own lane, relabelled when the subagent reports', () => {
  const now = 0
  const start = onNewest([], now, turn => turn)
  const step = { id: 's', lane: 'a1', tool: 'Grep', summary: 'auth', startedAt: 0, status: 'running', output: '' } as const
  const withLane = onNewest(start, now, turn => withStep(turn, step, 'Subagent a1'))
  expect(withLane[0]?.lanes.map(lane => lane.label)).toEqual(['Main', 'Subagent a1'])
  expect(relabel(withLane, 'a1', 'Explore: find auth code')[0]?.lanes[1]?.label).toBe('Explore: find auth code')
  expect(withStepChange(withLane, 's', { status: 'ok', endedAt: 5 })[0]?.steps[0]?.status).toBe('ok')
})

test('a turn shows each tool with status, duration and output, and subagents get a label', async ($, on) => {
  let clock: MockClock | undefined
  clock = mock.clock(on)
  engineBeneath(on, () => clock!)

  await $.turn.start({ turnId: 't1', text: 'fix the login test' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/app/auth.py' })
  await $.tool.call({ tool: 'Bash', command: 'pytest tests/test_auth.py' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/app/auth.py', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Agent', description: 'find auth code', prompt: 'look', subagent_type: 'Explore' })
  await $.turn.complete({ ...TURN_END, turnId: 't1', usage: { model: 'm', input_tokens: 900, output_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: '✓ done' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '“fix the login test”' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /4 tool calls · 2 failed/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'auth.py' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'pytest tests/test_auth.py' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '12.0s' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' ⊘' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /⑂ subagent Explore · 7 tools · 12000 tokens/ })).toBeDefined()

    await ui.press({ key: 'view' })
    expect(await ui.find({ type: 'Text', text: /↳ FAILED tests\/test_auth\.py::test_login ⏎ 1 failed/ })).toBeDefined()
    await ui.press({ key: 'view' })
    await ui.unmount()
  }
})

test('the pane is empty-state before any turn and keeps only recent turns', async ($, on) => {
  let clock: MockClock | undefined
  clock = mock.clock(on)
  engineBeneath(on, () => clock!)

  const empty = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await empty.find({ type: 'Text', text: /Waiting for the next turn/ })).toBeDefined()
  await empty.unmount()

  for (let index = 1; index <= 7; index += 1) {
    await $.turn.start({ turnId: `t${index}`, text: `prompt ${index}` })
    await $.turn.complete({ ...TURN_END, turnId: `t${index}` })
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /turn 5\/5/ })).toBeDefined()
  await ui.press({ key: 'older' })
  expect(await ui.find({ type: 'Text', text: '“prompt 6”' })).toBeDefined()
})
