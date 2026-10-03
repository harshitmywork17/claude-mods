import type { Approach } from '../types'

const MAX_APPROACHES = 3
const MAX_TEXT = 400
const MAX_ITEMS = 4

export function forkPrompt(question: string): string {
  return [
    'Side question from the user. Answer it on its own: do not use tools and do not continue or change the current task.',
    `What if: ${question}`,
    'Give 2 or 3 genuinely different approaches, grounded in this conversation and codebase.',
    'Reply with JSON only, no prose and no code fence, in exactly this shape:',
    '{"approaches":[{"title":"short name","idea":"one or two sentences","pros":["..."],"cons":["..."],"effort":"S, M or L"}]}',
  ].join('\n')
}

function text(value: unknown, limit = MAX_TEXT): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => text(item, 160)).filter(item => item !== '').slice(0, MAX_ITEMS) : []
}

/** Reads the approaches out of a reply, tolerating prose or a code fence around the JSON. */
export function parseApproaches(reply: string): Approach[] {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return []
  }

  const raw = (parsed as { approaches?: unknown }).approaches
  if (!Array.isArray(raw)) return []

  return raw
    .map((item: Record<string, unknown>) => ({
      title: text(item.title, 80),
      idea: text(item.idea),
      pros: list(item.pros),
      cons: list(item.cons),
      effort: text(item.effort, 8) || '?',
    }))
    .filter(approach => approach.title !== '' && approach.idea !== '')
    .slice(0, MAX_APPROACHES)
}

/** The text "use this" puts in the prompt box for the person to edit and send. */
export function promptFor(question: string, approach: Approach): string {
  return `Let's go with "${approach.title}" for: ${question}\n${approach.idea}`
}
