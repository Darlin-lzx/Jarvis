export function isVisibleSystemTrace(content: Record<string, unknown> | null | undefined): boolean {
  return content?.event !== 'stage_blocked'
}
