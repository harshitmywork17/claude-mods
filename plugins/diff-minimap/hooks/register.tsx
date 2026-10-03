import type { Register } from 'claude-code'

import { GLYPH, minimapOf } from './minimap'
import type { EditOutput } from './minimap'

export const register: Register = on => {
  on('ui.render', { component: 'ToolUse', props: { tool: ['Edit', 'Write'] } }, async ($, e, next) => {
    const drawn = await next(e)
    const { isRunning, isErrored, isInterrupted, output } = e.props
    if (isRunning || isErrored || isInterrupted || typeof output !== 'object' || output === null) return drawn

    const map = minimapOf(output as EditOutput)
    if (map === null) return drawn

    const { Box, Text } = $.ui.resolve(e)
    const where = map.firstLine === map.lastLine ? `L${map.firstLine}` : `L${map.firstLine}-${map.lastLine}`

    return (
      <Box flexDirection="row">
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {drawn}
        </Box>
        <Box flexDirection="column" flexShrink={0} marginLeft={1} alignItems="center">
          {map.marks.map(mark => (
            <Text color={GLYPH[mark].color} dimColor={mark === 'none'}>
              {GLYPH[mark].text}
            </Text>
          ))}
          <Text dimColor>{where}</Text>
          <Text dimColor>/{map.totalLines}</Text>
        </Box>
      </Box>
    )
  })
}
