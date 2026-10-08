import type { ArtifactItem } from './types'

const PROCESS_ARTIFACT_NAMES = new Set(['result.json', '任务索引.md'])

/** Historical orchestration files remain in storage, but are not agent deliverables. */
export function isCoreArtifact(item: ArtifactItem): boolean {
  const filename = item.path?.split('/').pop() || item.object_name || ''
  return !PROCESS_ARTIFACT_NAMES.has(filename.toLowerCase())
}
