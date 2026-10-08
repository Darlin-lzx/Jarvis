export function agentDisplayName(
  agent?: { alias?: string; name?: string } | null,
): string {
  if (!agent) return '智能体'
  return agent.alias || agent.name || '智能体'
}
