import type { Severity } from '../types'

export type Probe = { label: string; argv: string[] }

export type Risk = {
  label: string
  severity: Severity
  /** Where the probes run: the session's directory, or the one a leading `cd` moved to. */
  cwd?: string
  probes: Probe[]
}

const CATASTROPHIC_TARGETS = new Set(['/', '/*', '~', '~/', '$HOME', '.', './', '*', '..', '../'])
const FORCE_PUSH_FLAGS = new Set(['-f', '--force', '--force-with-lease', '--force-if-includes'])
const SQL_DESTRUCTION = /\b(drop\s+(table|database|schema)|truncate(\s+table)?\s+\w)/i
const MAX_TARGETS = 3

/** Splits a shell line on `&&`, `||`, `;`, `|` and newlines (quotes respected). */
export function segments(command: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: string | null = null
  for (let i = 0; i < command.length; i += 1) {
    const char = command.charAt(i)
    if (quote !== null) {
      if (char === quote) quote = null
      current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    const pair = command.slice(i, i + 2)
    if (pair === '&&' || pair === '||') {
      parts.push(current)
      current = ''
      i += 1
      continue
    }
    if (char === ';' || char === '|' || char === '\n') {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts.map(part => part.trim()).filter(part => part.length > 0)
}

/** Whitespace tokens with quotes stripped; leading `sudo` and `VAR=value` dropped. */
export function tokens(segment: string): string[] {
  const found = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  const words = found.map(word => word.replace(/^(["'])(.*)\1$/, '$2'))
  while (words.length > 0 && (words[0] === 'sudo' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? ''))) {
    words.shift()
  }
  return words
}

function shortFlags(words: readonly string[]): string {
  return words
    .filter(word => /^-[A-Za-z]+$/.test(word))
    .map(word => word.slice(1))
    .join('')
}

function rmRisk(args: readonly string[]): Risk | null {
  const flags = shortFlags(args)
  const isRecursive = /[rR]/.test(flags) || args.includes('--recursive')
  const isForced = flags.includes('f') || args.includes('--force')
  if (!isRecursive || !isForced) return null

  const targets = args.filter(arg => !arg.startsWith('-'))
  const isCatastrophic = targets.some(target => CATASTROPHIC_TARGETS.has(target))
  const probed = targets.filter(target => !/[*?$]/.test(target)).slice(0, MAX_TARGETS)

  return {
    label: `rm -rf ${targets.join(' ') || '(no target)'}`,
    severity: isCatastrophic ? 'critical' : 'high',
    probes: probed.flatMap(target => [
      { label: `size of ${target}`, argv: ['du', '-sh', '--', target] },
      { label: `contents of ${target}`, argv: ['find', target, '-maxdepth', '2'] },
    ]),
  }
}

const WORKTREE_PROBES: Probe[] = [
  { label: 'uncommitted changes that would be lost', argv: ['git', 'status', '--short'] },
  { label: 'diff against HEAD', argv: ['git', 'diff', '--stat', 'HEAD'] },
]

function gitRisk(args: readonly string[]): Risk | null {
  const rest = [...args]
  while (rest[0] === '-C' || rest[0] === '-c') rest.splice(0, 2)
  const [sub, ...params] = rest

  if (sub === 'reset' && params.includes('--hard')) {
    return { label: 'git reset --hard', severity: 'high', probes: WORKTREE_PROBES }
  }
  if (sub === 'push' && params.some(arg => FORCE_PUSH_FLAGS.has(arg) || /^\+/.test(arg))) {
    return {
      label: 'git push --force',
      severity: 'high',
      probes: [
        { label: 'branch', argv: ['git', 'rev-parse', '--abbrev-ref', 'HEAD'] },
        {
          label: 'remote commits that would be overwritten',
          argv: ['git', 'log', '--oneline', '-n', '15', 'HEAD..@{upstream}'],
        },
        { label: 'local commits being pushed', argv: ['git', 'log', '--oneline', '-n', '15', '@{upstream}..HEAD'] },
      ],
    }
  }
  if (sub === 'clean' && (shortFlags(params).includes('f') || params.includes('--force'))) {
    const extra = shortFlags(params).includes('x') ? ['-x'] : shortFlags(params).includes('X') ? ['-X'] : []
    return {
      label: 'git clean -f',
      severity: 'high',
      probes: [{ label: 'files that would be deleted', argv: ['git', 'clean', '-n', '-d', ...extra] }],
    }
  }
  if ((sub === 'checkout' || sub === 'restore') && params.includes('.') && !params.includes('--staged')) {
    return { label: `git ${sub} .`, severity: 'high', probes: WORKTREE_PROBES }
  }
  if (sub === 'branch' && (params.includes('-D') || (params.includes('--delete') && params.includes('--force')))) {
    const branch = params.find(arg => !arg.startsWith('-'))
    return {
      label: `git branch -D ${branch ?? ''}`.trim(),
      severity: 'high',
      probes:
        branch === undefined
          ? []
          : [
              {
                label: `commits only on ${branch}`,
                argv: ['git', 'log', '--oneline', '-n', '15', branch, '--not', '--remotes'],
              },
            ],
    }
  }
  if (sub === 'stash' && (params[0] === 'drop' || params[0] === 'clear')) {
    return {
      label: `git stash ${params[0]}`,
      severity: 'high',
      probes: [{ label: 'stashes', argv: ['git', 'stash', 'list'] }],
    }
  }
  return null
}

function segmentRisk(segment: string): Risk | null {
  if (SQL_DESTRUCTION.test(segment)) {
    return { label: 'destructive SQL (DROP / TRUNCATE)', severity: 'critical', probes: [] }
  }
  const [program, ...args] = tokens(segment)
  if (program === 'rm') return rmRisk(args)
  if (program === 'git') return gitRisk(args)
  if (program === 'mkfs' || program?.startsWith('mkfs.')) {
    return { label: program, severity: 'critical', probes: [] }
  }
  if (program === 'dd' && args.some(arg => arg.startsWith('of=/dev/'))) {
    return { label: 'dd to a device', severity: 'critical', probes: [] }
  }
  return null
}

/** Every risky segment of a shell command, each with the probes that size it. */
export function assess(command: string): Risk[] {
  const risks: Risk[] = []
  let cwd: string | undefined
  for (const segment of segments(command)) {
    const [program, target] = tokens(segment)
    if (program === 'cd' && target !== undefined) {
      cwd = target
      continue
    }
    const risk = segmentRisk(segment)
    if (risk !== null) risks.push(cwd === undefined ? risk : { ...risk, cwd })
  }
  return risks
}

export function summarize(risks: readonly Risk[]): string {
  return risks.map(risk => risk.label).join('; ')
}
