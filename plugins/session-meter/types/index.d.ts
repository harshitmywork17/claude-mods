export type Meter = {
  tools: number
  files: string[]
  turnTools: number
  turnFiles: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'session-meter': { meter: Meter }
  }
}
