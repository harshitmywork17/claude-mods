import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { changeOf, toSource } from '../hooks/diff'
import { stepEdit } from '../hooks/nav'

const CWD = '/repo'

const PANE = {
  plugin: 'replay-theater',
  component: 'Pane',
  requestId: 'replay-theater',
  props: {
    title: 'Replay Theater',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as const

function engineBeneath(on: On): void {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', () => ({ value: { command: 'replay' } }))
  on('tool.call', (_$, e) => {
    if (e.tool === 'Edit') {
      return {
        result: {
          filePath: e.file_path,
          oldString: e.old_string,
          newString: e.new_string,
          originalFile: 'a\nold\nc\n',
          structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-old', '+new', ' c'] }],
          userModified: false,
          replaceAll: false,
        },
      }
    }
    if (e.tool === 'Write') {
      return {
        result: { type: 'create', filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: null },
      }
    }
    return { deny: 'not in this test' }
  })
}

async function turn($: Engine, id: string, text: string): Promise<void> {
  await $.turn.start({ turnId: id, text })
}

test('diff helpers', () => {
  const created = changeOf({ filePath: '/repo/new.py', type: 'create', content: 'x = 1\ny = 2\n', structuredPatch: [], originalFile: null }, CWD)
  expect(created).toEqual({ file: 'new.py', kind: 'create', diff: '@@ -0,0 +1,2 @@\n+x = 1\n+y = 2\n', added: 2, removed: 0, isCut: false })
  expect(changeOf({ filePath: '/x', structuredPatch: [], originalFile: '', staged: true })).toBeNull()

  const big = { oldStart: 1, oldLines: 0, newStart: 1, newLines: 400, lines: Array.from({ length: 400 }, (_, i) => `+line ${i} ${'x'.repeat(30)}`) }
  const cut = toSource([big], 2000)
  expect(cut.isCut).toBe(true)
  expect(cut.source.length).toBeLessThanOrEqual(2000)
  expect(cut.source).toMatch(/^@@ -1,0 \+1,\d+ @@\n/)

  const turns = [
    { id: 'a', prompt: 'a', edits: [changeOf({ filePath: 'f', structuredPatch: [], originalFile: '' })!] },
    { id: 'b', prompt: 'b', edits: [changeOf({ filePath: 'g', structuredPatch: [], originalFile: '' })!] },
  ]
  expect(stepEdit({ turn: 0, edit: 0 }, turns, 1)).toEqual({ turn: 1, edit: 0 })
  expect(stepEdit({ turn: 1, edit: 0 }, turns, 1)).toEqual({ turn: 1, edit: 0 })
})

test('/replay steps through the edits of the last turn', async ($, on) => {
  engineBeneath(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

  await turn($, 't1', 'first prompt')
  await $.tool.call({ tool: 'Edit', file_path: '/repo/app.py', old_string: 'old', new_string: 'new' })
  await turn($, 't2', 'add a readme and fix app')
  await $.tool.call({ tool: 'Write', file_path: '/repo/README.md', content: '# Hi\n' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/app.py', old_string: 'old', new_string: 'new' })
  await turn($, 't3', 'question with no edits')

  const out = await $.command.run({ command: 'replay', args: '', ...RUN })
  expect(out.text).toMatch(/2 edits from “add a readme and fix app”/)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Turn 2\/2 · edit 1\/2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'README.md' })).toBeDefined()
    expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({ format: 'diff', source: '@@ -0,0 +1,1 @@\n+# Hi\n' })

    await ui.press({ key: 'next' })
    expect(await ui.find({ type: 'Text', text: 'app.py' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '−1' })).toBeDefined()

    await ui.press({ key: 'older' })
    expect(await ui.find({ type: 'Text', text: /Turn 1\/2 · edit 1\/1 · “first prompt”/ })).toBeDefined()
    await ui.press({ key: 'newer' })
    await ui.unmount()
  }
})

test('/replay with nothing recorded says so', async ($, on) => {
  engineBeneath(on)
  const out = await $.command.run({ command: 'replay', args: '', ...RUN })
  expect(out.text).toMatch(/no edits recorded yet/)
})
