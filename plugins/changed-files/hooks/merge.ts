import type { ChangedFile } from '../types'
import type { Change } from './diff'

/** Adds one change to the list, moving its file to the top. */
export function merge(list: readonly ChangedFile[], change: Change): ChangedFile[] {
  const before = list.find(one => one.path === change.file)
  const next: ChangedFile = {
    path: change.file,
    added: (before?.added ?? 0) + change.added,
    removed: (before?.removed ?? 0) + change.removed,
    edits: (before?.edits ?? 0) + 1,
    isNew: before?.isNew ?? change.kind === 'create',
  }
  return [next, ...list.filter(one => one.path !== change.file)]
}
