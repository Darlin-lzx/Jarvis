import { KBPanel } from './kb-panel'
import { KGPanel } from './kg-panel'
import { AgentsPanel } from './agents-panel'
import { SkillsPanel } from './skills-panel'
import { PromptsPanel } from './prompts-panel'
import { DatasourcesPanel } from './datasources-panel'
import { MCPPanel } from './mcp-panel'
import { OpsPanel } from './ops-panel'
import { GovPanel } from './gov-panel'
import { SecurityPanel } from './security-panel'
import { ArtifactsPanel } from './artifacts-panel'
import { VectorPanel } from './vector-panel'
import { ConversationsPanel } from './conversations-panel'
import { WorkspacePanel } from './workspace-panel'
import { ModelsPanel } from './models-panel'
import { TemplatePanel } from './template-panel'
import { MigratePanel } from './migrate-panel'

interface WorkbenchViewProps {
  activeTab: string
  onTabChange?: (tab: string) => void
}

export function WorkbenchView({ activeTab, onTabChange }: WorkbenchViewProps) {
  const renderPanel = () => {
    switch (activeTab) {
      case 'workspace': return <WorkspacePanel onTabChange={onTabChange} />
      case 'kb': return <KBPanel />
      case 'kg': return <KGPanel />
      case 'artifacts': return <ArtifactsPanel />
      case 'agents': return <AgentsPanel onNavigate={onTabChange} />
      case 'conversations': return <ConversationsPanel />
      case 'skills': return <SkillsPanel />
      case 'prompts': return <PromptsPanel />
      case 'templates': return <TemplatePanel />
      case 'dbs': return <DatasourcesPanel />
      case 'mcp': return <MCPPanel />
      case 'ops': return <OpsPanel />
      case 'gov': return <GovPanel />
      case 'security': return <SecurityPanel />
      case 'vector': return <VectorPanel />
      case 'models': return <ModelsPanel />
      case 'migrate': return <MigratePanel />
      default: return null
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {renderPanel()}
    </div>
  )
}
