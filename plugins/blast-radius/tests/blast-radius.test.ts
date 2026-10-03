import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { assess } from '../hooks/risk'

const PANE = {
  plugin: 'blast-radius',
  component: 'Pane',
  requestId: 'blast-radius',
  props: {
    title: 'Blast Radius',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

function engineBeneath(on: On, probes: string[], below: 'allow' | 'deny' = 'allow'): void {
  mock.clock(on)
  on('process.run', (_$, e) => {
    probes.push(e.argv.join(' '))
    const stdout = e.argv[0] === 'du' ? '12M\tbuild\n' : 'build\nbuild/app.js\nbuild/app.css\n'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  on('tool.check', () => ({ decision: below, reason: 'rule' }))
}

test('classifies risky commands', () => {
  expect(assess('rm -rf build')[0]?.severity).toBe('high')
  expect(assess('rm -fr /')[0]?.severity).toBe('critical')
  expect(assess('sudo rm --recursive --force ~')[0]?.severity).toBe('critical')
  expect(assess('rm -r build')).toHaveLength(0)
  expect(assess('git reset --hard HEAD~1')[0]?.label).toBe('git reset --hard')
  expect(assess('git push -f origin main')[0]?.label).toBe('git push --force')
  expect(assess('git push origin +main')[0]?.label).toBe('git push --force')
  expect(assess('git push origin main')).toHaveLength(0)
  expect(assess('git clean -fdx')[0]?.probes[0]?.argv).toEqual(['git', 'clean', '-n', '-d', '-x'])
  expect(assess('git checkout -- .')[0]?.label).toBe('git checkout .')
  expect(assess('git branch -D old')[0]?.probes[0]?.argv).toContain('old')
  expect(assess('psql -c "DROP TABLE users"')[0]?.severity).toBe('critical')
  expect(assess('echo "rm -rf /"')).toHaveLength(0)
  expect(assess('ls && cd web && rm -rf dist')[0]?.cwd).toBe('web')
  expect(assess('npm test; git status')).toHaveLength(0)
})

test('a risky Bash call is measured, shown in the pane and forced to ask', async ($, on) => {
  const probes: string[] = []
  engineBeneath(on, probes)

  const ran = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  expect(ran.isError).toBeUndefined()
  expect(probes).toEqual(['du -sh -- build', 'find build -maxdepth 2'])

  const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' } })
  expect(verdict.decision).toBe('ask')
  expect(verdict.reason).toMatch(/rm -rf build/)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /RISKY rm -rf build/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ran$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /12M/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /build\/app\.css/ })).toBeDefined()
    await ui.unmount()
  }
})

test('safe commands pass straight through', async ($, on) => {
  const probes: string[] = []
  engineBeneath(on, probes)

  await $.tool.call({ tool: 'Bash', command: 'ls -la && git status' })
  const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'ls -la' } })

  expect(probes).toHaveLength(0)
  expect(verdict.decision).toBe('allow')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /No risky commands/ })).toBeDefined()
})

test('a deny from below is never loosened to ask', async ($, on) => {
  engineBeneath(on, [], 'deny')

  const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' } })
  expect(verdict.decision).toBe('deny')
})

test('/blast-radius <command> is a dry run and clear empties the pane', async ($, on) => {
  const probes: string[] = []
  engineBeneath(on, probes)

  const out = await $.command.run({
    command: 'blast-radius',
    args: 'git reset --hard',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  expect(out.text).toMatch(/dry run/)
  expect(probes).toEqual(['git status --short', 'git diff --stat HEAD'])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /dry run, nothing executed/ })).toBeDefined()
  await ui.press({ key: 'clear' })
  expect(await ui.find({ type: 'Text', text: /No risky commands/ })).toBeDefined()
})
