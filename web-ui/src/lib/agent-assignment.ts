export interface AgentTabClickOptions {
  id: string
  onChange?: (id: string) => void
  disabled?: boolean
}

export function createAgentTabClickHandler({
  id,
  onChange,
  disabled = false,
}: AgentTabClickOptions): (() => void) | undefined {
  if (!onChange || disabled) return undefined
  return () => onChange(id)
}
