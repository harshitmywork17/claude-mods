import { expect, test } from 'claude-code/testing'
import type { RenderElement } from 'claude-code'

import { minimapOf } from '../hooks/minimap'

const ENGINE_ROW: RenderElement = { type: 'Box', children: [{ type: 'Text', children: ['⏺ Update(app/auth.py)'] }] }

const ORIGINAL = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join('\n') + '\n'

const EDIT_OUTPUT = {
  filePath: '/repo/app/auth.py',
  oldString: 'a',
  newString: 'b',
  originalFile: ORIGINAL,
  structuredPatch: [
    { oldStart: 9, oldLines: 3, newStart: 9, newLines: 4, lines: [' line 9', '-line 10', '+new 10', '+new 11', ' line 11'] },
    { oldStart: 70, oldLines: 2, newStart: 71, newLines: 1, lines: [' line 70', '-line 71'] },
  ],
  userModified: false,
  replaceAll: false,
}

function row(output: unknown, extra: Partial<{ isRunning: boolean; isErrored: boolean }> = {}) {
  return {
    plugin: 'diff-minimap',
    component: 'ToolUse',
    props: { tool_use_id: 'toolu_1', tool: 'Edit', input: {}, isRunning: false, isErrored: false, isInterrupted: false, output, ...extra },
  } as const
}

test('marks the slices of the file an edit touched', () => {
  const map = minimapOf(EDIT_OUTPUT)
  expect(map?.totalLines).toBe(80)
  expect(map?.marks).toEqual(['changed', 'added', 'none', 'none', 'none', 'none', 'none', 'removed'])
  expect([map?.firstLine, map?.lastLine]).toEqual([10, 72])

  const created = minimapOf({ type: 'create', content: 'a\nb\nc\n', structuredPatch: [], originalFile: null })
  expect(created?.marks).toEqual(['added', 'added', 'added'])
  expect(minimapOf({ structuredPatch: [] })).toBeNull()
})

test('draws the strip beside the engine row and keeps the row', async ($, on) => {
  on('ui.render', () => ENGINE_ROW)

  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...row(EDIT_OUTPUT), surface })
    expect(await ui.find({ type: 'Text', text: '⏺ Update(app/auth.py)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'L10-72' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '/80' })).toBeDefined()
    expect(await ui.findAll({ type: 'Text', text: '█' })).toHaveLength(3)
    await ui.unmount()
  }
})

test('leaves running, failed and empty rows exactly as the engine drew them', async ($, on) => {
  on('ui.render', () => ENGINE_ROW)

  for (const props of [row(EDIT_OUTPUT, { isRunning: true }), row(EDIT_OUTPUT, { isErrored: true }), row(undefined)]) {
    const ui = await $.ui.mount({ ...props, surface: 'terminal' })
    expect(await ui.drawn()).toEqual(ENGINE_ROW)
    await ui.unmount()
  }
})
