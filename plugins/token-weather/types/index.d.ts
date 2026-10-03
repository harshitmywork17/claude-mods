export type Reading = { percent: number; tokens: number; window: number }

declare module 'claude-code' {
  interface PluginState {
    'token-weather': {
      history: number[]
      reading: Reading | null
      isHidden: boolean
    }
  }
}
