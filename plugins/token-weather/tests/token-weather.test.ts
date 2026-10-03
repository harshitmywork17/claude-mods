import { expect, test } from 'claude-code/testing'

import { forecastText, growthPerTurn, sky, sparkline, turnsLeft } from '../hooks/forecast'

const BAND = {
  plugin: 'token-weather',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

const TURN = { answer: 'ok', durationMs: 1000, isAborted: false, reason: 'answer' } as const

test('forecast math', () => {
  expect(sky(10).label).toBe('Clear')
  expect(sky(60).label).toBe('Cloudy')
  expect(sky(80).label).toBe('Rain')
  expect(sky(95).label).toBe('Storm')
  expect(sparkline([0, 50, 100])).toBe('▁▅█')
  expect(growthPerTurn([10, 20, 30])).toBe(10)
  expect(growthPerTurn([10, 60, 5, 15])).toBe(30)
  expect(turnsLeft(40, 10)).toBe(6)
  expect(turnsLeft(40, undefined)).toBeUndefined()
  expect(forecastText([], null)).toMatch(/no reading yet/)
})

test('each turn adds a reading and the band forecasts it', async ($, on) => {
  let percent = 20
  on('session.usage', () => ({
    value: { startedAt: 0, rateLimits: [], context: { percent, tokens: percent * 2000, window: 200000 } },
  }))
  on('turn.complete', () => ({ text: '' }))

  for (const next of [20, 30, 40]) {
    percent = next
    await $.turn.complete({ ...TURN, turnId: `t${next}` })
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /☀ Clear/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '40% (80k/200k)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '▂▃▄' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\+10\.0%\/turn · ~6 turns to full/ })).toBeDefined()
    await ui.unmount()
  }
})

test('subagent turns are not counted', async ($, on) => {
  on('session.usage', () => ({
    value: { startedAt: 0, rateLimits: [], context: { percent: 50, tokens: 1, window: 2 } },
  }))
  on('turn.complete', () => ({ text: '' }))

  on('ui.render', () => ({ type: 'Box', children: [] }))

  await $.turn.complete({ ...TURN, turnId: 'sub', agentId: 'agent-1' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text' })).toBeUndefined()
})

test('storm advice shows and hide removes the band', async ($, on) => {
  on('session.usage', () => ({
    value: { startedAt: 0, rateLimits: [], context: { percent: 93, tokens: 186000, window: 200000 } },
  }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', () => ({ type: 'Box', children: [] }))
  await $.turn.complete({ ...TURN, turnId: 't1' })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Storm/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /run \/compact now/ })).toBeDefined()
  await ui.press({ key: 'hide' })
  expect(await ui.find({ type: 'Text', text: /Storm/ })).toBeUndefined()
})
