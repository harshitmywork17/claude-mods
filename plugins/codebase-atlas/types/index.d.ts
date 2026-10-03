/** A folder of source files: one box on the map. */
export type Group = {
  id: string
  files: number
  lines: number
  symbols: number
  /** 0 for folders that import nothing in the repo; higher for folders built on top of others. */
  level: number
}

/** `from` imports `to`, `count` times across their files. */
export type Edge = { from: string; to: string; count: number }

export type Graph = {
  root: string
  /** False when the folder has no git: changes are then measured against the first scan's snapshot. */
  isGit: boolean
  files: number
  groups: Group[]
  edges: Edge[]
  isTruncated: boolean
}

export type ScanStatus = 'idle' | 'scanning' | 'ready' | 'no-folder' | 'error'

/** What Claude did to one file this session; `path` is absolute as the tools name it. */
export type Activity = { path: string; reads: number; edits: number }

/** A place in the code: a definition, a caller or a callee. */
export type Site = { symbol: string; file: string; line: number; isKnown: boolean }

export type CallView = {
  symbol: string
  status: 'loading' | 'ready' | 'missing' | 'error'
  definition?: Site
  callers: Site[]
  callees: Site[]
  error?: string
}

export type SymbolKind = 'class' | 'function' | 'method'

/** One function, method or class of a file, with what it calls. */
export type OutlineEntry = {
  name: string
  kind: SymbolKind
  line: number
  endLine: number
  depth: number
  isChanged: boolean
  calls: string[]
}

export type Outline = {
  file: string
  status: 'loading' | 'ready' | 'error'
  lines: number
  entries: OutlineEntry[]
  error?: string
}

export type SymbolChange = {
  name: string
  kind: SymbolKind
  change: 'added' | 'modified' | 'removed'
  line: number
  callers: number
}

export type FileChange = {
  path: string
  group: string
  status: 'modified' | 'added' | 'deleted'
  added: number
  removed: number
  symbols: SymbolChange[]
}

export type ChangeMap = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  files: FileChange[]
  /** Folders touched, highest layer first. */
  layers: string[]
  /** Unchanged files that import a changed file. */
  dependents: string[]
  error?: string
}

export type Decision = {
  id: string
  prompt: string
  decision: string
  because: string
  alternatives: string[]
}

export type Insight = { title: string; status: 'loading' | 'ready' | 'error'; text: string }

export type Tab = 'map' | 'changes' | 'components' | 'calls' | 'decisions' | 'explain'

declare module 'claude-code' {
  interface PluginState {
    'codebase-atlas': {
      graph: Graph | null
      scanStatus: ScanStatus
      scanError: string
      activity: Activity[]
      tab: Tab
      focus: string | null
      changes: ChangeMap
      outline: Outline | null
      call: CallView | null
      trail: string[]
      decisions: Decision[]
      isExtracting: boolean
      insight: Insight | null
    }
  }
}
