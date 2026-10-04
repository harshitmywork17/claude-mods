export type AgentStatus = 'running' | 'completed' | 'failed' | 'stopped'

export type CrewAgent = {
  /** The subagent's id, as `$.agent.list()` and its loop's events name it. */
  id: string
  /** Spawn order, from 1. */
  n: number
  title: string
  type: string
  /** The task it was given, cut short. */
  prompt: string
  model?: string
  effort?: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  /** Every token its requests used: input, cached input and output. */
  tokens: number
  /** Input tokens of its latest request: how full its context is. */
  context: number
  /** Its share of the session cost, from the cost added by each of its requests. */
  costUsd: number
  tools: number
  /** The tool it is running now, with what it is about. */
  current?: string
  /** The first line of its final answer, or why it stopped. */
  answer?: string
  parentId?: string
}

export type PlanStatus = 'pending' | 'in_progress' | 'completed'

/** A task from Claude's task list (TaskCreate) or todo list (TodoWrite). */
export type PlanTask = { id: string; subject: string; status: PlanStatus; blockedBy: string[]; owner?: string }

declare module 'claude-code' {
  interface PluginState {
    crew: {
      agents: CrewAgent[]
      tasks: PlanTask[]
      sessionTitle: string
      startedAt: number
      totalTokens: number
      costUsd: number | null
      contextWindow: number
      isCompletedOpen: boolean
      isPlannedOpen: boolean
      expanded: string | null
    }
  }
}
