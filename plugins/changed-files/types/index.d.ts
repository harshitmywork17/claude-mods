export type ChangedFile = {
  path: string
  added: number
  removed: number
  edits: number
  isNew: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'changed-files': {
      /** Most recently touched first. */
      files: ChangedFile[]
      cwd: string
    }
  }
}
