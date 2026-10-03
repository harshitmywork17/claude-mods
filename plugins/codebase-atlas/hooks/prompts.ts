import type { Decision } from '../types'

export const DECISION_MODEL = 'claude-haiku-4-5-20251001'
const MAX_DECISIONS = 3
const MAX_ANSWER = 6000
export const MAX_CONTEXT = 12000

export const DECISION_SYSTEM =
  'You extract engineering decisions from one turn of a coding session. A decision is a choice between real options that shapes the code or design, such as a library, a data model, an algorithm, a layout or a trade-off. Ignore routine steps such as reading files or running tests. Reply with JSON only.'

export function decisionPrompt(request: string, answer: string, editedFiles: readonly string[]): string {
  return [
    `User request: ${request}`,
    `Files edited this turn: ${editedFiles.length === 0 ? 'none' : editedFiles.join(', ')}`,
    `Assistant's final answer:\n${answer.slice(0, MAX_ANSWER)}`,
    '',
    `List at most ${MAX_DECISIONS} decisions made in this turn, in this exact shape, or an empty list when there were none:`,
    '{"decisions":[{"decision":"what was chosen, one line","because":"why, one line","alternatives":["option not taken"]}]}',
  ].join('\n')
}

function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

export function parseDecisions(reply: string, prompt: string, idPrefix: string): Decision[] {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return []
  }
  const raw = (parsed as { decisions?: unknown }).decisions
  if (!Array.isArray(raw)) return []
  return raw
    .map((item: Record<string, unknown>, index) => ({
      id: `${idPrefix}-${index}`,
      prompt,
      decision: text(item.decision, 200),
      because: text(item.because, 240),
      alternatives: Array.isArray(item.alternatives)
        ? item.alternatives.map(option => text(option, 80)).filter(Boolean).slice(0, 4)
        : [],
    }))
    .filter(decision => decision.decision !== '')
    .slice(0, MAX_DECISIONS)
}

const SIDE_QUESTION =
  'Side question from the user. Answer it on its own in Markdown: do not use tools and do not continue or change the current task.'

export function explainModulePrompt(id: string, files: readonly string[], symbols: readonly string[], dependsOn: readonly string[], usedBy: readonly string[]): string {
  return [
    SIDE_QUESTION,
    `Explain the "${id}" folder of this codebase to someone new to it: what it is responsible for, how its main pieces fit together, and how it relates to the folders around it.`,
    `Files: ${files.slice(0, 40).join(', ')}`,
    `Functions and classes defined there: ${symbols.slice(0, 80).join(', ') || 'unknown'}`,
    `It imports from: ${dependsOn.join(', ') || 'nothing in the repo'}`,
    `It is imported by: ${usedBy.join(', ') || 'nothing in the repo'}`,
    'Use a one-sentence summary, then short sections with bullets. Say when something is inferred from names rather than seen.',
  ].join('\n')
}

export function explainFunctionPrompt(symbol: string, file: string, body: string, callers: readonly string[], callees: readonly string[]): string {
  return [
    SIDE_QUESTION,
    `Explain the function "${symbol}" in ${file}: what it does, step by step, why it is shaped this way, and its edge cases.`,
    `Called by: ${callers.join(', ') || 'no callers found'}`,
    `It calls: ${callees.join(', ') || 'nothing in the repo'}`,
    'Its code:',
    '```',
    body.slice(0, MAX_CONTEXT),
    '```',
  ].join('\n')
}

export function explainChangesPrompt(summary: string, diff: string): string {
  return [
    SIDE_QUESTION,
    'Explain the changes made in this session: the approach, how the pieces fit together, which layers of the architecture they touch, and anything risky or worth testing.',
    `Changed files:\n${summary}`,
    diff === '' ? '' : `The uncommitted diff (may be cut):\n\`\`\`diff\n${diff.slice(0, MAX_CONTEXT)}\n\`\`\``,
  ].join('\n')
}
