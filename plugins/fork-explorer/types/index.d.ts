export type Approach = {
  title: string
  idea: string
  pros: string[]
  cons: string[]
  effort: string
}

export type Fork = {
  id: string
  question: string
  status: 'thinking' | 'done' | 'error'
  approaches: Approach[]
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'fork-explorer': {
      /** Newest first. */
      forks: Fork[]
      /** Index into forks of the one on screen. */
      viewing: number
    }
  }
}
