import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { changeOf } from './diff'
import type { FileResult } from './diff'
import { merge } from './merge'

const PANE = 'changed-files'
const files = atom({ plugin: 'changed-files', key: 'files' } as const, [])
const cwd = atom({ plugin: 'changed-files', key: 'cwd' } as const, '')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'changed-files',
      description: 'Changed Files: open the sidebar of files Claude touched this session',
      immediate: true,
    })
    await update($, cwd, () => e.cwd)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool !== 'Edit' && e.tool !== 'Write') return next(e)

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    const change = changeOf(ran.result as FileResult, await read($, cwd))
    if (change !== null) {
      const wasEmpty = (await read($, files)).length === 0
      await update($, files, list => merge(list, change))
      if (wasEmpty) void $.ui.open({ id: PANE, title: 'Changed files' })
    }

    return ran
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, files, () => [])

    return next(e)
  })

  on('command.run', { command: 'changed-files' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Changed files' })
    const count = (await read($, files)).length

    return { text: `Changed Files: ${count} file${count === 1 ? '' : 's'} touched this session.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, files)

    if (list.length === 0) {
      return <Text dimColor>No files touched yet this session.</Text>
    }

    const added = list.reduce((sum, one) => sum + one.added, 0)
    const removed = list.reduce((sum, one) => sum + one.removed, 0)
    const width = Math.max(...list.map(one => `+${one.added}`.length + `−${one.removed}`.length + 1))

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text bold>
            {list.length} file{list.length === 1 ? '' : 's'}
          </Text>
          <Text color="green">+{added}</Text>
          <Text color="red">−{removed}</Text>
        </Box>
        {list.map(one => (
          <Box flexDirection="row" gap={1}>
            <Box width={width} flexShrink={0}>
              <Text color="green">+{one.added}</Text>
              <Text> </Text>
              <Text color="red">−{one.removed}</Text>
            </Box>
            <Text wrap="truncate-start">{one.path}</Text>
            {one.isNew && <Text color="cyan">new</Text>}
            {one.edits > 1 && <Text dimColor>×{one.edits}</Text>}
          </Box>
        ))}
        <Box marginTop={1}>
          <Button key="reset" label="reset" onPress={() => update($, files, () => [])} />
        </Box>
      </Box>
    )
  })
}
