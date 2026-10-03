export type Reading = { percent: number; tokens: number; window: number }

/** One plan limit window as the last response reported it. */
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-forecast': {
      history: number[]
      reading: Reading | null
      limits: Limit[]
      isHidden: boolean
    }
  }
}
