import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'

import { applyTask, clock, modelLabel, money, sprite, tierOf, tokens, waitingOn } from '../hooks/crew'

const NOW = Date.parse('2026-10-04T10:00:00Z')
const PANE = {
  plugin: 'crew',
  component: 'Pane',
  requestId: 'crew',
  props: { title: 'Agents', isFocused: true, bodyColumns: 64, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as const

type World = { clock: MockClock; spend: { usd: number }; opens: string[]; store: Map<string, unknown>; listed: { id: string; status: string }[] }

function beneath(on: On): World {
  const clock = mock.clock(on, { now: NOW })
  const spend = { usd: 2 }
  const opens: string[] = []
  const store = new Map<string, unknown>()
  const listed: { id: string; status: string }[] = []
  let spawned = 0
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'crew' } }))
  on('ui.open', (_$, e) => {
    opens.push(e.focus === true ? 'asked' : 'unasked')
    return { value: { isPlaced: true } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.usage', () => ({
    value: { startedAt: NOW - 10 * 60_000, context: { percent: 3, tokens: 30_000, window: 1_000_000 }, cost: { usd: spend.usd }, rateLimits: [] },
  }))
  on('agent.list', () => ({ value: listed.map(one => ({ id: one.id, description: 'from the list', type: 'Explore', status: one.status })) }))
  on('agent.spawn', (_$, e) => {
    spawned += 1
    const agentId = `a${spawned}`
    listed.push({ id: agentId, status: 'running' })
    return { model: e.model ?? 'claude-opus-5-5', agentId }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 2_000, cache_read_input_tokens: 170_000, cache_creation_input_tokens: 8_000, output_tokens: 3_000 },
    }
  })
  on('tool.call', (_$, e) => {
    if (e.tool === 'TaskCreate') return { result: { task: { id: String(++taskIds), subject: e.subject } } as never, text: 'created' }
    return { result: {} as never, text: 'ok' }
  })
  let taskIds = 0
  return { clock, spend, opens, store, listed }
}

/** One request in an agent's loop, read to its end. */
async function step($: Engine, agentId: string | undefined, effort: 'low' | 'high' | 'xhigh'): Promise<void> {
  const stream = $.turn.step({ turnId: `turn-${agentId ?? 'main'}`, index: 0, model: 'claude-opus-5-5', effort, messageCount: 3, agentId })
  for await (const _chunk of stream) {
    // Read through.
  }
  await stream.result
}

async function start($: Engine, world: World): Promise<void> {
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await world.clock.advance(100)
  await $.turn.start({ turnId: 'main-1', text: 'Phase 11: Sessions & Panel' })
}

async function spawn($: Engine, description: string): Promise<void> {
  await $.agent.spawn({
    tool_use_id: `tu-${description}`,
    prompt: `Do ${description} carefully and report back.`,
    description,
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  })
}

describe('helpers', () => {
  test('model ids and effort read as crew labels', () => {
    expect([modelLabel('claude-opus-5-5'), modelLabel('claude-haiku-4-5-20251001'), modelLabel('claude-fable-5-1'), modelLabel('opus'), modelLabel(undefined)]).toEqual([
      'Opus 5.5',
      'Haiku 4.5',
      'Fable 5.1',
      'Opus',
      'model ?',
    ])
    expect(['xhigh', 'max', 'high', 'medium', 'low', undefined].map(effort => tierOf(effort).label)).toEqual(['heavy', 'heavy', 'careful', 'medium', 'light', 'agent'])
  })

  test('numbers read as the pane shows them', () => {
    expect([tokens(39_000_000), tokens(177_400), tokens(950)]).toEqual(['39.0M', '177k', '950'])
    expect([money(14.42), money(1.654)]).toEqual(['≈$14.4', '≈$1.65'])
    expect([clock(201_000), clock(1_065_000), clock(3_729_000)]).toEqual(['3:21', '17:45', '1:02:09'])
  })

  test('the plan follows task creates, updates and blockers', () => {
    let tasks = applyTask([], { kind: 'create', id: '1', subject: 'Protocol threads' })
    tasks = applyTask(tasks, { kind: 'create', id: '2', subject: 'Server threads' })
    tasks = applyTask(tasks, { kind: 'update', id: '2', addBlockedBy: ['1'] })
    expect(waitingOn(tasks[1]!, tasks)).toEqual(['1'])
    tasks = applyTask(tasks, { kind: 'update', id: '1', status: 'completed' })
    expect(waitingOn(tasks[1]!, tasks)).toEqual([])
    tasks = applyTask(tasks, { kind: 'todos', todos: [{ content: 'write docs', status: 'pending' }] })
    expect(tasks.map(task => task.id)).toEqual(['1', '2', 'todo-1'])
    expect(applyTask(tasks, { kind: 'update', id: '2', status: 'deleted' }).map(task => task.id)).toEqual(['1', 'todo-1'])
  })

  test('the sprite is three rows, eight cells wide, and walks only while running', () => {
    const width = (rows: ReturnType<typeof sprite>): number[] => rows.map(cells => cells.reduce((sum, cell) => sum + cell.char.length, 0))
    expect(width(sprite(tierOf('high'), 'running', 0))).toEqual([8, 8, 8])
    expect(sprite(tierOf('high'), 'running', 0)).not.toEqual(sprite(tierOf('high'), 'running', 1))
    expect(sprite(tierOf('high'), 'completed', 0)).toEqual(sprite(tierOf('high'), 'completed', 1))
  })
})

test('each subagent shows its model, effort, context, tokens, cost and time', async ($, on) => {
  const world = beneath(on)
  await start($, world)
  await spawn($, '11.3 Cache clock handover')
  await world.clock.advance(201_000)
  world.spend.usd = 3.65
  await step($, 'a1', 'xhigh')
  await $.tool.call({ tool: 'Grep', pattern: 'cacheClock', agentId: 'a1' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Agents · Phase 11: Sessions & Panel' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '≈$3.65' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '183k' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '13:21' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Running · 1' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: '1. 11.3 Cache clock handover' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'heavy Opus 5.5 · xhigh' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'ctx 18% · 183k ≈$1.65 3:21' })).toBeDefined()
})

test('finished agents move to Completed with their answer, and the section folds', async ($, on) => {
  const world = beneath(on)
  await start($, world)
  await spawn($, '11.1 Protocol threads')
  await spawn($, '11.2 Stable session prefix')
  await step($, 'a1', 'high')
  await $.turn.complete({ answer: 'Threads now carry protocol ids.', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'x', agentId: 'a1' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, reason: 'aborted', turnId: 'y', agentId: 'a2' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', text: '▾ Completed · 2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '✓' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '⊘' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Running · 0' })).toBeUndefined()

  await ui.press({ key: 'open:a1' })
  expect(await ui.find({ type: 'Text', text: '↳ Threads now carry protocol ids.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Do 11.1 Protocol threads carefully and report back.' })).toBeDefined()

  await ui.press({ key: 'toggle-completed' })
  expect(await ui.find({ type: 'Button', text: '▸ Completed · 2' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: '1. 11.1 Protocol threads' })).toBeUndefined()
})

test('planned tasks show what they still wait for', async ($, on) => {
  const world = beneath(on)
  await start($, world)
  for (const subject of ['iOS side panel', 'Server threads', 'iOS session boundary']) await $.tool.call({ tool: 'TaskCreate', subject, description: subject })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', addBlockedBy: ['1', '3'] })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', text: '▾ Planned · 3' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '2. Server threads' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'waiting · after 1, 3' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'in progress' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'ready' })).toBeDefined()
})

test('the pane opens by itself on the first subagent, unless turned off', async ($, on) => {
  const world = beneath(on)
  await start($, world)
  await spawn($, 'one')
  await spawn($, 'two')
  expect(world.opens).toEqual(['unasked'])
  await $.command.run({ command: 'crew', args: '', ...RUN })
  expect(world.opens).toEqual(['unasked', 'asked'])
  const answer = await $.command.run({ command: 'crew', args: 'auto off', ...RUN })
  expect(answer.text).toMatch(/no longer opens/)
  expect(world.store.get('autoOpen')).toBe(false)
})

test('an empty session shows the idle crew member', async ($, on) => {
  const world = beneath(on)
  await start($, world)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'No crew yet' })).toBeDefined()
    await ui.unmount()
  }
})
