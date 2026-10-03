import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { EMPTY, statusLine, turnToast, withFile } from './format'

const REFRESH_MS = 30_000
const EDITING_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const meter = atom({ plugin: 'session-meter', key: 'meter' } as const, EMPTY)

async function refresh($: EngineInterface): Promise<void> {
  const elapsed = (await $.clock.now()) - (await $.session.usage()).startedAt
  $.ui.status(statusLine(await read($, meter), elapsed))
}

function editedPath(e: { tool: string; file_path?: unknown; notebook_path?: unknown }): string | undefined {
  const path = e.file_path ?? e.notebook_path
  return typeof path === 'string' ? path : undefined
}

export const register: Register = (on, options) => {
  const toastAfterMs = Number(options.toastAfterSeconds ?? 60) * 1000

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'meter',
      description: 'Session Meter: elapsed time, tool calls and files edited this session',
      immediate: true,
    })
    $.clock.every(REFRESH_MS, () => void refresh($).catch(() => undefined))
    await refresh($)

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await update($, meter, now => ({ ...now, turnTools: 0, turnFiles: [] }))

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    await update($, meter, now => ({ ...now, tools: now.tools + 1, turnTools: now.turnTools + 1 }))
    const ran = await next(e)

    const path = EDITING_TOOLS.has(e.tool) ? editedPath(e as { tool: string }) : undefined
    if (path !== undefined && ran.deny === undefined && ran.isError !== true) {
      await update($, meter, now => ({
        ...now,
        files: withFile(now.files, path),
        turnFiles: withFile(now.turnFiles, path),
      }))
    }
    await refresh($)

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    const isLong = toastAfterMs > 0 && e.durationMs >= toastAfterMs
    if (e.agentId === undefined && !e.isAborted && isLong) {
      $.ui.toast(turnToast(await read($, meter), e.durationMs), { timeoutMs: 8000 })
    }
    await refresh($)

    return ran
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, meter, () => EMPTY)

    return next(e)
  })

  on('command.run', { command: 'meter' }, async $ => {
    const now = await read($, meter)
    const elapsed = (await $.clock.now()) - (await $.session.usage()).startedAt
    const files = now.files.length === 0 ? '' : `\nFiles: ${now.files.join(', ')}`

    return { text: `Session Meter: ${statusLine(now, elapsed)}${files}` }
  })
}
