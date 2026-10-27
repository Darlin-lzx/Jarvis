export interface AgentSaveForm {
  name: string
  alias: string
  projectDir: string
  description: string
  prompt: string
  enabled: boolean
  systemRolePromptId: string
  type: '主Agent' | '子Agent'
  tools: string[]
  boundKBs: string[]
}

export function buildAgentSavePayload(form: AgentSaveForm) {
  return {
    name: form.name,
    alias: form.alias,
    project_dir: form.projectDir.trim(),
    description: form.description,
    default_prompt: form.prompt,
    enabled: form.enabled,
    system_role_prompt_id: form.systemRolePromptId ? Number(form.systemRolePromptId) : null,
    agent_type: form.type,
    tools: form.tools,
    bound_kbs: form.boundKBs,
  }
}
