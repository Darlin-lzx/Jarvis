import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Plus, Trash2, ChevronRight, ChevronDown, BookOpen, Brain, Package, Bot, Puzzle, FileText, Database, Plug, MoreHorizontal, Pencil, FolderPlus, FolderOpen, MessageCircle, FileCode2, LayoutDashboard, Zap, PanelLeftClose, PanelLeftOpen, Workflow, Activity, Terminal, UserRound } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import type { BizTask, Space, UserProfile } from '@/lib/types'
import { DeleteTaskDialog } from '@/components/project/delete-task-dialog'

/* ---- 分组式菜单定义 ---- */
interface MenuGroup {
  id: string
  label: string
  items: { value: string; label: string; icon: React.ComponentType<{ className?: string }> }[]
}

const menuGroups: MenuGroup[] = [
  {
    id: 'knowledge',
    label: '知识管理',
    items: [
      { value: 'kb', label: '知识库', icon: BookOpen },
      { value: 'artifacts', label: '产物', icon: Package },
      { value: 'vector', label: '向量库管理', icon: Database },
      { value: 'kg', label: '知识图谱', icon: Brain },
    ],
  },
  {
    id: 'agent',
    label: '智能体能力',
    items: [
      { value: 'agents', label: '智能体', icon: Bot },
      { value: 'conversations', label: '会话管理', icon: MessageCircle },
      { value: 'skills', label: '技能', icon: Puzzle },
      { value: 'prompts', label: '提示词', icon: FileText },
      { value: 'templates', label: '模板中心', icon: FileCode2 },
    ],
  },
  {
    id: 'resource',
    label: '资源接入',
    items: [
      { value: 'dbs', label: '数据源', icon: Database },
      { value: 'mcp', label: 'MCP', icon: Plug },
      { value: 'users', label: '用户管理', icon: UserRound },
    ],
  },
  {
    id: 'process',
    label: '业务编排',
    items: [
      { value: 'workflows', label: '工作流', icon: Workflow },
    ],
  },
  {
    id: 'analysis',
    label: '数据分析',
    items: [
      { value: 'analysis', label: '数据查询', icon: Activity },
      { value: 'sql', label: 'SQL 查询', icon: Terminal },
    ],
  },
]

interface WorkspaceChild {
  id: string
  name: string
  taskCount?: number
}

export interface WorkspaceGroup {
  id: string
  name: string
  taskCount?: number
  children: WorkspaceChild[]
}

/** 任务页筛选（左侧空间点击联动，传入 App 后渲染 TaskListPage） */
export interface TaskFilter {
  spaceId: number
  spaceName: string
}

interface AgentInfo {
  id: string
  name: string
  color: string
}

interface SidebarProps {
  activeTab: string
  onTabChange: (tab: string) => void
  /** 当前登录用户显示名（登录后展示，替代固定档案名） */
  authName?: string
  /** 当前登录用户是否管理员（控制「用户管理」菜单可见性） */
  isAdmin?: boolean
  onSelectSpace?: (g: WorkspaceGroup) => void
  onCreateTask?: (group: WorkspaceGroup) => void
  onSelectTask?: (spaceId: number, taskId: number) => void
  onTaskDeleted?: (taskId: number) => void
  onQuickQA?: () => void
  activeFilter?: TaskFilter | null
  activeTaskId?: number | null
  activeAgent?: string
  agents?: AgentInfo[]
  /** 变化时触发侧边栏空间/任务数重新加载 */
  refreshKey?: number
}

const EXPANDED_KEY = 'sidebar_expanded'
const COLLAPSED_KEY = 'sidebar_collapsed'
/** 窄屏自动折叠阈值：220px 侧边栏在小屏会过度挤压主内容区 */
const AUTO_COLLAPSE_WIDTH = 1024

const defaultExpanded: Record<string, boolean> = {
  tasks: true,
  spaces: true,
  // 分组默认展开
  knowledge: true,
  agent: true,
  resource: true,
  process: true,
  analysis: true,
  ops: true,
}

function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch { return fallback }
}

function saveToStorage<T>(key: string, value: T) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch {}
}

/* 后端 Space + 全量任务 → 侧边栏空间/任务组结构 */
function toWorkspaceGroup(s: Space, tasks: BizTask[]): WorkspaceGroup {
  return {
    id: String(s.id),
    name: s.name,
    taskCount: s.task_count,
    children: tasks.filter(t => t.space_id === s.id).map(task => ({
      id: String(task.id),
      name: task.name,
    })),
  }
}

export function Sidebar({ activeTab, onTabChange, authName, isAdmin, onSelectSpace, onCreateTask, onSelectTask, onTaskDeleted, onQuickQA, activeFilter, activeTaskId, activeAgent: _activeAgent, agents: _agents, refreshKey }: SidebarProps) {
  const [groups, setGroups] = useState<WorkspaceGroup[]>([])
  const [spacesLoading, setSpacesLoading] = useState(true)
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>(() => loadFromStorage(EXPANDED_KEY, defaultExpanded))
  const [menuOpen, setMenuOpen] = useState<{ key: string; x: number; y: number } | null>(null)
  const [editingGroup, setEditingGroup] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; name: string } | null>(null)
  const [deletingTaskId, setDeletingTaskId] = useState<number | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const editInputRef = useRef<HTMLInputElement>(null)

  // 左下角登录用户信息（轻量：从后端 /api/me 读取，仅展示，不做鉴权）
  const [user, setUser] = useState<UserProfile | null>(null)
  const avatarChar = (authName || user?.name || '小迁').charAt(0)
  useEffect(() => {
    api.me().then(r => { if (r.success) setUser(r.data ?? null) }).catch(() => {})
  }, [])

  // 侧边栏折叠（图标窄条）：用户手动切换持久化；窗口 < 1024px 时自动折叠（仅折叠不强制展开）
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === '1' } catch { return false }
  })
  const toggleCollapsed = () => setCollapsed(prev => {
    const next = !prev
    try { localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0') } catch {}
    return next
  })
  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth < AUTO_COLLAPSE_WIDTH) setCollapsed(true)
    }
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 空间和任务分接口加载，前端按 space_id 组装三层目录
  const reloadSpaces = () => {
    setSpacesLoading(true)
    Promise.all([api.listSpaces(), api.listTasks()])
      .then(([spaceRes, taskRes]) => {
        if (!spaceRes.success) return
        const all = (spaceRes.data || []).filter(space => space.name !== '默认空间')
        const tasks = taskRes.success ? (taskRes.data || []) : []
        setGroups(all.map(space => toWorkspaceGroup(space, tasks)))
      })
      .catch(() => {})
      .finally(() => setSpacesLoading(false))
  }

  useEffect(() => { reloadSpaces() }, [refreshKey])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    if (editingGroup && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingGroup])

  useEffect(() => { saveToStorage(EXPANDED_KEY, expandedSections) }, [expandedSections])

  // 记录按钮位置供 portal 下拉菜单定位，避免被侧边栏滚动容器裁剪遮挡
  const openMenu = (key: string, e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect()
    setMenuOpen(prev => (prev && prev.key === key) ? null : { key, x: rect.left, y: rect.bottom + 4 })
  }

  const toggleSection = (id: string) => {
    setExpandedSections(prev => ({ ...prev, [id]: !prev[id] }))
  }

  const toggleGroup = (id: string) => {
    setExpandedSections(prev => ({ ...prev, [id]: !prev[id] }))
  }

  const toggleMenuGroup = (id: string) => {
    setExpandedSections(prev => ({ ...prev, [id]: !prev[id] }))
  }

  const addGroup = async () => {
    const name = '新空间'
    const r = await api.createSpace({ name })
    if (r.success && r.data) {
      const id = String(r.data.id)
      setGroups(prev => [...prev, { id, name, children: [] }])
      setExpandedSections(prev => ({ ...prev, [id]: true }))
      setEditingGroup(id)
      setEditName(name)
    }
  }

  const startRenameGroup = (id: string) => {
    const g = groups.find(x => x.id === id)
    if (g) {
      setEditingGroup(id)
      setEditName(g.name)
    }
    setMenuOpen(null)
  }

  const confirmRenameGroup = async () => {
    if (editingGroup && editName.trim()) {
      const g = groups.find(x => x.id === editingGroup)
      if (g) {
        const r = await api.updateSpace(Number(g.id), { name: editName.trim() })
        if (r.success) {
          setGroups(prev => prev.map(x => x.id === editingGroup ? { ...x, name: editName.trim() } : x))
        }
      }
    }
    setEditingGroup(null)
  }

  const deleteGroup = async (id: string) => {
    const r = await api.deleteSpace(Number(id))
    if (!r.success) return
    setGroups(prev => prev.filter(g => g.id !== id))
    setMenuOpen(null)
  }

  const deleteTaskFromSidebar = (taskId: number, name: string) => {
    setDeleteTarget({ id: taskId, name })
  }

  const confirmDeleteTaskFromSidebar = async (taskId: number) => {
    setDeletingTaskId(taskId)
    try {
      const r = await api.deleteTask(taskId)
      if (!r.success) {
        window.alert('删除失败，请稍后重试')
        return
      }
      setGroups(prev => prev.map(group => ({
        ...group,
        children: group.children.filter(child => Number(child.id) !== taskId),
      })))
      onTaskDeleted?.(taskId)
    } catch {
      window.alert('删除失败，请稍后重试')
    } finally {
      setDeletingTaskId(null)
      setDeleteTarget(null)
    }
  }

  const handleEditKeyDown = (e: React.KeyboardEvent, action: () => void) => {
    if (e.key === 'Enter') { e.preventDefault(); action() }
    if (e.key === 'Escape') setEditingGroup(null)
  }

  /* ========== 折叠态：图标窄条（48px），保留高频入口 ========== */
  if (collapsed) {
    const railBtn = (active: boolean) => cn(
      'p-2 rounded-md transition-colors',
      active ? 'text-indigo-400 bg-indigo-500/10' : 'text-[#b9b9c8] hover:bg-white/[0.05]'
    )
    return (
      <aside className="w-12 bg-[#12121a] border-r border-[#1e1e28] flex flex-col items-center py-3 gap-1 shrink-0">
        <button className={railBtn(false)} onClick={toggleCollapsed} title="展开侧边栏">
          <PanelLeftOpen className="w-4 h-4" />
        </button>
        <div className="w-6 h-px bg-[#252530] my-1" />
        <button className={railBtn(activeTab === 'workspace')} onClick={() => onTabChange('workspace')} title="工作台">
          <LayoutDashboard className="w-4 h-4" />
        </button>
        <button className={railBtn(false)} onClick={() => onQuickQA?.()} title="快速问答：免创建空间，临时提问（产物仅本地、不可入库）">
          <Zap className="w-4 h-4 text-amber-400" />
        </button>
        <div className="mt-auto" />
        <button className={railBtn(false)} title={authName || user?.name || '小迁'}>
          <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white"
               style={{ background: user?.avatar_color || '#5b7cfa' }}>
            {avatarChar}
          </div>
        </button>
      </aside>
    )
  }

  return (
    <aside className="w-[220px] bg-[#12121a] border-r border-[#1e1e28] flex flex-col shrink-0">
      {/* 品牌区 */}
      <div className="px-4 pt-4 pb-2">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
            <Bot className="w-3.5 h-3.5 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold text-[#e4e4e9] leading-tight">贾维斯</div>
          </div>
          <button
            className="p-1 rounded-md text-[#5a5a70] hover:text-[#b9b9c8] hover:bg-white/[0.05] transition-colors"
            onClick={toggleCollapsed}
            title="收起侧边栏"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 px-2.5 overflow-y-auto overflow-x-hidden">
        {/* 工作台 */}
        <div className="pb-2">
          <button
            className={cn(
              'w-full flex items-center gap-2 px-3 py-2 rounded-md transition-all duration-150',
              activeTab === 'workspace'
                ? 'bg-indigo-500/10 border border-indigo-500/20'
                : 'hover:bg-white/[0.03] border border-transparent'
            )}
            onClick={() => onTabChange('workspace')}
          >
            {activeTab === 'workspace' && (
              <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-r-full bg-indigo-500" />
            )}
            <LayoutDashboard className={cn(
              'w-4 h-4',
              activeTab === 'workspace' ? 'text-indigo-400' : 'text-[#b9b9c8]'
            )} />
            <span className={cn(
              'text-[12px]',
              activeTab === 'workspace' ? 'text-indigo-300 font-medium' : 'text-[#b9b9c8]'
            )}>
              工作台
            </span>
          </button>
        </div>

        <div className="pb-2">
          <button
            className={cn(
              'w-full flex items-center gap-2 px-3 py-2 rounded-md transition-all duration-150',
              'hover:bg-white/[0.03] border border-transparent'
            )}
            onClick={() => onQuickQA?.()}
            title="快速问答：免创建空间，临时提问（产物仅本地、不可入库）"
          >
            <Zap className="w-4 h-4 text-amber-400" />
            <span className="text-[12px] text-[#b9b9c8]">快速问答</span>
          </button>
        </div>

        {/* 空间 */}
        <div className="pb-2">
          <div className="flex items-center justify-between px-1 mb-1">
            <button
              className="flex-1 flex items-center gap-1 py-1.5 text-[11px] font-semibold text-[#8b8b9e] tracking-wide hover:text-[#8b8b9e] transition-colors"
              onClick={() => toggleSection('spaces')}
            >
              {expandedSections.spaces !== false ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
              空间
              <span className="text-[10px] font-normal text-[#b9b9c8] ml-0.5">
                {spacesLoading ? '…' : `(${groups.length})`}
              </span>
            </button>
            <button
              className="text-[#b9b9c8] hover:text-[#8b8b9e] transition-colors p-0.5 rounded hover:bg-white/[0.03]"
              onClick={addGroup}
              title="新增空间"
            >
              <FolderPlus className="w-3 h-3" />
            </button>
          </div>

          {expandedSections.spaces !== false && (
            <div className="space-y-1">
              {groups.map(group => (
                <div key={group.id} className="rounded-md bg-[#16161f]/60">
                  <div className="group flex items-center">
                    <button
                      className="shrink-0 p-1.5 text-[#b9b9c8] hover:text-[#cdd3e0] hover:bg-white/[0.04] rounded transition-colors"
                      title={expandedSections[group.id] ? '收起' : '展开'}
                      onClick={() => toggleGroup(group.id)}
                    >
                      {expandedSections[group.id] ? (
                        <ChevronDown className="w-3 h-3 text-indigo-400/60" />
                      ) : (
                        <ChevronRight className="w-3 h-3" />
                      )}
                    </button>
                    <button
                      className={cn(
                        'flex-1 relative flex items-center gap-1.5 px-2 py-1.5 text-[12px] font-bold transition-colors min-w-0 rounded-md',
                        activeFilter?.spaceId === Number(group.id)
                          ? 'text-indigo-300 bg-indigo-500/15 hover:bg-indigo-500/25'
                          : 'text-[#b9b9c8] hover:bg-[#16161f]/60 hover:text-[#e4e4e9]'
                      )}
                      title="进入空间主页"
                      onClick={(e) => {
                        if (editingGroup === group.id) { e.stopPropagation(); return }
                        onSelectSpace?.(group)
                      }}
                    >
                      {activeFilter?.spaceId === Number(group.id) && (
                        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-r-full bg-indigo-400" />
                      )}
                      <FolderOpen className={cn('w-3 h-3 shrink-0', activeFilter?.spaceId === Number(group.id) ? 'text-indigo-400' : 'text-[#b9b9c8]')} />
                      {editingGroup === group.id ? (
                        <Input
                          ref={editInputRef}
                          className="h-5 text-[11px] bg-[#1a1a24] border-indigo-500/40 px-1.5 rounded flex-1 min-w-0"
                          value={editName}
                          onChange={e => setEditName(e.target.value)}
                          onBlur={confirmRenameGroup}
                          onKeyDown={e => handleEditKeyDown(e, confirmRenameGroup)}
                          onClick={e => e.stopPropagation()}
                        />
                      ) : (
                        <span className="truncate">{group.name}</span>
                      )}
                    </button>
                    <button
                      className="p-1 rounded text-[#5a5a70] opacity-0 group-hover:opacity-100 hover:text-indigo-400 hover:bg-white/[0.05] transition-all shrink-0"
                      title="新增任务"
                      onClick={e => {
                        e.stopPropagation()
                        setMenuOpen(null)
                        setExpandedSections(prev => ({ ...prev, [group.id]: true }))
                        onCreateTask?.(group)
                      }}
                    >
                      <Plus className="w-3 h-3" />
                    </button>
                    <div className="relative">
                      <button
                        className="opacity-70 group-hover:opacity-100 text-[#b9b9c8] hover:text-[#8b8b9e] p-1 rounded hover:bg-white/[0.03] transition-all shrink-0"
                        onClick={e => { e.stopPropagation(); openMenu(`g-${group.id}`, e) }}
                      >
                        <MoreHorizontal className="w-3 h-3" />
                      </button>
                      {menuOpen?.key === `g-${group.id}` && createPortal(
                        <div ref={menuRef} className="fixed z-[100] bg-[#1e1e28] border border-[#2a2a35] rounded-lg shadow-xl py-1 min-w-[120px]"
                          style={{ left: menuOpen.x, top: menuOpen.y }}>
                          <button
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[#cdd3e0] hover:bg-white/[0.05] transition-colors"
                            onClick={() => startRenameGroup(group.id)}
                          >
                            <Pencil className="w-3 h-3" />
                            重命名
                          </button>
                          <div className="border-t border-[#2a2a35] my-1" />
                          <button
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-red-400 hover:bg-red-500/10 transition-colors"
                            onClick={() => deleteGroup(group.id)}
                          >
                            <Trash2 className="w-3 h-3" />
                            删除空间
                          </button>
                        </div>,
                        document.body
                      )}
                    </div>
                  </div>

                  {expandedSections[group.id] && group.children.length > 0 && (
                    <div className="relative ml-4 pl-3 pb-1 space-y-0.5 border-l border-[#2a2a35]/60">
                      {group.children.map(child => (
                        <div key={child.id} className="group/child flex items-center relative">
                          <div className="absolute left-[-12px] top-1/2 w-3 h-px bg-[#2a2a35]/60" />
                          <button
                            className={cn(
                              'flex-1 flex items-center gap-1.5 px-2 py-1 rounded text-[11px] transition-colors truncate min-w-0',
                              activeTaskId === Number(child.id)
                                ? 'bg-indigo-500/15 text-indigo-300'
                                : 'text-[#b9b9c8] hover:text-[#e4e4e9] hover:bg-white/[0.03]'
                            )}
                            onClick={() => onSelectTask?.(Number(group.id), Number(child.id))}
                          >
                            <span className="truncate">{child.name}</span>
                          </button>
                          <button
                            className="p-1 rounded text-[#5a5a70] opacity-0 group-hover/child:opacity-100 hover:text-red-400 hover:bg-white/[0.05] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                            title="删除任务"
                            disabled={deletingTaskId === Number(child.id)}
                            onClick={e => {
                              e.stopPropagation()
                              deleteTaskFromSidebar(Number(child.id), child.name)
                            }}
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                </div>
              ))}
            </div>
          )}
        </div>

        {/* 分组式菜单 */}
        {menuGroups.map(group => (
          <div key={group.id} className="pb-1">
            {/* 分组标题（可折叠） */}
            <button
              className={cn(
                'w-full relative flex items-center gap-1 px-2 py-1.5 text-[11px] font-bold tracking-wider transition-colors rounded-md',
                expandedSections[group.id] !== false
                  ? 'text-[#cdd3e0] bg-indigo-500/10'
                  : 'text-[#cdd3e0] hover:bg-white/[0.03]'
              )}
              onClick={() => toggleMenuGroup(group.id)}
            >
              <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[2.5px] h-3.5 rounded-r-full bg-indigo-400" />
              {expandedSections[group.id] !== false ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
              {group.label}
            </button>

            {/* 分组内子菜单 */}
            {expandedSections[group.id] !== false && (
              <div className="space-y-0.5 ml-3 pl-2 border-l border-[#2a2a35]/60">
                {group.items
                  .filter(item => item.value !== 'users' || isAdmin)
                  .map(item => {
                  const Icon = item.icon
                  return (
                    <button
                      key={item.value}
                      className={cn(
                        'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[12px] transition-all duration-150',
                        activeTab === item.value
                          ? 'bg-indigo-500/10 text-indigo-400'
                          : 'text-[#b9b9c8] hover:text-[#b9b9c8] hover:bg-white/[0.03]'
                      )}
                      onClick={() => onTabChange(item.value)}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      <span>{item.label}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        ))}
      </div>
      {/* 左下角登录用户信息（轻量：从 /api/me 读取） */}
      <div className="mt-auto border-t border-[#1e1e28] px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold text-white shrink-0"
               style={{ background: user?.avatar_color || '#5b7cfa' }}>
            {avatarChar}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold text-[#e4e4e9] leading-tight truncate">{authName || user?.name || '小迁'}</div>
          </div>
        </div>
      </div>

      <DeleteTaskDialog
        open={!!deleteTarget}
        taskName={deleteTarget?.name || ''}
        deleting={deleteTarget ? deletingTaskId === deleteTarget.id : false}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) confirmDeleteTaskFromSidebar(deleteTarget.id)
        }}
      />
    </aside>
  )
}
