import { atom, read, update } from 'claude-code'
import type { Register, SessionContextUsage } from 'claude-code'

import type { Reading } from '../types'
import { HISTORY_LENGTH, forecastText, kilo, outlook, sky, sparkline } from './forecast'

const history = atom({ plugin: 'token-weather', key: 'history' } as const, [])
const reading = atom({ plugin: 'token-weather', key: 'reading' } as const, null)
const isHidden = atom({ plugin: 'token-weather', key: 'isHidden' } as const, false)

function toReading(context: SessionContextUsage): Reading | null {
  if (context.percent === undefined) return null
  return { percent: context.percent, tokens: context.tokens ?? 0, window: context.window }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'weather',
      description: 'Token Weather: context forecast (args: show | hide)',
      argumentHint: '[show|hide]',
      immediate: true,
    })

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const now = toReading(e.context)
    if (e.changed.includes('context') && now !== null) {
      await update($, reading, () => now)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined) return ran

    const now = toReading((await $.session.usage()).context)
    if (now !== null) {
      await update($, reading, () => now)
      await update($, history, list => [...list, now.percent].slice(-HISTORY_LENGTH))
    }

    return ran
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, history, () => [])
      await update($, reading, () => null)
    }

    return next(e)
  })

  on('command.run', { command: 'weather' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'hide' || arg === 'show') {
      await update($, isHidden, () => arg === 'hide')
    }

    return { text: forecastText(await read($, history), await read($, reading)) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, reading)
    if (e.props.hasSurvey || now === null || (await read($, isHidden))) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const past = await read($, history)
    const weather = sky(now.percent)

    return (
      <Box flexDirection="row" gap={1}>
        <Text key="sky" color={weather.color} bold>
          {weather.icon} {weather.label}
        </Text>
        <Text key="fill">
          {now.percent}% ({kilo(now.tokens)}/{kilo(now.window)})
        </Text>
        <Text key="spark" color="cyan">
          {sparkline(past)}
        </Text>
        <Text key="outlook" dimColor wrap="truncate-end">
          {outlook(past, now)}
          {weather.advice === undefined ? '' : ` · ${weather.advice}`}
        </Text>
        <Button key="hide" label="hide" plain onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}
