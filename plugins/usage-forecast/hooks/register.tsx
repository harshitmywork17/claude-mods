import { atom, read, update } from 'claude-code'
import type { Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Limit, Reading } from '../types'
import { HISTORY_LENGTH, forecastText, kilo, outlook, sky, sparkline } from './forecast'
import { limitText, meter, sortLimits, viewOf } from './limits'

const history = atom({ plugin: 'usage-forecast', key: 'history' } as const, [])
const reading = atom({ plugin: 'usage-forecast', key: 'reading' } as const, null)
const limits = atom({ plugin: 'usage-forecast', key: 'limits' } as const, [])
const isHidden = atom({ plugin: 'usage-forecast', key: 'isHidden' } as const, false)

/** Countdowns move by the minute, so the band redraws once a minute. */
const TICK_MS = 60_000

function toReading(context: SessionContextUsage): Reading | null {
  if (context.percent === undefined) return null
  return { percent: context.percent, tokens: context.tokens ?? 0, window: context.window }
}

function toLimits(windows: readonly SessionRateLimit[]): Limit[] {
  return sortLimits(windows.map(window => ({ kind: window.kind, percentUsed: window.percentUsed, resetsAt: window.resetsAt })))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'forecast',
      description: 'Usage Forecast: 5-hour and weekly limits with reset times, and the context forecast (args: show | hide)',
      argumentHint: '[show|hide]',
      immediate: true,
    })
    $.clock.every(TICK_MS, () => $.ui.invalidate('ui.render'))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const now = toReading(e.context)
    if (e.changed.includes('context') && now !== null) {
      await update($, reading, () => now)
    }
    if (e.changed.includes('rateLimits')) {
      const windows = toLimits(e.rateLimits)
      await update($, limits, () => windows)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined) return ran

    const usage = await $.session.usage()
    const now = toReading(usage.context)
    if (now !== null) {
      await update($, reading, () => now)
      await update($, history, list => [...list, now.percent].slice(-HISTORY_LENGTH))
    }
    if (usage.rateLimits.length > 0) {
      const windows = toLimits(usage.rateLimits)
      await update($, limits, () => windows)
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

  on('command.run', { command: 'forecast' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'hide' || arg === 'show') {
      await update($, isHidden, () => arg === 'hide')
    }
    const now = await $.clock.now()
    const lines = (await read($, limits)).map(limit => limitText(viewOf(limit, now)))

    return { text: forecastText(await read($, history), await read($, reading), lines) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const context = await read($, reading)
    const windows = await read($, limits)
    if (e.props.hasSurvey || (context === null && windows.length === 0) || (await read($, isHidden))) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const past = await read($, history)
    const weather = context === null ? null : sky(context.percent)
    const barWidth = e.props.bodyColumns >= 110 ? 14 : 8
    const hide = <Button key="hide" label="hide" plain onPress={() => update($, isHidden, () => true)} />

    return (
      <Box flexDirection="column">
        {windows.map((limit, index) => {
          const view = viewOf(limit, now)
          const bar = meter(view.percent, barWidth)
          return (
            <Box key={`limit-${limit.kind}`} flexDirection="row" gap={1}>
              <Box width={7} flexShrink={0}>
                <Text bold>{view.label}</Text>
              </Box>
              <Text>
                <Text color={view.color}>{bar.used}</Text>
                <Text dimColor>{bar.left}</Text>
              </Text>
              <Box width={5} flexShrink={0} justifyContent="flex-end">
                <Text bold color={view.color}>
                  {Math.round(view.percent)}%
                </Text>
              </Box>
              {view.resetIn !== undefined && (
                <Text dimColor wrap="truncate-end">
                  ↻ resets in {view.resetIn} · {view.resetAt}
                </Text>
              )}
              {view.runsOutIn !== undefined && (
                <Text color={view.percent >= 70 ? 'red' : 'yellow'} wrap="truncate-end">
                  ⚠ at this pace, out in {view.runsOutIn}
                </Text>
              )}
              {index === 0 && hide}
            </Box>
          )
        })}
        {context !== null && weather !== null && (
          <Box flexDirection="row" gap={1}>
            <Box width={7} flexShrink={0}>
              <Text bold>Context</Text>
            </Box>
            <Text color={weather.color} bold>
              {weather.icon} {weather.label}
            </Text>
            <Text>
              {context.percent}% ({kilo(context.tokens)}/{kilo(context.window)})
            </Text>
            <Text color="cyan">{sparkline(past)}</Text>
            <Text dimColor wrap="truncate-end">
              {outlook(past, context)}
              {weather.advice === undefined ? '' : ` · ${weather.advice}`}
            </Text>
            {windows.length === 0 && hide}
          </Box>
        )}
      </Box>
    )
  })
}
