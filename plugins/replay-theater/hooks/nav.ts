import type { Cursor, ReplayTurn } from '../types'

export const MAX_TURNS = 10

/** Drops turns that made no edits, keeping the newest MAX_TURNS. */
export function prune(turns: readonly ReplayTurn[]): ReplayTurn[] {
  return turns.filter(turn => turn.edits.length > 0).slice(-MAX_TURNS)
}

/** Clamps a cursor to the turns that exist. */
export function clamp(cursor: Cursor, turns: readonly ReplayTurn[]): Cursor {
  if (turns.length === 0) return { turn: 0, edit: 0 }
  const turn = Math.min(Math.max(0, cursor.turn), turns.length - 1)
  const edits = turns[turn]?.edits.length ?? 0
  return { turn, edit: Math.min(Math.max(0, cursor.edit), Math.max(0, edits - 1)) }
}

/** Moves one edit forward or back, crossing into the next or previous turn at the ends. */
export function stepEdit(cursor: Cursor, turns: readonly ReplayTurn[], by: 1 | -1): Cursor {
  const here = clamp(cursor, turns)
  const edits = turns[here.turn]?.edits.length ?? 0
  const edit = here.edit + by
  if (edit >= 0 && edit < edits) return { ...here, edit }
  if (by > 0 && here.turn < turns.length - 1) return { turn: here.turn + 1, edit: 0 }
  if (by < 0 && here.turn > 0) {
    const previous = turns[here.turn - 1]?.edits.length ?? 1
    return { turn: here.turn - 1, edit: previous - 1 }
  }
  return here
}

export function stepTurn(cursor: Cursor, turns: readonly ReplayTurn[], by: 1 | -1): Cursor {
  return clamp({ turn: cursor.turn + by, edit: 0 }, turns)
}
