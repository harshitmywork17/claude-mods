import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Finding, Report, ReportStatus } from '../types'
import { assess, summarize } from './risk'
import type { Risk } from './risk'

const PANE = 'blast-radius'
const MAX_LINES = 15
const MAX_REPORTS = 10
const reports = atom({ plugin: 'blast-radius', key: 'reports' } as const, [])

const STATUS_TEXT: Record<ReportStatus, string> = {
  checking: 'measuring…',
  awaiting: 'waiting for your approval',
  ran: 'ran',
  stopped: 'did not run (denied or failed)',
  'dry-run': 'dry run, nothing executed',
}

async function probe($: EngineInterface, risks: readonly Risk[]): Promise<Finding[]> {
  const findings: Finding[] = []
  for (const risk of risks) {
    for (const { label, argv } of risk.probes) {
      try {
        const run = await $.process.run(argv, { cwd: risk.cwd, timeoutMs: 5000 })
        const text = (run.exitCode === 0 ? run.stdout : run.stderr || run.stdout).trimEnd()
        const lines = text === '' ? ['(nothing)'] : text.split('\n')
        findings.push({ label, lines: lines.slice(0, MAX_LINES), more: Math.max(0, lines.length - MAX_LINES) })
      } catch (error) {
        findings.push({ label, lines: [`(could not measure: ${String(error)})`], more: 0 })
      }
    }
  }
  return findings
}

function severityOf(risks: readonly Risk[]): Report['severity'] {
  return risks.some(risk => risk.severity === 'critical') ? 'critical' : 'high'
}

async function setStatus($: EngineInterface, id: string, change: Partial<Report>): Promise<void> {
  await update($, reports, list => list.map(one => (one.id === id ? { ...one, ...change } : one)))
}

async function record($: EngineInterface, id: string, command: string, risks: readonly Risk[]): Promise<void> {
  const report: Report = {
    id,
    command,
    label: summarize(risks),
    severity: severityOf(risks),
    findings: [],
    status: 'checking',
  }
  await update($, reports, list => [report, ...list.filter(one => one.id !== id)].slice(0, MAX_REPORTS))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'blast-radius',
      description: 'Blast Radius: open the pane, or dry-run a command (/blast-radius <command>)',
      argumentHint: '[command to analyze]',
      immediate: true,
    })

    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const risks = assess(e.command)
    if (risks.length === 0) return next(e)

    await record($, e.tool_use_id, e.command, risks)
    void $.ui.open({ id: PANE, title: 'Blast Radius' })
    $.ui.toast(`Blast Radius: ${summarize(risks)}. Check the pane before approving.`)
    await setStatus($, e.tool_use_id, { findings: await probe($, risks), status: 'awaiting' })

    const ran = await next(e)
    const didRun = ran.deny === undefined && ran.isError !== true
    await setStatus($, e.tool_use_id, { status: didRun ? 'ran' : 'stopped' })

    return ran
  })

  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const verdict = await next(e)
    const input = e.input as { command?: unknown }
    if (verdict.decision === 'deny' || typeof input.command !== 'string') return verdict

    const risks = assess(input.command)
    if (risks.length === 0) return verdict

    return {
      decision: 'ask',
      reason: `Blast Radius: ${summarize(risks)}. The Blast Radius pane shows what it would touch.`,
    }
  })

  on('command.run', { command: 'blast-radius' }, async ($, e) => {
    const command = e.args.trim()
    if (command === '') {
      await $.ui.open({ id: PANE, title: 'Blast Radius' })
      return { text: 'Blast Radius pane opened.' }
    }

    const risks = assess(command)
    if (risks.length === 0) return { text: `Blast Radius: nothing risky found in: ${command}` }

    const id = `dry-${await $.clock.now()}`
    await record($, id, command, risks)
    await setStatus($, id, { findings: await probe($, risks), status: 'dry-run' })
    await $.ui.open({ id: PANE, title: 'Blast Radius' })

    return { text: `Blast Radius (dry run): ${summarize(risks)}. See the pane for what it would touch.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const [latest, ...earlier] = await read($, reports)

    if (latest === undefined) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No risky commands caught yet.</Text>
          <Text dimColor>Try: /blast-radius git reset --hard</Text>
        </Box>
      )
    }

    const color = latest.severity === 'critical' ? 'red' : 'yellow'

    return (
      <Box flexDirection="column">
        <Text color={color} bold>
          {latest.severity === 'critical' ? '✖ CRITICAL' : '⚠ RISKY'} {latest.label}
        </Text>
        <Text dimColor>
          {STATUS_TEXT[latest.status]}
        </Text>
        <Text wrap="truncate-end">$ {latest.command}</Text>
        {latest.findings.map(finding => (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>{finding.label}</Text>
            {finding.lines.map(line => (
              <Text wrap="truncate-end">  {line}</Text>
            ))}
            {finding.more > 0 && <Text dimColor>  … {finding.more} more</Text>}
          </Box>
        ))}
        {earlier.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Earlier</Text>
            {earlier.map(report => (
              <Text dimColor wrap="truncate-end">
                {report.status === 'ran' ? '✓' : '·'} {report.label} ({STATUS_TEXT[report.status]})
              </Text>
            ))}
          </Box>
        )}
        <Box marginTop={1}>
          <Button key="clear" label="clear history" onPress={() => update($, reports, () => [])} />
        </Box>
      </Box>
    )
  })
}
