// ── Now: the turn as it runs ────────────────────────────────────────────

export type StepStatus = 'running' | 'ok' | 'error' | 'denied'

export type AgentRun = { agentId?: string; type: string; description: string; toolCount?: number; tokens?: number }

export type Step = {
  id: string
  /** 'main', or the subagent's id. */
  lane: string
  tool: string
  summary: string
  startedAt: number
  endedAt?: number
  status: StepStatus
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
  /** What the turn cost in US dollars, from the session's cost ledger. */
  costUsd?: number
}

// ── Changes: every edit, grouped by turn ────────────────────────────────

export type EditHunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }

export type EditRecord = {
  id: string
  turnId: string
  file: string
  kind: 'edit' | 'create' | 'overwrite'
  hunks: EditHunk[]
  added: number
  removed: number
  /** Functions and classes this edit touched, in the file as it stood right after. */
  symbols: string[]
  at: number
  isCut: boolean
}

export type SymbolKind = 'class' | 'function' | 'method'

export type SymbolChange = { name: string; kind: SymbolKind; change: 'added' | 'modified' | 'removed'; line: number; callers: number }

export type FileSummary = {
  file: string
  status: 'loading' | 'ready' | 'error'
  /** Compared with the file as it was before Claude first touched it this session. */
  symbols: SymbolChange[]
  added: number
  removed: number
  error?: string
}

// ── Preview and Artifacts ───────────────────────────────────────────────

export type PreviewKind = 'markdown' | 'json' | 'yaml' | 'csv' | 'html' | 'image' | 'svg' | 'code' | 'text'

export type Preview = {
  path: string
  kind: PreviewKind
  status: 'loading' | 'ready' | 'error'
  text: string
  size: number
  /** For HTML and PNG: the absolute path of a PNG to draw. */
  image?: string
  generation: number
  note?: string
}

export type ArtifactKind = 'doc' | 'image' | 'data' | 'web' | 'code' | 'other'

export type Artifact = { path: string; kind: ArtifactKind; size: number; mtimeMs: number; isByClaude: boolean }

// ── Code Map (from Codebase Atlas) ──────────────────────────────────────

export type Group = { id: string; files: number; lines: number; symbols: number; level: number }
export type Edge = { from: string; to: string; count: number }
export type Graph = { root: string; isGit: boolean; files: number; groups: Group[]; edges: Edge[]; isTruncated: boolean }
export type ScanStatus = 'idle' | 'scanning' | 'ready' | 'no-folder' | 'error'
export type Site = { symbol: string; file: string; line: number; isKnown: boolean }

export type OutlineEntry = {
  name: string
  kind: SymbolKind
  line: number
  endLine: number
  depth: number
  isChanged: boolean
  calls: string[]
}

export type Outline = { file: string; status: 'loading' | 'ready' | 'error'; lines: number; entries: OutlineEntry[]; error?: string }

export type CallView = {
  symbol: string
  status: 'loading' | 'ready' | 'missing' | 'error'
  definition?: Site
  callers: Site[]
  callees: Site[]
  error?: string
}

export type MapView = 'map' | 'components' | 'calls'

// ── Usage ───────────────────────────────────────────────────────────────

export type Reading = { percent: number; tokens: number; window: number }
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Tab = 'now' | 'changes' | 'preview' | 'artifacts' | 'map' | 'usage'

/** Which slide the band above the prompt shows: ◀ Forecast, ▶ Workbench. */
export type Slide = 'forecast' | 'workbench'

declare module 'claude-code' {
  interface PluginState {
    workbench: {
      tab: Tab
      isHudHidden: boolean
      slide: Slide
      startedAt: number
      turns: Turn[]
      turnBack: number
      showOutputs: boolean
      edits: EditRecord[]
      changeFile: string | null
      changeEdit: string | null
      fileSummary: FileSummary | null
      preview: Preview | null
      isFollowing: boolean
      artifacts: Artifact[]
      graph: Graph | null
      scanStatus: ScanStatus
      scanError: string
      mapView: MapView
      mapFocus: string | null
      outline: Outline | null
      call: CallView | null
      trail: string[]
      limits: Limit[]
      reading: Reading | null
      history: number[]
      costUsd: number | null
    }
  }
}
