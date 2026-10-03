export type Severity = 'high' | 'critical'

export type ReportStatus = 'checking' | 'awaiting' | 'ran' | 'stopped' | 'dry-run'

export type Finding = { label: string; lines: string[]; more: number }

export type Report = {
  id: string
  command: string
  label: string
  severity: Severity
  findings: Finding[]
  status: ReportStatus
}

declare module 'claude-code' {
  interface PluginState {
    'blast-radius': { reports: Report[] }
  }
}
