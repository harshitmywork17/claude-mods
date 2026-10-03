import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'

import { duration } from '../hooks/format'

const TURN = { answer: 'ok', isAborted: false, reason: 'answer' } as const
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as const

type Seen = { status: (string | undefined)[]; toasts: string[] }

function engineBeneath(on: On): { seen: Seen; clock: MockClock } {
  const seen: Seen = { status: [], toasts: [] }
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 1_000_000, rateLimits: [], context: { window: 200000 } } }))
  on('command.register', () => ({ value: { command: 'meter' } }))
  on('ui.status', (_$, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', (_$, e) => {
    if (e.tool === 'Edit' && e.old_string === 'missing') return { isError: true, result: 'nope', text: 'nope' }
    return { result: {} as never }
  })
  return { seen, clock }
}

async function edit($: Engine, file: string, old = 'a'): Promise<void> {
  await $.tool.call({ tool: 'Edit', file_path: file, old_string: old, new_string: 'b' })
}

test('durations read naturally', () => {
  expect(duration(4_000)).toBe('4s')
  expect(duration(90_000)).toBe('1m 30s')
  expect(duration(720_000)).toBe('12m')
  expect(duration(3_900_000)).toBe('1h 05m')
})

test('the status line counts tools and edited files and ticks with time', async ($, on) => {
  const { seen, clock } = engineBeneath(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(seen.status.at(-1)).toBe('⏱ 0s · 0 tool calls · 0 files edited')

  await $.turn.start({ turnId: 't1', text: 'go' })
  await edit($, '/repo/a.py')
  await edit($, '/repo/a.py')
  await edit($, '/repo/b.py')
  await edit($, '/repo/c.py', 'missing')
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(seen.status.at(-1)).toBe('⏱ 0s · 5 tool calls · 2 files edited')

  await clock.advance(30_000)
  expect(seen.status.at(-1)).toBe('⏱ 30s · 5 tool calls · 2 files edited')

  const out = await $.command.run({ command: 'meter', args: '', ...RUN })
  expect(out.text).toMatch(/Files: \/repo\/a\.py, \/repo\/b\.py/)
})

test('a long turn ends with a toast, a short one does not', async ($, on) => {
  const { seen } = engineBeneath(on)

  await $.turn.start({ turnId: 't1', text: 'quick' })
  await edit($, '/repo/a.py')
  await $.turn.complete({ ...TURN, turnId: 't1', durationMs: 5_000 })
  expect(seen.toasts).toHaveLength(0)

  await $.turn.start({ turnId: 't2', text: 'slow' })
  await edit($, '/repo/b.py')
  await $.tool.call({ tool: 'Bash', command: 'pytest' })
  await $.turn.complete({ ...TURN, turnId: 't2', durationMs: 134_000 })
  expect(seen.toasts).toEqual(['Done in 2m 14s · 2 tool calls · 1 file edited'])

  await $.turn.complete({ ...TURN, turnId: 'sub', agentId: 'a1', durationMs: 500_000 })
  expect(seen.toasts).toHaveLength(1)
})

test('the toast threshold is configurable', { options: { toastAfterSeconds: 0 } }, async ($, on) => {
  const { seen } = engineBeneath(on)
  await $.turn.complete({ ...TURN, turnId: 't1', durationMs: 999_000 })
  expect(seen.toasts).toHaveLength(0)
})
