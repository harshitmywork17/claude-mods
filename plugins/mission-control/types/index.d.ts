export type StepStatus = 'running' | 'ok' | 'error' | 'denied'

export type AgentRun = {
  agentId?: string
  type: string
  description: string
  toolCount?: number
  tokens?: number
}

export type Step = {
  id: string
  /** 'main', or the subagent's id. */
  lane: string
  tool: string
  summary: string
  startedAt: number
  endedAt?: number
  status: StepStatus
  /** First lines of what the tool returned, or why it failed. */
  output: string
  agent?: AgentRun
}

export type Lane = { id: string; label: string }

export type TurnStatus = 'running' | 'done' | 'interrupted' | 'failed'

export type Turn = {
  id: string
  prompt: string
  startedAt: number
  endedAt?: number
  status: TurnStatus
  steps: Step[]
  lanes: Lane[]
  inputTokens?: number
  outputTokens?: number
}

export type View = 'timeline' | 'details'

declare module 'claude-code' {
  interface PluginState {
    'mission-control': {
      /** Oldest first, newest last. */
      turns: Turn[]
      /** How many turns back from the newest the pane shows; 0 is the newest. */
      back: number
      view: View
    }
  }
}
