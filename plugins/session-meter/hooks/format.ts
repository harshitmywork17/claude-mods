import type { Meter } from '../types'

export const EMPTY: Meter = { tools: 0, files: [], turnTools: 0, turnFiles: [] }

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return seconds % 60 === 0 || minutes >= 10 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

export function statusLine(meter: Meter, elapsedMs: number): string {
  return `⏱ ${duration(elapsedMs)} · ${plural(meter.tools, 'tool call')} · ${plural(meter.files.length, 'file')} edited`
}

export function turnToast(meter: Meter, durationMs: number): string {
  return `Done in ${duration(durationMs)} · ${plural(meter.turnTools, 'tool call')} · ${plural(meter.turnFiles.length, 'file')} edited`
}

export function withFile(files: readonly string[], file: string): string[] {
  return files.includes(file) ? [...files] : [...files, file]
}
