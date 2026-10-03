export type ReplayEdit = {
  file: string
  kind: 'edit' | 'create' | 'overwrite'
  diff: string
  added: number
  removed: number
  isCut: boolean
}

export type ReplayTurn = { id: string; prompt: string; edits: ReplayEdit[] }

export type Cursor = { turn: number; edit: number }

declare module 'claude-code' {
  interface PluginState {
    'replay-theater': {
      turns: ReplayTurn[]
      cursor: Cursor
      cwd: string
    }
  }
}
