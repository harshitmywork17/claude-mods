import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseApproaches } from '../hooks/approaches'

const PANE = {
  plugin: 'fork-explorer',
  component: 'Pane',
  requestId: 'fork-explorer',
  props: {
    title: 'Fork Explorer',
    isFocused: true,
    bodyColumns: 140,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as const
const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

const REPLY = JSON.stringify({
  approaches: [
    { title: 'Redis sessions', idea: 'Move sessions to Redis with a TTL.', pros: ['fast'], cons: ['new service'], effort: 'M' },
    { title: 'Signed cookies', idea: 'Keep state in signed cookies.', pros: ['no store'], cons: ['size limit'], effort: 'S' },
  ],
})

type Seen = { prompts: string[]; filled: string[] }

function engineBeneath(on: On, reply: string | null): Seen {
  const seen: Seen = { prompts: [], filled: [] }
  mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('model.fork', (_$, e) => {
    seen.prompts.push(e.prompt)
    return {
      value:
        reply === null
          ? { isAnswered: false, reason: 'nothing-to-fork' }
          : { isAnswered: true, text: reply, usage: USAGE },
    }
  })
  on('prompt.fill', (_$, e) => {
    seen.filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  return seen
}

test('reads approaches from a reply wrapped in prose or a fence', () => {
  expect(parseApproaches(`Sure!\n\`\`\`json\n${REPLY}\n\`\`\``)).toHaveLength(2)
  expect(parseApproaches('no json here')).toHaveLength(0)
  expect(parseApproaches('{"approaches":[{"title":"","idea":"x"}]}')).toHaveLength(0)
})

test('/fork shows alternatives side by side and "use this" fills the prompt only', async ($, on) => {
  const seen = engineBeneath(on, REPLY)

  const out = await $.command.run({ command: 'fork', args: 'we cached sessions?', ...RUN })
  expect(out.text).toBeUndefined()
  expect(seen.prompts[0]).toMatch(/What if: we cached sessions\?/)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /1\. Redis sessions/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2\. Signed cookies/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '+ fast' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'use-1' })
  expect(seen.filled).toEqual(['Let\'s go with "Signed cookies" for: we cached sessions?\nKeep state in signed cookies.'])
})

test('typing in the pane runs a fork, and errors are shown plainly', async ($, on) => {
  engineBeneath(on, null)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'ask', text: 'we dropped LlamaIndex?' })
  expect(await ui.find({ type: 'Text', text: /no conversation to explore yet/ })).toBeDefined()
})
