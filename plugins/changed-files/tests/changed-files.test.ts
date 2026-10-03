import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'changed-files',
  component: 'Pane',
  requestId: 'changed-files',
  props: {
    title: 'Changed files',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as const

function engineBeneath(on: On, opened: string[]): void {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'changed-files' } }))
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('tool.call', (_$, e) => {
    if (e.tool === 'Edit') {
      if (e.old_string === 'missing') return { isError: true, result: 'String not found', text: 'String not found' }
      return {
        result: {
          filePath: e.file_path,
          oldString: e.old_string,
          newString: e.new_string,
          originalFile: 'a\nb\n',
          structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: ['-a', '+A', '+A2', ' b'] }],
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
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
}

test('the sidebar lists every touched file with +/- counts', async ($, on) => {
  const opened: string[] = []
  engineBeneath(on, opened)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.py', old_string: 'a', new_string: 'A' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/notes.md', content: 'one\ntwo\nthree\n' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.py', old_string: 'a', new_string: 'A' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.py', old_string: 'missing', new_string: 'x' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect(opened).toEqual(['changed-files'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: '2 files' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '+7' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '−2' })).toBeDefined()
    const paths = (await ui.findAll({ type: 'Text', text: /\.(py|md)$/ })).map(found => found.text)
    expect(paths).toEqual(['src/app.py', 'notes.md'])
    expect(await ui.find({ type: 'Text', text: '×2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'new' })).toBeDefined()
    await ui.unmount()
  }

  const out = await $.command.run({ command: 'changed-files', args: '', ...RUN })
  expect(out.text).toBe('Changed Files: 2 files touched this session.')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'reset' })
  expect(await ui.find({ type: 'Text', text: /No files touched yet/ })).toBeDefined()
})

test('/clear empties the list', async ($, on) => {
  engineBeneath(on, [])
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))

  await $.tool.call({ tool: 'Write', file_path: '/tmp/a.txt', content: 'x' })
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /No files touched yet/ })).toBeDefined()
})
