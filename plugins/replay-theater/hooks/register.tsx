import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ReplayTurn } from '../types'
import { changeOf } from './diff'
import type { FileResult } from './diff'
import { clamp, prune, stepEdit, stepTurn } from './nav'

const PANE = 'replay-theater'
const turns = atom({ plugin: 'replay-theater', key: 'turns' } as const, [])
const cursor = atom({ plugin: 'replay-theater', key: 'cursor' } as const, { turn: 0, edit: 0 })
const cwd = atom({ plugin: 'replay-theater', key: 'cwd' } as const, '')

const KIND_TEXT = { edit: 'edited', create: 'created', overwrite: 'rewritten' } as const

async function recorded($: EngineInterface): Promise<ReplayTurn[]> {
  return prune(await read($, turns))
}

async function move($: EngineInterface, how: 'next' | 'prev' | 'older' | 'newer'): Promise<void> {
  const list = await recorded($)
  await update($, cursor, at => {
    if (how === 'next') return stepEdit(at, list, 1)
    if (how === 'prev') return stepEdit(at, list, -1)
    return stepTurn(at, list, how === 'newer' ? 1 : -1)
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'replay',
      description: 'Replay Theater: step through the diffs of the last turn (/replay 2 = the turn before)',
      argumentHint: '[turns back]',
      immediate: true,
    })
    await update($, cwd, () => e.cwd)

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const turn: ReplayTurn = { id: e.turnId, prompt: e.text.replace(/\s+/g, ' ').slice(0, 80), edits: [] }
    await update($, turns, list => [...prune(list), turn])

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool !== 'Edit' && e.tool !== 'Write') return next(e)

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    const change = changeOf(ran.result as FileResult, await read($, cwd))
    if (change !== null) {
      await update($, turns, list => {
        const current = list[list.length - 1] ?? { id: 'earlier', prompt: '(before this session’s first prompt)', edits: [] }
        return [...list.slice(0, -1), { ...current, edits: [...current.edits, change] }]
      })
    }

    return ran
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, turns, () => [])

    return next(e)
  })

  on('command.run', { command: 'replay' }, async ($, e) => {
    const list = await recorded($)
    if (list.length === 0) return { text: 'Replay Theater: no edits recorded yet.' }

    const back = Math.max(1, Number.parseInt(e.args.trim() || '1', 10) || 1)
    const at = clamp({ turn: list.length - back, edit: 0 }, list)
    await update($, cursor, () => at)
    await $.ui.open({ id: PANE, title: 'Replay Theater', focus: true, closeOnEscape: true })

    const turn = list[at.turn]
    const count = turn?.edits.length ?? 0
    return { text: `Replay Theater: ${count} edit${count === 1 ? '' : 's'} from “${turn?.prompt ?? ''}”. n/p step, o/w change turn, Esc closes.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Code, Text } = $.ui.resolve(e)
    const list = await recorded($)
    const at = clamp(await read($, cursor), list)
    const turn = list[at.turn]
    const edit = turn?.edits[at.edit]

    if (turn === undefined || edit === undefined) {
      return <Text dimColor>No edits recorded yet. Run /replay after Claude edits a file.</Text>
    }

    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">
          Turn {at.turn + 1}/{list.length} · edit {at.edit + 1}/{turn.edits.length} · “{turn.prompt}”
        </Text>
        <Box flexDirection="row" gap={1}>
          <Text bold wrap="truncate-end">{edit.file}</Text>
          <Text color="green">+{edit.added}</Text>
          <Text color="red">−{edit.removed}</Text>
          <Text dimColor>{KIND_TEXT[edit.kind]}</Text>
        </Box>
        {edit.diff === '' ? (
          <Text dimColor>(no diff available for this change)</Text>
        ) : (
          <Code source={edit.diff} format="diff" path={edit.file} />
        )}
        {edit.isCut && <Text dimColor>… diff cut to fit</Text>}
        <Box flexDirection="row" gap={1} marginTop={1}>
          <Button key="prev" label="prev" hotkey="p" onPress={() => move($, 'prev')} />
          <Button key="next" label="next" hotkey="n" variant="primary" onPress={() => move($, 'next')} />
          <Button key="older" label="older turn" hotkey="o" onPress={() => move($, 'older')} />
          <Button key="newer" label="newer turn" hotkey="w" onPress={() => move($, 'newer')} />
        </Box>
      </Box>
    )
  })
}
