import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, RenderNode, Register } from 'claude-code'

import type { CrewAgent, PlanTask } from '../types'
import { C, applyTask, clock, firstLine, head, modelLabel, money, sprite, statusOf, tierOf, tokens, waitingOn } from './crew'
import type { Cell, TaskEvent, Tier } from './crew'

// ── State ───────────────────────────────────────────────────────────────

const agentsAtom = atom({ plugin: 'crew', key: 'agents' } as const, [])
const tasksAtom = atom({ plugin: 'crew', key: 'tasks' } as const, [])
const titleAtom = atom({ plugin: 'crew', key: 'sessionTitle' } as const, '')
const startedAtAtom = atom({ plugin: 'crew', key: 'startedAt' } as const, 0)
const totalTokensAtom = atom({ plugin: 'crew', key: 'totalTokens' } as const, 0)
const costAtom = atom({ plugin: 'crew', key: 'costUsd' } as const, null)
const windowAtom = atom({ plugin: 'crew', key: 'contextWindow' } as const, 200_000)
const completedOpenAtom = atom({ plugin: 'crew', key: 'isCompletedOpen' } as const, true)
const plannedOpenAtom = atom({ plugin: 'crew', key: 'isPlannedOpen' } as const, true)
const expandedAtom = atom({ plugin: 'crew', key: 'expanded' } as const, null)

const PANE = 'crew'
const TITLE = 'Agents'
const AUTO_OPEN_KEY = 'autoOpen'
const SPRITE_WIDTH = 8

/** The session cost when it was last read: each request is charged the growth since. */
let lastCostUsd: number | null = null
let hasAutoOpened = false

// ── Recording ───────────────────────────────────────────────────────────

async function changeAgent($: EngineInterface, id: string, change: (agent: CrewAgent) => CrewAgent): Promise<void> {
  await update($, agentsAtom, (list): CrewAgent[] => list.map(agent => (agent.id === id ? change(agent) : agent)))
}

/** The session's cost now, and how much it grew since the last read. */
async function costGrowth($: EngineInterface): Promise<number> {
  const usd = (await $.session.usage()).cost?.usd
  if (usd === undefined) return 0
  const grown = lastCostUsd === null ? 0 : Math.max(0, usd - lastCostUsd)
  lastCostUsd = usd
  await update($, costAtom, () => usd)
  return grown
}

/** Folds the engine's list of agents in: statuses it settled, and agents started before this mod loaded. */
async function syncList($: EngineInterface): Promise<void> {
  const listed = await $.agent.list()
  const now = await $.clock.now()
  await update($, agentsAtom, (list): CrewAgent[] => {
    const next = list.map(agent => {
      const info = listed.find(one => one.id === agent.id)
      if (info === undefined || agent.status !== 'running') return agent
      const status = statusOf(info.status)
      return status === 'running' ? agent : { ...agent, status, endedAt: agent.endedAt ?? now, current: undefined }
    })
    for (const info of listed) {
      if (next.some(agent => agent.id === info.id)) continue
      next.push({
        id: info.id,
        n: next.length + 1,
        title: info.description || info.name || info.type,
        type: info.type,
        prompt: '',
        status: statusOf(info.status),
        startedAt: now,
        tokens: 0,
        context: 0,
        costUsd: 0,
        tools: 0,
        parentId: info.parentId,
      })
    }
    return next
  })
}

function toolSummary(tool: string, input: Record<string, unknown>): string {
  const text = (key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '')
  if (tool === 'Read' || tool === 'Edit' || tool === 'Write') return text('file_path').split('/').pop() ?? ''
  if (tool === 'Bash') return text('command')
  if (tool === 'Grep' || tool === 'Glob') return text('pattern')
  if (tool === 'WebFetch') return text('url')
  if (tool === 'WebSearch') return text('query')
  const first = Object.values(input).find(value => typeof value === 'string')
  return typeof first === 'string' ? first : ''
}

/** What a task-list or todo tool call did to the plan, from its input and result. */
function taskEvent(tool: string, input: Record<string, unknown>, result: unknown): TaskEvent | null {
  const record = (result ?? {}) as Record<string, unknown>
  if (tool === 'TaskCreate') {
    const task = record.task as { id?: unknown; subject?: unknown } | undefined
    if (typeof task?.id !== 'string') return null
    return { kind: 'create', id: task.id, subject: typeof task.subject === 'string' ? task.subject : String(input.subject ?? '') }
  }
  if (tool === 'TaskUpdate' && typeof input.taskId === 'string') {
    return {
      kind: 'update',
      id: input.taskId,
      subject: typeof input.subject === 'string' ? input.subject : undefined,
      status: typeof input.status === 'string' ? input.status : undefined,
      addBlockedBy: Array.isArray(input.addBlockedBy) ? input.addBlockedBy.filter((id): id is string => typeof id === 'string') : undefined,
      owner: typeof input.owner === 'string' ? input.owner : undefined,
    }
  }
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
    const todos = input.todos
      .filter((todo): todo is { content: string; status: string } => typeof todo === 'object' && todo !== null && typeof (todo as { content?: unknown }).content === 'string')
      .map(todo => ({ content: todo.content, status: String(todo.status) }))
    return { kind: 'todos', todos }
  }
  return null
}

async function openPane($: EngineInterface, isAsked: boolean): Promise<void> {
  const opened = await $.ui.open(isAsked ? { id: PANE, title: TITLE, focus: true } : { id: PANE, title: TITLE })
  if (isAsked && !opened.isPlaced) $.ui.toast(`Crew is waiting for room: ${opened.reason}`)
}

// ── Drawing ─────────────────────────────────────────────────────────────

type T = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

const STATUS_MARK = {
  running: ['●', C.live],
  completed: ['✓', C.ok],
  failed: ['✗', C.bad],
  stopped: ['⊘', C.warn],
} as const

function spriteView(t: T, rows: Cell[][]): RenderNode {
  const { Box, Text } = t
  return (
    <Box flexDirection="column" width={SPRITE_WIDTH} flexShrink={0}>
      {rows.map((cells, row) => (
        <Text key={`sprite-row-${row}`}>
          {cells.map((cell, index) => (
            <Text key={`sprite-${row}-${index}`} color={cell.fg} backgroundColor={cell.bg}>
              {cell.char}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  )
}

function bar(t: T, share: number, width: number, color: string): RenderNode {
  const { Text } = t
  const filled = Math.max(share > 0 ? 1 : 0, Math.min(width, Math.round(share * width)))
  return (
    <Text>
      <Text color={color}>{'━'.repeat(filled)}</Text>
      <Text color={C.track}>{'━'.repeat(width - filled)}</Text>
    </Text>
  )
}

function card(t: T, label: string, value: string, width: number): RenderNode {
  const { Box, Text } = t
  return (
    <Box key={`card-${label}`} flexDirection="column" width={width} flexShrink={0} borderStyle="round" borderColor={C.track} paddingX={1}>
      <Text color={C.soft}>{label}</Text>
      <Text bold color={C.text}>
        {value}
      </Text>
    </Box>
  )
}

function agentRow($: EngineInterface, t: T, agent: CrewAgent, window: number, now: number, frame: number, isOpen: boolean, width: number): RenderNode {
  const { Box, Button, Text } = t
  const tier: Tier = tierOf(agent.effort)
  const textWidth = Math.max(16, width - SPRITE_WIDTH - 2 - 3)
  const share = window > 0 ? agent.context / window : 0
  const elapsed = (agent.endedAt ?? now) - agent.startedAt
  const [mark, markColor] = STATUS_MARK[agent.status]
  const stats = `ctx ${Math.round(share * 100)}% · ${tokens(agent.tokens)} ${money(agent.costUsd)} ${clock(elapsed)}`
  return (
    <Box key={`agent-${agent.id}`} flexDirection="column">
      <Box flexDirection="row" marginTop={1}>
        {spriteView(t, sprite(tier, agent.status, frame))}
        <Box width={2} flexShrink={0} />
        <Box flexDirection="column" width={textWidth} flexShrink={0}>
          <Button key={`open:${agent.id}`} label={head(`${agent.n}. ${agent.title}`, textWidth)} plain onPress={() => update($, expandedAtom, now => (now === agent.id ? null : agent.id))} />
          <Text wrap="truncate-end">
            <Text color={tier.color}>{tier.label}</Text>
            <Text color={C.soft}>
              {' '}
              {modelLabel(agent.model)}
              {agent.effort === undefined ? '' : ` · ${agent.effort}`}
            </Text>
          </Text>
          <Text color={C.soft} wrap="truncate-end">
            {stats}
          </Text>
          {bar(t, share, Math.max(8, textWidth - 4), tier.color)}
          {agent.status === 'running' && agent.current !== undefined && (
            <Text color={C.live} wrap="truncate-end">
              ▸ {agent.current}
            </Text>
          )}
        </Box>
        <Box width={3} flexShrink={0} justifyContent="flex-end">
          <Text bold color={agent.status === 'running' ? (frame % 2 === 0 ? tier.color : C.line) : markColor}>
            {mark}
          </Text>
        </Box>
      </Box>
      {isOpen && (
        <Box flexDirection="column" paddingLeft={SPRITE_WIDTH + 2} marginTop={1}>
          <Text color={C.soft} wrap="truncate-end">
            {agent.type} · {agent.tools} tool call{agent.tools === 1 ? '' : 's'} · {agent.id}
          </Text>
          {agent.prompt !== '' && (
            <Text color={C.line} wrap="wrap">
              {head(agent.prompt, 300)}
            </Text>
          )}
          {agent.answer !== undefined && (
            <Text color={agent.status === 'failed' ? C.bad : C.text} wrap="wrap">
              ↳ {agent.answer}
            </Text>
          )}
        </Box>
      )}
      <Text color={C.track}>{'─'.repeat(width)}</Text>
    </Box>
  )
}

function planRow(t: T, task: PlanTask, tasks: readonly PlanTask[], width: number): RenderNode {
  const { Box, Text } = t
  const waits = waitingOn(task, tasks)
  const textWidth = Math.max(16, width - SPRITE_WIDTH - 2 - 3)
  const label = task.id.startsWith('todo-') ? task.id.slice(5) : task.id
  return (
    <Box key={`plan-${task.id}`} flexDirection="column">
      <Box flexDirection="row" marginTop={1}>
        {spriteView(t, sprite(tierOf(undefined), 'planned', 0))}
        <Box width={2} flexShrink={0} />
        <Box flexDirection="column" width={textWidth} flexShrink={0}>
          <Text bold color={C.text} wrap="truncate-end">
            {label}. {task.subject}
          </Text>
          <Text wrap="truncate-end">
            {task.status === 'in_progress' ? <Text color={C.live}>in progress</Text> : waits.length === 0 ? <Text color={C.ok}>ready</Text> : <Text color={C.warn}>waiting</Text>}
            <Text color={C.soft}>
              {waits.length > 0 ? ` · after ${waits.join(', ')}` : ''}
              {task.owner === undefined ? '' : ` · ${task.owner}`}
            </Text>
          </Text>
        </Box>
        <Box width={3} flexShrink={0} justifyContent="flex-end">
          <Text color={task.status === 'in_progress' ? C.live : C.soft}>{task.status === 'in_progress' ? '◐' : '◷'}</Text>
        </Box>
      </Box>
      <Text color={C.track}>{'─'.repeat(width)}</Text>
    </Box>
  )
}

function sectionTitle(t: T, label: string, count: number): RenderNode {
  const { Text } = t
  return (
    <Text key={`section-${label}`} color={C.text}>
      {label} <Text color={C.soft}>· {count}</Text>
    </Text>
  )
}

// ── Hooks ───────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'crew', description: 'Agents pane: every subagent with model, effort, context, tokens, cost and time', argumentHint: '[auto on|off|close]', immediate: true })
    $.clock.after(0, () => {
      void (async () => {
        const usage = await $.session.usage()
        await update($, startedAtAtom, () => usage.startedAt)
        await update($, windowAtom, () => usage.context.window)
        lastCostUsd = usage.cost?.usd ?? null
        await update($, costAtom, () => usage.cost?.usd ?? null)
        await syncList($)
      })().catch(() => undefined)
    })
    let ticks = 0
    $.clock.every(1000, () => {
      ticks += 1
      void (async () => {
        const isBusy = (await read($, agentsAtom)).some(agent => agent.status === 'running')
        if (!isBusy) return
        $.ui.invalidate('ui.render')
        if (ticks % 5 === 0) await syncList($)
      })().catch(() => undefined)
    })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const text = e.text.trim()
    if (text !== '' && !text.startsWith('<') && (await read($, titleAtom)) === '') await update($, titleAtom, () => firstLine(text, 60))
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.agentId === undefined) return started
    try {
      const id = started.agentId
      const now = await $.clock.now()
      await update($, agentsAtom, (list): CrewAgent[] =>
        list.some(agent => agent.id === id)
          ? list
          : [
              ...list,
              {
                id,
                n: list.length + 1,
                title: firstLine(e.description || e.name || e.subagentType, 80),
                type: e.subagentType,
                prompt: firstLine(e.prompt, 400),
                model: started.model,
                status: 'running',
                startedAt: now,
                tokens: 0,
                context: 0,
                costUsd: 0,
                tools: 0,
                parentId: e.parentAgentId,
              },
            ],
      )
      if (!hasAutoOpened && (await $.store.get(AUTO_OPEN_KEY)) !== false) {
        hasAutoOpened = true
        await openPane($, false)
      }
    } catch {
      // Watching is best effort: the spawn's own result always goes back unchanged.
    }
    return started
  })

  on('turn.step', async function* ($, e, next) {
    const answered = yield* next(e)
    try {
      const usage = answered.usage
      if (usage !== null) {
        const context = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
        const spent = context + usage.output_tokens
        await update($, totalTokensAtom, total => total + spent)
        const grown = await costGrowth($)
        const id = e.agentId
        if (id !== undefined) {
          await changeAgent($, id, agent => ({
            ...agent,
            model: e.model || agent.model,
            effort: e.effort === undefined ? agent.effort : String(e.effort),
            tokens: agent.tokens + spent,
            context,
            costUsd: agent.costUsd + grown,
          }))
        }
      }
    } catch {
      // The step's stream and result pass through untouched whatever happens here.
    }
    return answered
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const tool = String(e.tool)
    const id = e.agentId
    if (id !== undefined) {
      await changeAgent($, id, agent => ({ ...agent, tools: agent.tools + 1, current: firstLine(`${tool} ${toolSummary(tool, input)}`, 120) })).catch(() => undefined)
    }
    const ran = await next(e)
    try {
      if (id !== undefined) await changeAgent($, id, agent => ({ ...agent, current: undefined }))
      if (ran.deny === undefined && ran.isError !== true) {
        const event = taskEvent(tool, input, ran.result)
        if (event !== null) await update($, tasksAtom, (tasks): PlanTask[] => applyTask(tasks, event))
      }
    } catch {
      // The tool's own result always goes back unchanged.
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    const id = e.agentId
    if (id === undefined) return ran
    try {
      const now = await $.clock.now()
      const status = statusOf('', e.reason)
      const why = e.reason === 'refusal' ? e.refusal.explanation : e.answer
      await changeAgent($, id, agent => ({ ...agent, status, endedAt: now, current: undefined, answer: firstLine(why ?? '', 240) || undefined }))
    } catch {
      // Best effort.
    }
    return ran
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('cost') && e.cost !== undefined) {
      const usd = e.cost.usd
      await update($, costAtom, () => usd)
    }
    if (e.changed.includes('context')) {
      const window = e.context.window
      await update($, windowAtom, () => window)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, agentsAtom, (): CrewAgent[] => [])
      await update($, tasksAtom, (): PlanTask[] => [])
      await update($, titleAtom, () => '')
      await update($, totalTokensAtom, () => 0)
      await update($, expandedAtom, () => null)
    }
    return next(e)
  })

  on('command.run', { command: 'crew' }, async ($, e) => {
    const [word = '', value = ''] = e.args.trim().split(/\s+/)
    if (word === 'auto') {
      await $.store.set(AUTO_OPEN_KEY, value !== 'off')
      return { text: value === 'off' ? 'Crew no longer opens by itself when a subagent starts.' : 'Crew opens by itself when the first subagent starts.' }
    }
    if (word === 'close') {
      await $.ui.close({ id: PANE })
      return {}
    }
    await syncList($)
    await openPane($, true)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t: T = $.ui.resolve(e)
    const { Box, Button, Text } = t
    const width = Math.max(40, e.props.bodyColumns)
    const now = await $.clock.now()
    const frame = Math.floor(now / 600)
    const agents = await read($, agentsAtom)
    const tasks = await read($, tasksAtom)
    const window = await read($, windowAtom)
    const expanded = await read($, expandedAtom)
    const isCompletedOpen = await read($, completedOpenAtom)
    const isPlannedOpen = await read($, plannedOpenAtom)
    const startedAt = await read($, startedAtAtom)
    const cost = await read($, costAtom)
    const title = await read($, titleAtom)

    const running = agents.filter(agent => agent.status === 'running')
    const done = agents.filter(agent => agent.status !== 'running').reverse()
    const planned = tasks.filter(task => task.status !== 'completed')
    const cardWidth = Math.floor((width - 2) / 3)
    const isAllOpen = isCompletedOpen && isPlannedOpen
    const row = (agent: CrewAgent): RenderNode => agentRow($, t, agent, window, now, frame, expanded === agent.id, width)

    return (
      <Box flexDirection="column">
        <Text bold color={C.text} wrap="truncate-end">
          Agents{title === '' ? '' : ` · ${title}`}
        </Text>
        <Box flexDirection="row" columnGap={1} marginTop={1}>
          {card(t, 'Cost', cost === null ? '–' : money(cost), cardWidth)}
          {card(t, 'Tokens', tokens(await read($, totalTokensAtom)), cardWidth)}
          {card(t, 'Time', startedAt > 0 ? clock(now - startedAt) : '–', cardWidth)}
        </Box>
        {agents.length === 0 && planned.length === 0 ? (
          <Box flexDirection="row" marginTop={1}>
            {spriteView(t, sprite(tierOf(undefined), 'planned', 0))}
            <Box width={2} flexShrink={0} />
            <Box flexDirection="column">
              <Text bold color={C.soft}>
                No crew yet
              </Text>
              <Text color={C.line}>Subagents appear here as Claude starts them, with their model, effort, context, tokens, cost and time.</Text>
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Box marginTop={1}>
              <Button
                key="toggle-all"
                label={isAllOpen ? 'Collapse' : 'Expand'}
                plain
                dimColor
                onPress={async () => {
                  await update($, completedOpenAtom, () => !isAllOpen)
                  await update($, plannedOpenAtom, () => !isAllOpen)
                }}
              />
            </Box>
            {running.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                {sectionTitle(t, 'Running', running.length)}
                {running.map(row)}
              </Box>
            )}
            {done.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Button key="toggle-completed" label={`${isCompletedOpen ? '▾' : '▸'} Completed · ${done.length}`} plain onPress={() => update($, completedOpenAtom, value => !value)} />
                {isCompletedOpen && done.map(row)}
              </Box>
            )}
            {planned.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Button key="toggle-planned" label={`${isPlannedOpen ? '▾' : '▸'} Planned · ${planned.length}`} plain onPress={() => update($, plannedOpenAtom, value => !value)} />
                {isPlannedOpen && planned.map(task => planRow(t, task, tasks, width))}
              </Box>
            )}
          </Box>
        )}
      </Box>
    )
  })
}
