import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Fork } from '../types'
import { forkPrompt, parseApproaches, promptFor } from './approaches'

const PANE = 'fork-explorer'
const MAX_FORKS = 5
const WIDE_ENOUGH = 100
const forks = atom({ plugin: 'fork-explorer', key: 'forks' } as const, [])
const viewing = atom({ plugin: 'fork-explorer', key: 'viewing' } as const, 0)

const REASON_TEXT: Record<string, string> = {
  'nothing-to-fork': 'There is no conversation to explore yet. Ask Claude something first.',
  'api-error': 'The side question failed (API error). Try again.',
  'empty-reply': 'The side question came back empty. Try rephrasing.',
  aborted: 'The side question was cancelled.',
}

async function setFork($: EngineInterface, id: string, change: Partial<Fork>): Promise<void> {
  await update($, forks, list => list.map(one => (one.id === id ? { ...one, ...change } : one)))
}

/** Runs one side question over the session and records its approaches. Never touches the conversation. */
async function explore($: EngineInterface, question: string): Promise<Fork | undefined> {
  const id = `fork-${await $.clock.now()}`
  const fork: Fork = { id, question, status: 'thinking', approaches: [] }
  await update($, forks, list => [fork, ...list].slice(0, MAX_FORKS))
  await update($, viewing, () => 0)

  const reply = await $.model.fork({ prompt: forkPrompt(question) })
  if (!reply.isAnswered) {
    await setFork($, id, { status: 'error', error: REASON_TEXT[reply.reason] ?? `No answer (${reply.reason}).` })
  } else {
    const approaches = parseApproaches(reply.text)
    await setFork(
      $,
      id,
      approaches.length === 0
        ? { status: 'error', error: 'The answer could not be read as approaches. Try again.' }
        : { status: 'done', approaches },
    )
  }
  return (await read($, forks)).find(one => one.id === id)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'fork',
      description: 'Fork Explorer: "what if..." side question with 2-3 alternatives, kept out of the conversation',
      argumentHint: '[what if...]',
      immediate: true,
    })

    return next(e)
  })

  on('command.run', { command: 'fork' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'Fork Explorer', focus: true, closeOnEscape: true })
    const question = e.args.trim()
    if (question !== '') await explore($, question)

    return {}
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, forks, () => [])

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, forks)
    const at = Math.min(await read($, viewing), Math.max(0, list.length - 1))
    const fork = list[at]
    const isWide = e.props.bodyColumns >= WIDE_ENOUGH
    const table = $.ui.resolve(e)
    const ask =
      'Input' in table ? (
        <table.Input
          key="ask"
          label="What if…"
          placeholder="we used Redis instead of Postgres for sessions?"
          submitLabel="explore"
          autoFocus
          onSubmit={value => (value.trim() === '' ? undefined : void explore($, value.trim()))}
        />
      ) : null

    return (
      <Box flexDirection="column">
        {ask}
        {fork === undefined && (
          <Text dimColor>Ask a "what if…" question. The answer stays here and never enters your conversation.</Text>
        )}
        {fork !== undefined && (
          <Box flexDirection="column" marginTop={1}>
            <Box flexDirection="row" gap={1}>
              <Text bold wrap="truncate-end">
                What if {fork.question}
              </Text>
              {list.length > 1 && (
                <Text dimColor>
                  ({at + 1}/{list.length})
                </Text>
              )}
            </Box>
            {fork.status === 'thinking' && <Text color="cyan">Exploring alternatives…</Text>}
            {fork.status === 'error' && <Text color="red">{fork.error}</Text>}
            {fork.status === 'done' && (
              <Box flexDirection={isWide ? 'row' : 'column'} gap={1} marginTop={1}>
                {fork.approaches.map((approach, index) => (
                  <Box
                    key={`card-${index}`}
                    flexDirection="column"
                    borderStyle="round"
                    borderColor="cyan"
                    paddingX={1}
                    width={isWide ? `${Math.floor(100 / fork.approaches.length)}%` : undefined}
                    flexGrow={1}
                  >
                    <Text bold color="cyan">
                      {index + 1}. {approach.title}
                    </Text>
                    <Text dimColor>effort {approach.effort}</Text>
                    <Text>{approach.idea}</Text>
                    {approach.pros.map(pro => (
                      <Text color="green">+ {pro}</Text>
                    ))}
                    {approach.cons.map(con => (
                      <Text color="red">− {con}</Text>
                    ))}
                    <Button
                      key={`use-${index}`}
                      label="use this"
                      hotkey={String(index + 1)}
                      onPress={async () => {
                        await $.prompt.fill({ text: promptFor(fork.question, approach), mode: 'replace' })
                        $.ui.toast('Fork Explorer: put in your prompt. Edit it, then send.')
                      }}
                    />
                  </Box>
                ))}
              </Box>
            )}
            <Box flexDirection="row" gap={1} marginTop={1}>
              {at < list.length - 1 && (
                <Button key="older" label="older" hotkey="o" onPress={() => update($, viewing, n => n + 1)} />
              )}
              {at > 0 && <Button key="newer" label="newer" hotkey="w" onPress={() => update($, viewing, n => n - 1)} />}
              {fork.status !== 'thinking' && (
                <Button key="again" label="ask again" hotkey="a" onPress={() => void explore($, fork.question)} />
              )}
            </Box>
          </Box>
        )}
      </Box>
    )
  })
}
