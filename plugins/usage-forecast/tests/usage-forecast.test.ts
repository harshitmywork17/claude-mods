import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionRateLimit } from 'claude-code'

import { forecastText, growthPerTurn, sky, sparkline, turnsLeft } from '../hooks/forecast'
import { duration, meter, sortLimits, viewOf } from '../hooks/limits'

const HOUR = 3_600_000
const NOW = Date.parse('2026-10-05T10:00:00Z')

const BAND = {
  plugin: 'usage-forecast',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 8,
    bodyColumns: 140,
    scroll: { offset: 0, bodyRows: 8 },
    view: {},
  },
} as const

const TURN = { answer: 'ok', durationMs: 1000, isAborted: false, reason: 'answer' } as const
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as const

/** 75% of the 5-hour window used 3 hours in (out in about 1h, before the reset in 2h); 28% of the week. */
const LIMITS: SessionRateLimit[] = [
  { kind: 'seven_day', percentUsed: 28, resetsAt: new Date(NOW + 76 * HOUR).toISOString() },
  { kind: 'five_hour', percentUsed: 75, resetsAt: new Date(NOW + 2 * HOUR).toISOString() },
]

function engineBeneath(on: On, percent: () => number, rateLimits: SessionRateLimit[] = LIMITS): void {
  mock.clock(on, { now: NOW })
  on('session.usage', () => ({
    value: { startedAt: 0, rateLimits, context: { percent: percent(), tokens: percent() * 2000, window: 200000 } },
  }))
  on('turn.complete', () => ({ text: '' }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('ui.render', () => ({ type: 'Box', children: [] }))
}

test('context forecast math', () => {
  expect(sky(10).label).toBe('Clear')
  expect(sky(95).label).toBe('Storm')
  expect(sparkline([0, 50, 100])).toBe('▁▅█')
  expect(growthPerTurn([10, 20, 30])).toBe(10)
  expect(turnsLeft(40, 10)).toBe(6)
  expect(forecastText([], null, [])).toMatch(/Plan limits: no reading yet/)
})

test('limit views: bars, countdowns, reset times and pace', () => {
  expect(meter(75, 8)).toEqual({ used: '██████', left: '░░' })
  expect(duration(72 * 60_000)).toBe('1h 12m')
  expect(duration(76 * HOUR)).toBe('3d 4h')
  expect(duration(-1)).toBe('now')
  expect(sortLimits(LIMITS).map(limit => limit.kind)).toEqual(['five_hour', 'seven_day'])

  const fiveHour = viewOf(LIMITS[1]!, NOW)
  expect(fiveHour).toMatchObject({ label: '5-hour', percent: 75, color: 'yellow', resetIn: '2h', runsOutIn: '1h' })
  expect(fiveHour.resetAt).toMatch(/^\d\d:\d\d$/)

  const weekly = viewOf(LIMITS[0]!, NOW)
  expect(weekly).toMatchObject({ label: 'Weekly', percent: 28, color: 'green', resetIn: '3d 4h' })
  expect(weekly.runsOutIn).toBeUndefined()
  expect(weekly.resetAt).toMatch(/^[A-Z][a-z]{2} \d\d:\d\d$/)
})

test('the band shows both limits with reset times and the pace warning, then the context', async ($, on) => {
  let percent = 20
  engineBeneath(on, () => percent)
  for (const next of [20, 30, 40]) {
    percent = next
    await $.turn.complete({ ...TURN, turnId: `t${next}` })
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: '5-hour' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Weekly' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '75%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '28%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /↻ resets in 2h · \d\d:\d\d/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /↻ resets in 3d 4h · [A-Z][a-z]{2} \d\d:\d\d/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '⚠ at this pace, out in 1h' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '40% (80k/200k)' })).toBeDefined()
    const labels = (await ui.findAll({ type: 'Text', text: /^(5-hour|Weekly|Context)$/ })).map(found => found.text)
    expect(labels).toEqual(['5-hour', 'Weekly', 'Context'])
    await ui.unmount()
  }
})

test('the limits also arrive between turns, and /forecast reports them', async ($, on) => {
  engineBeneath(on, () => 10, [])
  await $.session.measure({ context: { window: 200000 }, rateLimits: LIMITS, changed: ['rateLimits'] })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '75%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Context' })).toBeUndefined()

  const out = await $.command.run({ command: 'forecast', args: '', ...RUN })
  expect(out.text).toMatch(/5-hour limit: 75% used, resets in 2h \(\d\d:\d\d\)\. At this pace it runs out in 1h/)
  expect(out.text).toMatch(/Weekly limit: 28% used, resets in 3d 4h/)

  await ui.press({ key: 'hide' })
  expect(await ui.find({ type: 'Text', text: '75%' })).toBeUndefined()
})

test('nothing is drawn before any reading', async ($, on) => {
  engineBeneath(on, () => 10, [])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text' })).toBeUndefined()
})
