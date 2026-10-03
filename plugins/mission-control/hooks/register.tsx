import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, Step, Turn } from '../types'
import {
  BADGE,
  MAX_TURNS,
  bar,
  colorOf,
  modelTime,
  onNewest,
  preview,
  relabel,
  seconds,
  statusOf,
  summarize,
  withStep,
  withStepChange,
} from './trace'

const PANE = 'mission-control'
const TICK_MS = 1000
const turns = atom({ plugin: 'mission-control', key: 'turns' } as const, [])
const back = atom({ plugin: 'mission-control', key: 'back' } as const, 0)
const view = atom({ plugin: 'mission-control', key: 'view' } as const, 'timeline')

const TURN_STATUS = { running: '● running', done: '✓ done', interrupted: '⊘ interrupted', failed: '✗ failed' } as const

async function laneLabel($: EngineInterface, laneId: string): Promise<string> {
  if (laneId === 'main') return 'Main'
  try {
    const agent = (await $.agent.list()).find(one => one.id === laneId)
    if (agent !== undefined) return `${agent.name ?? agent.type}: ${agent.description}`
  } catch {
    // The list is a nicety; a lane without it is labelled by id.
  }
  return `Subagent ${laneId.slice(0, 8)}`
}

function agentRunOf(input: Record<string, unknown>, result: unknown): AgentRun {
  const record = (result ?? {}) as Record<string, unknown>
  const num = (key: string): number | undefined => (typeof record[key] === 'number' ? (record[key] as number) : undefined)
  return {
    agentId: typeof record.agentId === 'string' ? record.agentId : undefined,
    type: typeof input.subagent_type === 'string' ? input.subagent_type : 'general-purpose',
    description: typeof input.description === 'string' ? input.description : '',
    toolCount: num('totalToolUseCount'),
    tokens: num('totalTokens'),
  }
}

export const register: Register = on => {
  let isBusy = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mission',
      description: 'Mission Control: live view of tool calls, outputs, subagents and timing',
      immediate: true,
    })
    $.clock.every(TICK_MS, () => {
      if (isBusy) $.ui.invalidate('ui.render')
    })

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    const turn: Turn = {
      id: e.turnId,
      prompt: e.text.replace(/\s+/g, ' ').slice(0, 100),
      startedAt: now,
      status: 'running',
      steps: [],
      lanes: [{ id: 'main', label: 'Main' }],
    }
    await update($, turns, list => [...list, turn].slice(-MAX_TURNS))
    await update($, back, () => 0)
    isBusy = true

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const lane = e.agentId ?? 'main'
    const now = await $.clock.now()
    const step: Step = {
      id: e.tool_use_id,
      lane,
      tool: String(e.tool),
      summary: summarize(String(e.tool), input),
      startedAt: now,
      status: 'running',
      output: '',
    }
    const known = (await read($, turns)).at(-1)?.lanes.some(one => one.id === lane) ?? false
    const label = known ? '' : await laneLabel($, lane)
    await update($, turns, list => onNewest(list, now, turn => withStep(turn, step, label)))
    isBusy = true

    const ran = await next(e)

    const status = statusOf(ran)
    const change: Partial<Step> = {
      endedAt: await $.clock.now(),
      status,
      output: preview(status === 'denied' ? ran.deny : ran.text),
    }
    if (e.tool === 'Agent' && status === 'ok') {
      const agent = agentRunOf(input, ran.result)
      change.agent = agent
      if (agent.agentId !== undefined) {
        const label = `${agent.type}${agent.description === '' ? '' : `: ${agent.description}`}`
        await update($, turns, list => relabel(list, agent.agentId ?? '', label))
      }
    }
    await update($, turns, list => withStepChange(list, step.id, change))

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined) return ran

    const endedAt = await $.clock.now()
    const status = e.reason === 'aborted' ? 'interrupted' : e.reason === 'answer' ? 'done' : 'failed'
    await update($, turns, list =>
      onNewest(list, endedAt, turn => ({
        ...turn,
        endedAt,
        status,
        inputTokens: e.usage?.input_tokens,
        outputTokens: e.usage?.output_tokens,
      })),
    )
    isBusy = false

    return ran
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, turns, () => [])

    return next(e)
  })

  on('command.run', { command: 'mission' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Mission Control' })

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, turns)
    const offset = Math.min(await read($, back), Math.max(0, list.length - 1))
    const turn = list[list.length - 1 - offset]
    const mode = await read($, view)
    const now = await $.clock.now()

    if (turn === undefined) {
      return <Text dimColor>Waiting for the next turn. Tool calls, subagents and timings appear here live.</Text>
    }

    const total = (turn.endedAt ?? now) - turn.startedAt
    const columns = e.props.bodyColumns
    const barWidth = Math.max(10, Math.floor(columns * 0.35))
    const summaryWidth = Math.max(8, columns - barWidth - 24)
    const tools = turn.steps.length
    const failed = turn.steps.filter(step => step.status === 'error' || step.status === 'denied').length

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text bold color={turn.status === 'running' ? 'cyan' : turn.status === 'done' ? 'green' : 'yellow'}>
            {TURN_STATUS[turn.status]}
          </Text>
          <Text dimColor>
            turn {list.length - offset}/{list.length} · {seconds(total)}
          </Text>
        </Box>
        <Text wrap="truncate-end">“{turn.prompt}”</Text>
        <Text dimColor>
          {tools} tool call{tools === 1 ? '' : 's'}
          {failed > 0 ? ` · ${failed} failed` : ''} · {turn.lanes.length - 1} subagent
          {turn.lanes.length === 2 ? '' : 's'} · model {seconds(modelTime(turn, now))}
          {turn.outputTokens === undefined ? '' : ` · ${turn.inputTokens ?? 0} in / ${turn.outputTokens} out tokens`}
        </Text>
        {turn.lanes.map(lane => {
          const steps = turn.steps.filter(step => step.lane === lane.id)
          if (steps.length === 0 && lane.id !== 'main') return null
          return (
            <Box key={`lane-${lane.id}`} flexDirection="column" marginTop={1}>
              <Text bold color={lane.id === 'main' ? 'white' : 'magenta'} wrap="truncate-end">
                {lane.id === 'main' ? '▌Main' : `▌⑂ ${lane.label}`}
              </Text>
              {steps.length === 0 && <Text dimColor>  no tool calls yet</Text>}
              {steps.map(step => {
                const color = colorOf(step, now)
                const { pad, fill } = bar(step, turn, now, barWidth)
                return (
                  <Box key={`step-${step.id}`} flexDirection="column">
                    <Box flexDirection="row">
                      <Box width={3} flexShrink={0}>
                        <Text color={color}> {BADGE[step.status]}</Text>
                      </Box>
                      <Box width={12} flexShrink={0}>
                        <Text bold wrap="truncate-end">{step.tool}</Text>
                      </Box>
                      <Box width={summaryWidth} flexShrink={1}>
                        <Text dimColor wrap="truncate-end">{step.summary}</Text>
                      </Box>
                      {mode === 'timeline' && (
                        <Box width={barWidth} flexShrink={0}>
                          <Text>{pad}</Text>
                          <Text color={color}>{fill}</Text>
                        </Box>
                      )}
                      <Box width={8} flexShrink={0} justifyContent="flex-end">
                        <Text color={color}>{seconds((step.endedAt ?? now) - step.startedAt)}</Text>
                      </Box>
                    </Box>
                    {step.agent !== undefined && (
                      <Text color="magenta">
                        {'    '}⑂ subagent {step.agent.type}
                        {step.agent.toolCount === undefined ? '' : ` · ${step.agent.toolCount} tools`}
                        {step.agent.tokens === undefined ? '' : ` · ${step.agent.tokens} tokens`}
                      </Text>
                    )}
                    {mode === 'details' && step.output !== '' && (
                      <Text dimColor wrap="truncate-end">
                        {'    ↳ '}
                        {step.output.replace(/\n/g, ' ⏎ ')}
                      </Text>
                    )}
                  </Box>
                )
              })}
            </Box>
          )
        })}
        <Box flexDirection="row" gap={1} marginTop={1}>
          <Button
            key="view"
            label={mode === 'timeline' ? 'show outputs' : 'show timeline'}
            hotkey="v"
            onPress={() => update($, view, current => (current === 'timeline' ? 'details' : 'timeline'))}
          />
          {offset < list.length - 1 && (
            <Button key="older" label="older turn" hotkey="o" onPress={() => update($, back, n => n + 1)} />
          )}
          {offset > 0 && <Button key="newer" label="newer turn" hotkey="w" onPress={() => update($, back, n => n - 1)} />}
        </Box>
      </Box>
    )
  })
}
