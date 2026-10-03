import type { Site } from '../types'
import { isPython, symbolName } from './scan'
import type { SymbolIndex } from './scan'

const MAX_BODY_LINES = 400
const MAX_CALLEES = 40
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'return', 'catch', 'function', 'typeof', 'await', 'new', 'print', 'super',
  'elif', 'with', 'assert', 'lambda', 'yield', 'not', 'and', 'or', 'in', 'is', 'def', 'class',
])

function indent(line: string): number {
  return (/^\s*/.exec(line)?.[0] ?? '').replace(/\t/g, '    ').length
}

/** The lines of the definition starting at 1-based `line`: by indentation for Python, by braces otherwise. */
export function bodyOf(text: string, line: number, path: string): string[] {
  const lines = text.split('\n')
  const start = line - 1
  const head = lines[start]
  if (head === undefined) return []

  const body = [head]
  if (isPython(path)) {
    const base = indent(head)
    for (let index = start + 1; index < lines.length && body.length < MAX_BODY_LINES; index += 1) {
      const current = lines[index] ?? ''
      if (current.trim() !== '' && indent(current) <= base) break
      body.push(current)
    }
    while (body.length > 1 && (body[body.length - 1] ?? '').trim() === '') body.pop()
    return body
  }

  let depth = (head.match(/\{/g) ?? []).length - (head.match(/\}/g) ?? []).length
  let hasOpened = depth > 0
  for (let index = start + 1; index < lines.length && body.length < MAX_BODY_LINES; index += 1) {
    if (hasOpened && depth <= 0) break
    const current = lines[index] ?? ''
    body.push(current)
    depth += (current.match(/\{/g) ?? []).length - (current.match(/\}/g) ?? []).length
    if (depth > 0) hasOpened = true
  }
  return body
}

/** The function or class around 1-based `line`, found by walking up to the nearest definition that encloses it. */
export function enclosingSymbol(text: string, line: number, path: string): string {
  const lines = text.split('\n')
  const target = lines[line - 1] ?? ''
  for (let index = line - 2; index >= 0; index -= 1) {
    const current = lines[index] ?? ''
    const name = symbolName(current)
    if (name === null) continue
    if (isPython(path) ? indent(current) < indent(target) : bodyOf(text, index + 1, path).length >= line - index) {
      return name
    }
  }
  return '(module level)'
}

/** Functions a body calls, each marked known when the repo defines it. */
export function calleesIn(body: readonly string[], self: string, index: SymbolIndex): Site[] {
  const seen = new Set<string>()
  const out: Site[] = []
  for (const line of body.slice(1)) {
    const code = line.replace(/(#|\/\/).*$/, '')
    for (const match of code.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = match[1] ?? ''
      if (name === self || KEYWORDS.has(name) || seen.has(name)) continue
      seen.add(name)
      const definition = index.get(name)?.[0]
      out.push(definition ?? { symbol: name, file: '', line: 0, isKnown: false })
      if (out.length >= MAX_CALLEES) return sortKnownFirst(out)
    }
  }
  return sortKnownFirst(out)
}

function sortKnownFirst(sites: Site[]): Site[] {
  return sites.sort((a, b) => Number(b.isKnown) - Number(a.isKnown) || a.symbol.localeCompare(b.symbol))
}

/** True when a grep hit for `name(` is the definition itself rather than a call. */
export function isDefinitionLine(text: string, name: string): boolean {
  return symbolName(text) === name
}

/** The identifier under or around a selection: the last word that looks like a name. */
export function symbolFromSelection(selection: string): string | null {
  const words = selection.match(/[A-Za-z_$][\w$]*/g)
  return words === null ? null : (words[words.length - 1] ?? null)
}
