import { useState } from 'react'
import { KBPanel } from './kb-panel'
import { KGPanel } from './kg-panel'
import { AgentsPanel } from './agents-panel'
import { SkillsPanel } from './skills-panel'
import { PromptsPanel } from './prompts-panel'
import { DatasourcesPanel } from './datasources-panel'
import { MCPPanel } from './mcp-panel'
import { ArtifactsPanel } from './artifacts-panel'
import { VectorPanel } from './vector-panel'
import { ConversationsPanel } from './conversations-panel'
import { TemplatePanel } from './template-panel'
import { MigratePanel } from './migrate-panel'
import { WorkflowPanel } from './workflow-panel'
import { AnalysisPanel } from './analysis-panel'
import { SqlPanel } from './sql-panel'
import { UsersPanel } from './users-panel'
import { JarvisWorkbench } from './jarvis-workbench'

interface WorkbenchViewProps {
  activeTab: string
  onTabChange?: (tab: string) => void
  onNew?: () => void
  jarvisConvId: number | null
  ensureJarvisConversation: () => Promise<number>
  /** 当前登录用户显示名 */
  authUser?: string
}

export function WorkbenchView({
  activeTab,
  onTabChange,
  jarvisConvId,
  ensureJarvisConversation,
  authUser,
}: WorkbenchViewProps) {
  const [workflowTag, setWorkflowTag] = useState('')

  const renderPanel = () => {
    switch (activeTab) {
      case 'workspace':
        return (
          <JarvisWorkbench
            onTabChange={onTabChange}
            jarvisConvId={jarvisConvId}
            ensureJarvisConversation={ensureJarvisConversation}
          />
        )
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
      case 'vector': return <VectorPanel />
      case 'migrate': return <MigratePanel />
      case 'workflows': return <WorkflowPanel initialTag={workflowTag} />
      case 'analysis': return (
        <AnalysisPanel onQueryWorkflow={tag => { setWorkflowTag(tag); onTabChange?.('workflows') }} />
      )
      case 'sql': return <SqlPanel />
      case 'users': return <UsersPanel currentUser={authUser ?? ''} />
      default: return null
    }
  }

  return (
    <div className={activeTab === 'workspace' ? 'flex-1 min-h-0 overflow-hidden' : 'flex-1 overflow-y-auto p-6'}>
      {renderPanel()}
    </div>
  )
}
