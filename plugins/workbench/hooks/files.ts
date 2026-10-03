import type { ArtifactKind, PreviewKind } from '../types'

const EXT = (path: string): string => (/\.([^./]+)$/.exec(path.toLowerCase())?.[1] ?? '')

export function previewKind(path: string): PreviewKind {
  const ext = EXT(path)
  if (['md', 'markdown', 'mdx'].includes(ext)) return 'markdown'
  if (['json', 'jsonl', 'geojson', 'ipynb'].includes(ext)) return 'json'
  if (['yaml', 'yml', 'toml'].includes(ext)) return 'yaml'
  if (['csv', 'tsv'].includes(ext)) return 'csv'
  if (['html', 'htm'].includes(ext)) return 'html'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return 'image'
  if (ext === 'svg') return 'svg'
  if (['txt', 'log', 'rst', ''].includes(ext)) return 'text'
  return 'code'
}

export function artifactKind(path: string): ArtifactKind {
  const ext = EXT(path)
  if (['md', 'markdown', 'txt', 'pdf', 'docx', 'doc', 'rst', 'pptx', 'rtf'].includes(ext)) return 'doc'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return 'image'
  if (['csv', 'tsv', 'json', 'jsonl', 'xlsx', 'xls', 'parquet', 'yaml', 'yml', 'sql', 'db', 'sqlite'].includes(ext)) return 'data'
  if (['html', 'htm', 'css'].includes(ext)) return 'web'
  if (['py', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'go', 'rs', 'java', 'rb', 'sh', 'kt', 'swift', 'c', 'cpp', 'h'].includes(ext)) return 'code'
  return 'other'
}

export const KIND_ICON: Record<ArtifactKind, string> = { doc: '📄', image: '🖼', data: '📊', web: '🌐', code: '⌨', other: '▫' }
export const KIND_LABEL: Record<ArtifactKind, string> = { doc: 'Documents', image: 'Images', data: 'Data', web: 'Web', code: 'Code', other: 'Other' }

export function bytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

export function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  return `${Math.round(seconds / 3600)}h ago`
}

/** Splits CSV or TSV text into rows of cells, honouring double quotes; at most `maxRows` rows. */
export function parseCsv(text: string, maxRows: number, isTab = false): string[][] {
  const separator = isTab ? '\t' : ','
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let isQuoted = false
  for (let index = 0; index < text.length && rows.length < maxRows; index += 1) {
    const char = text.charAt(index)
    if (isQuoted) {
      if (char === '"' && text.charAt(index + 1) === '"') {
        cell += '"'
        index += 1
      } else if (char === '"') isQuoted = false
      else cell += char
    } else if (char === '"') isQuoted = true
    else if (char === separator) {
      row.push(cell)
      cell = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text.charAt(index + 1) === '\n') index += 1
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += char
  }
  if ((cell !== '' || row.length > 0) && rows.length < maxRows) rows.push([...row, cell])
  return rows
}

export type TreeLine = { depth: number; key: string; value: string; kind: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' }

/** A JSON value as indented lines, cut at `maxDepth` levels, `maxItems` children per node and `maxLines` overall. */
export function jsonTree(value: unknown, maxDepth = 5, maxItems = 25, maxLines = 300): TreeLine[] {
  const lines: TreeLine[] = []
  const walk = (node: unknown, key: string, depth: number): void => {
    if (lines.length >= maxLines) return
    if (Array.isArray(node)) {
      lines.push({ depth, key, value: `[${node.length}]`, kind: 'array' })
      if (depth >= maxDepth) return
      node.slice(0, maxItems).forEach((child, index) => walk(child, String(index), depth + 1))
      if (node.length > maxItems) lines.push({ depth: depth + 1, key: '…', value: `${node.length - maxItems} more`, kind: 'null' })
    } else if (node !== null && typeof node === 'object') {
      const entries = Object.entries(node)
      lines.push({ depth, key, value: `{${entries.length}}`, kind: 'object' })
      if (depth >= maxDepth) return
      entries.slice(0, maxItems).forEach(([childKey, child]) => walk(child, childKey, depth + 1))
      if (entries.length > maxItems) lines.push({ depth: depth + 1, key: '…', value: `${entries.length - maxItems} more`, kind: 'null' })
    } else if (typeof node === 'string') {
      lines.push({ depth, key, value: JSON.stringify(node.length > 120 ? `${node.slice(0, 120)}…` : node), kind: 'string' })
    } else if (typeof node === 'number') {
      lines.push({ depth, key, value: String(node), kind: 'number' })
    } else if (typeof node === 'boolean') {
      lines.push({ depth, key, value: String(node), kind: 'boolean' })
    } else {
      lines.push({ depth, key, value: 'null', kind: 'null' })
    }
  }
  walk(value, '(root)', 0)
  return lines
}

/** Parses JSON, or JSON Lines one record per line. */
export function parseJson(text: string, path: string): unknown {
  if (path.toLowerCase().endsWith('.jsonl')) {
    return text
      .split('\n')
      .filter(line => line.trim() !== '')
      .slice(0, 200)
      .map(line => JSON.parse(line) as unknown)
  }
  return JSON.parse(text) as unknown
}

/** For HTML without a screenshot: the title, headings and links, as a readable outline. */
export function htmlOutline(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim()
  const headings = [...html.matchAll(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi)].map(match => {
    const level = Number(match[1])
    const text = (match[2] ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    return `${'#'.repeat(level + 1)} ${text}`
  })
  const links = [...html.matchAll(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .slice(0, 15)
    .map(match => `- ${(match[2] ?? '').replace(/<[^>]+>/g, '').trim() || match[1]} → ${match[1]}`)
  return [`# ${title ?? '(untitled page)'}`, ...headings.slice(0, 40), links.length > 0 ? '\n**Links**' : '', ...links]
    .filter(line => line !== '')
    .join('\n')
}
