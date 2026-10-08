import { useState, useEffect } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Sidebar, type WorkspaceGroup, type TaskFilter } from '@/components/layout/sidebar'
import { TopBar } from '@/components/layout/top-bar'
import { ChatView } from '@/components/chat/chat-view'
import { WelcomePage } from '@/components/chat/welcome-page'
import { WorkbenchView } from '@/components/workbench/workbench-view'
import { SpaceDetailPage } from '@/components/space/space-detail-panel'
import { SubSystemDetailPage } from '@/components/space/sub-system-detail-page'
import { SettingsDialog } from '@/components/settings/settings-dialog'
import { useConversations } from '@/hooks/use-conversations'
import { useHealth } from '@/hooks/use-health'
import { agents as builtinAgents } from '@/components/chat/agent-tabs'
import { api } from '@/lib/api'
import type { Agent } from '@/lib/types'
import { TaskListPage } from '@/components/project/task-list-page'
import { TaskDetailPage } from '@/components/project/task-detail-page'
import { NewTaskDialog, type NewTaskContext } from '@/components/project/new-task-dialog'

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<string>(() => {
    // 支持直达工作台面板：#/workspace/{tab}（如数据源管理 dbs），避免首帧闪回默认面板
    const m = window.location.hash.match(/^#\/workspace\/([a-zA-Z0-9_-]+)$/)
    return m ? m[1] : 'workspace'
  })
  const [showWelcome, setShowWelcome] = useState(false)
  const [activeAgent, setActiveAgent] = useState<string>('migration_assessor')
  const [agentList, setAgentList] = useState<Agent[]>([])
  const [currentSpace, setCurrentSpace] = useState<WorkspaceGroup | null>(null)
  const [selectedTask, setSelectedTask] = useState<{ id: number; name: string } | null>(null)
  // 会话来源任务：从任务详情进入会话时记录，供「返回任务详情」恢复上下文
  const [chatFromTask, setChatFromTask] = useState<{ id: number; name: string } | null>(null)
  const [selectedSub, setSelectedSub] = useState<{ spaceId: number; spaceName: string; subId: number } | null>(null)
  const [newTaskCtx, setNewTaskCtx] = useState<NewTaskContext | null>(null)
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const [quickMode, setQuickMode] = useState(false)
  const conv = useConversations()
  const healthy = useHealth()
  // 任务页筛选（左侧空间/子系统点击联动）
  const [taskFilter, setTaskFilter] = useState<TaskFilter | null>(null)

  // 加载后端智能体列表，找到主智能体作为默认值
  useEffect(() => {
    api.listAgents(true).then(r => {
      if (r.success && r.data && r.data.length > 0) {
        // 主智能体（agent_type === '主Agent'）排最前
        const sorted = [...r.data].sort((a, b) => {
          const aMain = a.agent_type === '主Agent' ? 0 : 1
          const bMain = b.agent_type === '主Agent' ? 0 : 1
          return aMain - bMain
        })
        setAgentList(sorted)
        const mainAgent = sorted.find((a: Agent) => a.agent_type === '主Agent' && a.enabled !== false)
        if (mainAgent) {
          setActiveAgent(mainAgent.id)
        }
      }
    }).catch(() => {})
  }, [])

  // URL hash 路由：支持 #/chat/{id} 与 #/workspace/{tab}（如 #/workspace/dbs 直达数据源管理）
  useEffect(() => {
    const handleHash = () => {
      const hash = window.location.hash
      const match = hash.match(/^#\/chat\/(\d+)$/)
      if (match) {
        const id = parseInt(match[1], 10)
        conv.setCurrentId(id)
        setShowWelcome(false)
        setActiveTab('workspace')
        return
      }
      const wm = hash.match(/^#\/workspace\/([a-zA-Z0-9_-]+)$/)
      if (wm) {
        // 进入工作台对应面板（表单页「去数据源管理」跳转使用）
        handleTabChange(wm[1])
        return
      }
      if (hash.startsWith('#/workspace')) {
        setShowWelcome(false)
        setActiveTab('workspace')
      }
    }
    // 打开网站默认展示工作台：清理上次会话残留的 #/chat/{id}（仅保留 #/workspace/{tab} 直达）
    if (/^#\/chat\//.test(window.location.hash)) {
      window.history.replaceState(null, '', window.location.pathname)
    }
    handleHash()
    window.addEventListener('hashchange', handleHash)
    return () => window.removeEventListener('hashchange', handleHash)
  }, [])

  // 同步 URL hash 与当前会话 / 工作台面板（主动保留 {tab}，避免 #/workspace/dbs 被覆写后回跳）
  // 注意：非工作台面板（如任务页 tasks）不写 hash，避免写入 #/workspace 后又经 hashchange 弹回工作台
  const workbenchTabs = ['kb', 'artifacts', 'vector', 'kg', 'agents', 'conversations', 'skills', 'prompts', 'templates', 'dbs', 'mcp', 'ops', 'gov', 'security', 'models', 'migrate']
  useEffect(() => {
    if (conv.currentId != null) {
      window.location.hash = `#/chat/${conv.currentId}`
    } else if (!showWelcome) {
      if (activeTab && workbenchTabs.includes(activeTab)) {
        window.location.hash = `#/workspace/${activeTab}`
      } else if (!window.location.hash) {
        window.location.hash = '#/workspace'
      }
    }
  }, [conv.currentId, showWelcome, activeTab])

  // 侧边栏刷新计数器：任务增删时递增，触发侧边栏重新加载空间/任务数
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0)
  const bumpSidebarRefresh = () => setSidebarRefreshKey(k => k + 1)

  const handleQuickQA = () => {
    setQuickMode(true)
    setShowWelcome(true)
    setCurrentSpace(null)
    setSelectedTask(null)
    setSelectedSub(null)
    conv.setCurrentId(null)
  }

  const handleConvCreated = (id: number) => {
    setShowWelcome(false)
    conv.setCurrentId(id)
    conv.reload()
    // 同步判断 quickMode：通过 task_id / space_id 判断是否为项目会话
    // 不再异步获取，避免竞态条件
    api.getConversation(id).then(r => {
      if (r.success && r.data) {
        setQuickMode(!r.data.space_id && !r.data.task_id)
      }
    }).catch(() => {})
  }

  const handleNewConversation = async () => {
    setQuickMode(false)
    setShowWelcome(false)
    setCurrentSpace(null)
    setSelectedTask(null)
    setChatFromTask(null)
    setSelectedSub(null)
    conv.setCurrentId(null)

    try {
      const spaceResponse = await api.getDefaultSpace()
      if (!spaceResponse.success || !spaceResponse.data) throw new Error(spaceResponse.error || '默认空间不可用')
      const conversationResponse = await api.createConversation('新会话', {
        space_id: spaceResponse.data.id,
        agent_id: activeAgent,
      })
      if (!conversationResponse.success || !conversationResponse.data) throw new Error(conversationResponse.error || '会话创建失败')
      handleConvCreated(conversationResponse.data.id)
      bumpSidebarRefresh()
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '创建会话失败，请稍后重试')
    }
  }

  const handleConvCreatedFromWelcome = (id: number) => {
    setShowWelcome(false)
    conv.setCurrentId(id)
    conv.reload()
  }

  const handleSelectConv = (id: number | null) => {
    setShowWelcome(false)
    setCurrentSpace(null)
    setChatFromTask(null) // 默认清空来源任务（从任务详情进入时会重新设置）
    conv.setCurrentId(id)
    // 进入已有会话时按会话归属自动同步模式（无空间/任务归属 = 快速问答）
    if (id != null) {
      api.getConversation(id).then(r => { if (r.success && r.data) setQuickMode(!r.data.space_id && !r.data.task_id) }).catch(() => {})
    }
  }
  const handleRenameConv = (id: number, title: string) => {
    api.renameConversation(id, title).then(() => conv.reload()).catch(() => {})
  }

  const handleTabChange = (tab: string) => {
    setActiveTab(tab)
    setCurrentSpace(null)
    conv.setCurrentId(null)
    setShowWelcome(false)
    setSelectedTask(null)
    setChatFromTask(null)
  }

  // 左侧点击空间/子系统 → 进入任务页并按空间/子系统筛选
  const handleSelectSubSystem = (g: WorkspaceGroup, child: { id: string; name: string }) => {
    setTaskFilter({ spaceId: Number(g.id), spaceName: g.name, subId: Number(child.id), subName: child.name })
    setSelectedTask(null)
    setSelectedSub(null)
    setCurrentSpace(null)
    setShowWelcome(false)
    conv.setCurrentId(null)
    setActiveTab('tasks')
  }

  // 点击空间节点 → 任务页展示该空间所有子系统任务
  const handleSelectSpaceTasks = (g: WorkspaceGroup) => {
    setTaskFilter({ spaceId: Number(g.id), spaceName: g.name })
    setSelectedTask(null)
    setSelectedSub(null)
    setCurrentSpace(null)
    setShowWelcome(false)
    conv.setCurrentId(null)
    setActiveTab('tasks')
  }

  const isChatView = conv.currentId !== null || showWelcome
  const showTasksPage = activeTab === 'tasks' && !selectedTask && !isChatView

  return (
    <TooltipProvider>
      <div className="bg-[#0f0f12] text-[#e4e4e9] h-screen flex overflow-hidden text-sm">
        <Sidebar
          conversations={conv.conversations}
          currentId={conv.currentId}
          searchKw={conv.searchKw}
          onSearch={conv.setSearchKw}
          onSelect={handleSelectConv}
          onNew={handleNewConversation}
          onDelete={conv.remove}
          onRenameConv={handleRenameConv}
          activeTab={activeTab}
          onTabChange={handleTabChange}
          onSelectSpace={handleSelectSpaceTasks}
          onSelectSubSystem={handleSelectSubSystem}
          activeFilter={taskFilter}
          onQuickQA={handleQuickQA}
          activeAgent={activeAgent}
          agents={builtinAgents}
          refreshKey={sidebarRefreshKey}
        />
        <main className="flex-1 flex flex-col min-w-0">
          <TopBar healthy={healthy} onSettings={() => setSettingsOpen(true)} />
          {selectedSub ? (
            <SubSystemDetailPage
              spaceId={selectedSub.spaceId}
              spaceName={selectedSub.spaceName}
              subId={selectedSub.subId}
              onBack={() => setSelectedSub(null)}
              onOpenTask={(t) => setSelectedTask({ id: t.id, name: t.name })}
              onNewTask={(ctx) => { setNewTaskCtx(ctx || {}); setNewTaskOpen(true) }}
              onOpenConv={(id) => handleConvCreated(id)}
              onTaskChanged={bumpSidebarRefresh}
            />
          ) : currentSpace ? (
            <SpaceDetailPage
              space={{
                id: currentSpace.id,
                name: currentSpace.name,
                description: '浙江移动数据库国产化迁移项目，包含营业、开通两大业务系统',
                tags: ['Oracle迁移', '达梦', '存量评估'],
                owner: '张三',
                createdAt: '2026-09-01',
                children: currentSpace.children,
              }}
              onBack={() => { setCurrentSpace(null); setActiveTab('workspace') }}
              onNewTask={(ctx) => { setNewTaskCtx(ctx || {}); setNewTaskOpen(true) }}
              onOpenTask={(t) => setSelectedTask({ id: t.id, name: t.name })}
              onOpenSub={(spaceId, spaceName, sub) => setSelectedSub({ spaceId, spaceName, subId: sub.id })}
            />
          ) : selectedTask ? (
            <TaskDetailPage
              taskId={selectedTask.id}
              onBack={() => setSelectedTask(null)}
              onSelectConv={(id) => {
                setSelectedTask(null)
                handleSelectConv(id)
                // 记录来源任务：会话页顶部任务标签可返回任务详情
                setChatFromTask(selectedTask)
              }}
              onNewConv={() => {
                if (!selectedTask) return
                setSelectedTask(null)
                // 新建会话默认智能体 = 任务主智能体（为空时回退到任务链路的执行主控）
                api.getTask(selectedTask.id).then(r => {
                  const agent = (r.success && r.data?.agent_id) || 'migration_commander'
                  setActiveAgent(agent)
                  api.createConversation(selectedTask.name, { task_id: selectedTask.id }).then(cr => {
                    if (cr.success && cr.data) handleConvCreated(cr.data.id)
                  })
                })
              }}
              onBackToTasks={(f) => { setTaskFilter(f); setSelectedTask(null) }}
              onCopyTask={(ctx) => { setNewTaskCtx(ctx as NewTaskContext); setNewTaskOpen(true) }}
            />
          ) : showTasksPage ? (
            <TaskListPage
              filter={taskFilter}
              onFilterChange={setTaskFilter}
              onNewTask={() => {
                setNewTaskCtx({
                  space: taskFilter ? { id: taskFilter.spaceId, name: taskFilter.spaceName, subsystems: [] } : undefined,
                  subId: taskFilter?.subId ?? undefined,
                })
                setNewTaskOpen(true)
              }}
              onOpenTask={(t) => setSelectedTask({ id: t.id, name: t.name })}
              onTaskChanged={bumpSidebarRefresh}
            />
          ) : isChatView ? (
            showWelcome ? (
              <WelcomePage
                onConvCreated={handleConvCreatedFromWelcome}
                activeAgent={activeAgent}
                setActiveAgent={setActiveAgent}
                quickMode={quickMode}
                onModeChange={setQuickMode}
                onConvertToProject={(spaceId, subId) => {
                  if (conv.currentId == null) return Promise.resolve()
                  return api.attachSpace(conv.currentId, { space_id: spaceId, sub_system_id: subId }).then(r => {
                    if (r.success) setQuickMode(false)
                    return r
                  }).catch(() => null)
                }}
                agentList={agentList}
              />
            ) : (
              <ChatView convId={conv.currentId} onConvCreated={handleConvCreated} onRefreshArtifacts={() => {}} activeAgent={activeAgent} setActiveAgent={setActiveAgent} quickMode={quickMode} onModeChange={setQuickMode}
                onBackToTask={chatFromTask ? () => {
                  const t = chatFromTask
                  setChatFromTask(null)
                  conv.setCurrentId(null)
                  setSelectedTask(t)
                } : undefined} onConvertToProject={(spaceId, subId) => {
                if (conv.currentId == null) return Promise.resolve()
                return api.attachSpace(conv.currentId, { space_id: spaceId, sub_system_id: subId }).then(r => { if (r.success) setQuickMode(false); return r }).catch(() => null)
              }} agentList={agentList} />
            )
          ) : (
            <WorkbenchView activeTab={activeTab} onTabChange={handleTabChange} />
          )}
        </main>
        <NewTaskDialog open={newTaskOpen} onClose={() => setNewTaskOpen(false)} context={newTaskCtx || undefined}
          agents={builtinAgents}
          onCreate={(task, enterSession) => {
            setNewTaskOpen(false)
            bumpSidebarRefresh()
            if (enterSession) {
              // 创建并进入会话：先建任务内会话
              api.createConversation(task.name, { space_id: task.space_id, sub_system_id: task.sub_system_id || undefined, task_id: task.id }).then(r => {
                if (r.success && r.data) handleConvCreated(r.data.id)
              })
            } else {
              setSelectedTask({ id: task.id, name: task.name })
            }
          }} />
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      </div>
    </TooltipProvider>
  )
}
