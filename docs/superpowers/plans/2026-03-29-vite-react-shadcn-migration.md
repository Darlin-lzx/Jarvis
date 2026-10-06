# 前端重构：Vite + React + shadcn/ui 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `db_loc_agent/web/index.html`（~1300 行原生 HTML/CSS/JS 单文件）重构为 Vite + React + TypeScript + shadcn/ui 现代化前端项目。

**Architecture:** 新建 `web-ui/` 目录作为独立前端项目。使用 Vite 构建，React 18 + TypeScript，shadcn/ui 组件库（基于 Radix UI + Tailwind CSS）。通过 Vite proxy 代理 `/api` 请求到后端 FastAPI。组件按功能域拆分：Layout、Chat、Workbench（含多个面板）、Settings。

**Tech Stack:** Vite 6, React 18, TypeScript, Tailwind CSS 4, shadcn/ui, react-markdown, Vite dev server proxy

---

## 文件结构

```
db_loc_agent/
├── web-ui/                          # 新前端项目
│   ├── index.html
│   ├── package.json
│   ├── tsconfig.json
│   ├── tsconfig.app.json
│   ├── tsconfig.node.json
│   ├── vite.config.ts
│   ├── tailwind.config.ts
│   ├── postcss.config.js
│   ├── components.json              # shadcn/ui 配置
│   ├── src/
│   │   ├── main.tsx                 # 入口
│   │   ├── App.tsx                  # 根组件 + 状态管理
│   │   ├── index.css                # Tailwind 入口 + 全局暗色主题
│   │   ├── lib/
│   │   │   ├── api.ts               # 统一 API 层（所有 fetch 调用）
│   │   │   ├── utils.ts             # cn() 等工具
│   │   │   └── types.ts             # TypeScript 类型定义
│   │   ├── hooks/
│   │   │   ├── use-conversations.ts # 会话列表 + CRUD
│   │   │   ├── use-chat-stream.ts   # SSE 流式对话
│   │   │   └── use-health.ts        # 健康检查轮询
│   │   ├── components/
│   │   │   ├── layout/
│   │   │   │   ├── icon-bar.tsx     # 左侧图标导航栏
│   │   │   │   ├── sidebar.tsx      # 会话列表侧栏
│   │   │   │   └── top-bar.tsx      # 顶栏
│   │   │   ├── chat/
│   │   │   │   ├── chat-view.tsx    # 对话主视图
│   │   │   │   ├── message.tsx      # 消息气泡
│   │   │   │   ├── composer.tsx     # 输入框 + 发送
│   │   │   │   └── artifact-sidebar.tsx  # 右侧产物栏
│   │   │   ├── workbench/
│   │   │   │   ├── workbench-view.tsx    # 工作台容器 + Tab 切换
│   │   │   │   ├── kb-panel.tsx          # 知识库
│   │   │   │   ├── kg-panel.tsx          # 知识图谱
│   │   │   │   ├── agents-panel.tsx      # 智能体
│   │   │   │   ├── skills-panel.tsx      # 技能
│   │   │   │   ├── prompts-panel.tsx     # 提示词
│   │   │   │   ├── datasources-panel.tsx # 数据源
│   │   │   │   ├── mcp-panel.tsx         # MCP
│   │   │   │   ├── ops-panel.tsx         # 运维
│   │   │   │   ├── gov-panel.tsx         # 治理
│   │   │   │   ├── security-panel.tsx    # 安全审计
│   │   │   │   └── artifacts-panel.tsx   # 产物
│   │   │   ├── settings/
│   │   │   │   └── settings-dialog.tsx   # 设置弹窗
│   │   │   └── ui/                       # shadcn/ui 组件
│   │   │       ├── button.tsx
│   │   │       ├── input.tsx
│   │   │       ├── textarea.tsx
│   │   │       ├── dialog.tsx
│   │   │       ├── scroll-area.tsx
│   │   │       ├── tabs.tsx
│   │   │       ├── badge.tsx
│   │   │       ├── table.tsx
│   │   │       ├── select.tsx
│   │   │       ├── toast.tsx
│   │   │       └── ...
```

---

## Task 1: 初始化 Vite + React + TypeScript 项目

**Files:**
- Create: `db_loc_agent/web-ui/` 整个项目目录

- [ ] **Step 1: 用 Vite 脚手架创建项目**

```bash
cd /Users/l1nzx/Data/05_program/pythonProject/BDMP/db_loc_agent
npm create vite@latest web-ui -- --template react-ts
cd web-ui
npm install
```

- [ ] **Step 2: 安装 Tailwind CSS v4 和依赖**

```bash
npm install tailwindcss @tailwindcss/vite
```

- [ ] **Step 3: 配置 vite.config.ts**

```ts
// web-ui/vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
```

- [ ] **Step 4: 配置 tsconfig.app.json 添加路径别名**

在 `compilerOptions` 中添加：

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

- [ ] **Step 5: 设置 Tailwind CSS 入口**

替换 `src/index.css`：

```css
@import "tailwindcss";
```

- [ ] **Step 6: 更新 src/main.tsx**

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

- [ ] **Step 7: 验证项目启动**

```bash
cd web-ui && npm run dev
```

Expected: Vite dev server 在 http://localhost:5173 启动，无报错。

- [ ] **Step 8: Commit**

```bash
git add web-ui/
git commit -m "feat: init Vite + React + TypeScript project"
```

---

## Task 2: 初始化 shadcn/ui

**Files:**
- Create: `web-ui/components.json`
- Create: `web-ui/src/components/ui/*.tsx` (多个 shadcn 组件)
- Create: `web-ui/src/lib/utils.ts`

- [ ] **Step 1: 初始化 shadcn/ui**

```bash
cd web-ui
npx shadcn@latest init
```

选择：
- Style: Default
- Base color: Slate
- CSS variables: Yes

这会自动创建 `components.json`、`src/lib/utils.ts`，并更新 CSS/Tailwind 配置。

- [ ] **Step 2: 安装所需 shadcn 组件**

```bash
npx shadcn@latest add button input textarea dialog scroll-area tabs badge table select card separator tooltip label
```

- [ ] **Step 3: 验证组件可用**

临时在 `App.tsx` 中写一个测试按钮，确认无 TS 报错后删除。

- [ ] **Step 4: Commit**

```bash
git add web-ui/
git commit -m "feat: init shadcn/ui with required components"
```

---

## Task 3: 定义 TypeScript 类型和 API 层

**Files:**
- Create: `web-ui/src/lib/types.ts`
- Create: `web-ui/src/lib/api.ts`

- [ ] **Step 1: 创建类型定义 `src/lib/types.ts`**

```ts
// web-ui/src/lib/types.ts

export interface Conversation {
  id: number
  title: string
  created_at?: string
  updated_at?: string
}

export interface Message {
  id: number
  role: 'user' | 'assistant'
  content: string
  agent_id?: string
  created_at?: string
}

export interface TraceEvent {
  id: number
  node: string
  content: Record<string, unknown> | string
  agent_id?: string
  created_at?: string
}

export interface StreamEvent {
  type: 'text' | 'parse' | 'route' | 'skill' | 'artifact' | 'error' | 'done'
  content: unknown
}

export interface Settings {
  provider: string
  model: string
  base_url: string
  api_key: string
  embedding_model: string
}

export interface Agent {
  id: string
  name: string
  intent?: string
  description?: string
  default_prompt?: string
  gen_artifact: boolean
  enabled: boolean
  builtin?: boolean
}

export interface Skill {
  skill_id: string
  name: string
  description?: string
  content?: string
  script?: string
  chain?: string[]
  enabled: boolean
}

export interface Datasource {
  name: string
  kind: string
  location?: string
  enabled: boolean
}

export interface KBDocument {
  id: number
  name: string
  source_type: string
  chunk_count: number
  enabled: boolean
  created_at: string
}

export interface KBTriple {
  subject: string
  relation: string
  object: string
  doc?: string
}

export interface KGOverview {
  entities: number
  relations: number
  entity_types: { type: string; count: number }[]
  top_relations: { relation: string; count: number }[]
}

export interface MCPServer {
  id: number
  name: string
  kind: string
  command_or_url: string
  enabled: boolean
}

export interface Prompt {
  id: number
  name: string
  category: string
  content: string
  enabled: boolean
}

export interface OpsHealthRecord {
  ds: string
  kind: string
  ok: boolean
  latency_ms: number
  detail?: string
  created_at?: string
}

export interface GovAsset {
  ds: string
  object: string
  obj_type: string
  columns: string[]
  row_count: number
  pk?: string
}

export interface GovQualityRow {
  ds: string
  object: string
  row_count: number
  filled_rate: number
  unique_rate: number
  null_rate: number
  score: number
  issues: string[]
}

export interface SecurityLog {
  id: number
  method: string
  path: string
  ip: string
  status: number
  duration_ms: number
  notes?: string
  created_at?: string
}

export interface ArtifactNamespace {
  namespace: string
  files: { id: number; path: string }[]
}

export interface ApiResponse<T> {
  success: boolean
  data?: T
  detail?: string
  error?: string
  message?: string
}
```

- [ ] **Step 2: 创建 API 层 `src/lib/api.ts`**

```ts
// web-ui/src/lib/api.ts
import type {
  ApiResponse, Conversation, Message, TraceEvent, Settings,
  Agent, Skill, Datasource, KBDocument, KGOverview, KBTriple,
  MCPServer, Prompt, OpsHealthRecord, GovAsset, GovQualityRow,
  SecurityLog,
} from './types'

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<ApiResponse<T>> {
  const opt: RequestInit = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opt.body = JSON.stringify(body)
  const res = await fetch(path, opt)
  return res.json()
}

// ---- 健康 ----
export const api = {
  health: () => request<{ status: string }>('/api/health'),

  // ---- 设置 ----
  getSettings: () => request<Settings>('/api/settings'),
  updateSettings: (s: Partial<Settings>) => request<never>('/api/settings', 'PUT', s),
  fetchOllamaModels: () => request<string[]>('/api/ollama/models'),

  // ---- 会话 ----
  listConversations: () => request<Conversation[]>('/api/conversations'),
  createConversation: (title: string) => request<{ id: number; title: string }>('/api/conversations', 'POST', { title }),
  deleteConversation: (id: number) => request<never>(`/api/conversations/${id}`, 'DELETE'),
  getMessages: (cid: number) => request<Message[]>(`/api/conversations/${cid}/messages`),
  getTrace: (cid: number) => request<TraceEvent[]>(`/api/conversations/${cid}/trace`),

  // ---- 对话流 (SSE) ----
  chatStream: (message: string, convId: number | null) =>
    fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, conv_id: convId }),
    }),

  // ---- 智能体 ----
  listAgents: () => request<Agent[]>('/api/agents'),
  createAgent: (a: Partial<Agent>) => request<Agent>('/api/agents', 'POST', a),
  toggleAgent: (aid: string, enabled: boolean) => request<never>(`/api/agents/${aid}/toggle`, 'POST', { enabled }),
  deleteAgent: (aid: string) => request<never>(`/api/agents/${aid}`, 'DELETE'),

  // ---- 数据源 ----
  listDatasources: () => request<Datasource[]>('/api/datasources'),
  createDatasource: (d: Partial<Datasource> & { username?: string; password?: string; dsn?: string }) =>
    request<Datasource>('/api/datasources', 'POST', d),
  toggleDatasource: (name: string, enabled: boolean) =>
    request<never>(`/api/datasources/${encodeURIComponent(name)}/toggle`, 'POST', { enabled }),
  deleteDatasource: (name: string) => request<never>(`/api/datasources/${encodeURIComponent(name)}`, 'DELETE'),
  testDatasource: (name: string) => request<unknown>(`/api/datasources/${encodeURIComponent(name)}/test`, 'POST', {}),
  queryDatasource: (name: string, sql: string) =>
    request<unknown>(`/api/datasources/${encodeURIComponent(name)}/query`, 'POST', { sql }),
  explainDatasource: (name: string, sql: string) =>
    request<unknown>(`/api/datasources/${encodeURIComponent(name)}/explain`, 'POST', { sql }),

  // ---- 知识库 ----
  listDocuments: () => request<KBDocument[]>('/api/kb/documents'),
  uploadDocument: (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return fetch('/api/kb/documents', { method: 'POST', body: fd }).then(r => r.json()) as Promise<ApiResponse<{ id: number; chunks: number }>>
  },
  deleteDocument: (id: number) => request<never>(`/api/kb/documents/${id}`, 'DELETE'),
  searchKB: (q: string) => request<unknown[]>('/api/kb/search?q=' + encodeURIComponent(q)),
  rebuildKG: () => request<{ entities: number; relations: number }>('/api/kg/rebuild', 'POST'),

  // ---- 知识图谱 ----
  kgOverview: () => request<KGOverview>('/api/kg/overview'),
  kgExpand: (q: string) => request<{ terms: string[]; triples: KBTriple[] }>('/api/kg/expand?q=' + encodeURIComponent(q)),

  // ---- 技能 ----
  listSkills: () => request<Skill[]>('/api/skills'),
  createSkill: (text: string) => request<Skill>('/api/skills', 'POST', { text }),
  updateSkill: (sid: string, data: { name: string; description: string; content: string }) =>
    request<Skill>(`/api/skills/${sid}`, 'PUT', data),
  toggleSkill: (sid: string, enabled: boolean) => request<never>(`/api/skills/${sid}/toggle`, 'POST', { enabled }),
  deleteSkill: (sid: string) => request<never>(`/api/skills/${sid}`, 'DELETE'),
  runSkill: (sid: string) => request<unknown>(`/api/skills/${sid}/run`, 'POST', {}),
  uploadSkillScript: (sid: string, file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return fetch(`/api/skills/${sid}/script`, { method: 'POST', body: fd }).then(r => r.json())
  },

  // ---- 提示词 ----
  listPrompts: () => request<Prompt[]>('/api/prompts'),
  createPrompt: (p: { name: string; category: string; content: string }) =>
    request<Prompt>('/api/prompts', 'POST', p),
  updatePrompt: (id: number, data: Partial<Prompt>) => request<Prompt>(`/api/prompts/${id}`, 'PUT', data),
  deletePrompt: (id: number) => request<never>(`/api/prompts/${id}`, 'DELETE'),

  // ---- 产物 ----
  listArtifacts: (convId?: number, namespace?: string) => {
    const params = new URLSearchParams()
    if (convId) params.set('conv_id', String(convId))
    if (namespace) params.set('namespace', namespace)
    return request<unknown[]>('/api/artifacts?' + params.toString())
  },
  getArtifactFile: (rid: number) => request<string>(`/api/artifacts/${rid}/file`),

  // ---- MCP ----
  listMCPServers: () => request<MCPServer[]>('/api/mcp/servers'),
  createMCPServer: (s: { name: string; kind: string; command_or_url: string }) =>
    request<MCPServer>('/api/mcp/servers', 'POST', s),
  testMCPServer: (id: number) => request<{ message: string }>(`/api/mcp/servers/${id}/test`, 'POST', {}),

  // ---- 运维 ----
  opsHealthHistory: () => request<OpsHealthRecord[]>('/api/ops/health/history?limit=30'),
  opsHealthCheck: (ds?: string) => request<{ message: string }>('/api/ops/health', 'POST', { ds }),
  opsSlowSQL: (thresholdMs?: number) => request<unknown>(`/api/ops/slow-sql?threshold_ms=${thresholdMs || 500}&limit=50`),
  opsBaseline: () => request<unknown>('/api/ops/baseline'),

  // ---- 治理 ----
  govCatalog: (ds?: string) => request<{ message: string }>('/api/gov/catalog', 'POST', { ds }),
  govAssets: (ds?: string) => request<GovAsset[]>('/api/gov/assets?ds=' + encodeURIComponent(ds || '')),
  govQuality: (ds?: string) => request<{ message: string }>('/api/gov/quality', 'POST', { ds }),
  govQualityRows: (ds?: string) => request<GovQualityRow[]>('/api/gov/quality/rows?ds=' + encodeURIComponent(ds || '')),
  govKgSync: () => request<{ message: string }>('/api/gov/kgsync', 'POST', {}),

  // ---- 安全审计 ----
  securityLogs: (limit = 300) => request<SecurityLog[]>(`/api/security/logs?limit=${limit}`),
}
```

- [ ] **Step 3: 验证 TypeScript 编译**

```bash
cd web-ui && npx tsc --noEmit
```

Expected: 无错误输出。

- [ ] **Step 4: Commit**

```bash
git add web-ui/src/lib/
git commit -m "feat: add TypeScript types and API layer"
```

---

## Task 4: 创建自定义 Hooks

**Files:**
- Create: `web-ui/src/hooks/use-conversations.ts`
- Create: `web-ui/src/hooks/use-chat-stream.ts`
- Create: `web-ui/src/hooks/use-health.ts`

- [ ] **Step 1: 创建 `use-conversations.ts`**

```ts
// web-ui/src/hooks/use-conversations.ts
import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { Conversation } from '@/lib/types'

export function useConversations() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [currentId, setCurrentId] = useState<number | null>(null)
  const [searchKw, setSearchKw] = useState('')

  const load = useCallback(async () => {
    const r = await api.listConversations()
    if (r.success) setConversations(r.data || [])
  }, [])

  const create = useCallback(async (title: string) => {
    const r = await api.createConversation(title)
    if (r.success && r.data) {
      setCurrentId(r.data.id)
      await load()
    }
    return r
  }, [load])

  const remove = useCallback(async (id: number) => {
    const r = await api.deleteConversation(id)
    if (r.success) {
      if (currentId === id) setCurrentId(null)
      await load()
    }
  }, [currentId, load])

  useEffect(() => { load() }, [load])

  const filtered = searchKw
    ? conversations.filter(c => (c.title || '').toLowerCase().includes(searchKw.toLowerCase()))
    : conversations

  return { conversations: filtered, currentId, setCurrentId, create, remove, reload: load, searchKw, setSearchKw }
}
```

- [ ] **Step 2: 创建 `use-chat-stream.ts`**

```ts
// web-ui/src/hooks/use-chat-stream.ts
import { useState, useCallback, useRef } from 'react'
import { api } from '@/lib/api'
import type { StreamEvent } from '@/lib/types'

export interface ChatStep {
  type: string
  content: Record<string, unknown> | string
}

export function useChatStream() {
  const [streaming, setStreaming] = useState(false)
  const [assistantText, setAssistantText] = useState('')
  const [steps, setSteps] = useState<ChatStep[]>([])
  const abortRef = useRef<AbortController | null>(null)

  const send = useCallback(async (message: string, convId: number | null) => {
    setStreaming(true)
    setAssistantText('')
    setSteps([])

    try {
      const resp = await api.chatStream(message, convId)
      const reader = resp.body?.getReader()
      if (!reader) return

      const dec = new TextDecoder()
      let buf = ''
      let fullText = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const parts = buf.split('\n\n')
        buf = parts.pop() || ''

        for (const part of parts) {
          if (!part.startsWith('data:')) continue
          const line = part.replace(/^data:\s*/, '').trim()
          if (line === '[DONE]') continue
          try {
            const ev: StreamEvent = JSON.parse(line)
            if (ev.type === 'text') {
              fullText += ev.content as string
              setAssistantText(fullText)
            } else if (ev.type === 'done') {
              // stream complete
            } else {
              setSteps(prev => [...prev, { type: ev.type, content: ev.content as Record<string, unknown> | string }])
            }
          } catch { /* ignore parse errors */ }
        }
      }
      return fullText
    } finally {
      setStreaming(false)
    }
  }, [])

  return { streaming, assistantText, steps, send }
}
```

- [ ] **Step 3: 创建 `use-health.ts`**

```ts
// web-ui/src/hooks/use-health.ts
import { useState, useEffect } from 'react'
import { api } from '@/lib/api'

export function useHealth(intervalMs = 10000) {
  const [healthy, setHealthy] = useState(false)

  useEffect(() => {
    let mounted = true
    const check = async () => {
      try {
        const r = await api.health()
        if (mounted) setHealthy(r.success && r.data?.status === 'ok')
      } catch { if (mounted) setHealthy(false) }
    }
    check()
    const id = setInterval(check, intervalMs)
    return () => { mounted = false; clearInterval(id) }
  }, [intervalMs])

  return healthy
}
```

- [ ] **Step 4: Commit**

```bash
git add web-ui/src/hooks/
git commit -m "feat: add custom hooks for conversations, chat stream, health"
```

---

## Task 5: 创建布局组件

**Files:**
- Create: `web-ui/src/components/layout/icon-bar.tsx`
- Create: `web-ui/src/components/layout/sidebar.tsx`
- Create: `web-ui/src/components/layout/top-bar.tsx`

- [ ] **Step 1: 创建 `icon-bar.tsx`**

左侧图标导航栏，包含"对话"、"工作台"、"设置"三个按钮。

```tsx
// web-ui/src/components/layout/icon-bar.tsx
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

type View = 'chat' | 'workbench'

interface IconBarProps {
  currentView: View
  onViewChange: (v: View) => void
  onSettings: () => void
}

export function IconBar({ currentView, onViewChange, onSettings }: IconBarProps) {
  return (
    <nav className="w-14 bg-[#111116] border-r border-[#2f2f38] flex flex-col items-center py-3 gap-0.5 shrink-0">
      <div
        className="w-8 h-8 rounded-[10px] bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] flex items-center justify-center font-bold text-xs text-white mb-4 cursor-pointer shadow-lg hover:scale-105 transition-transform"
        onClick={() => onViewChange('chat')}
      >
        库
      </div>

      <div className="flex flex-col gap-0.5 w-full items-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              className={`w-11 h-14 flex-col gap-1 ${currentView === 'chat' ? 'bg-gradient-to-br from-[#5b7cfa22] to-[#7a5bfa14] border border-[#5b7cfa80] text-white' : ''}`}
              onClick={() => onViewChange('chat')}
            >
              <span className="text-[17px]">💬</span>
              <span className="text-[10px]">对话</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">对话</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              className={`w-11 h-14 flex-col gap-1 ${currentView === 'workbench' ? 'bg-gradient-to-br from-[#5b7cfa22] to-[#7a5bfa14] border border-[#5b7cfa80] text-white' : ''}`}
              onClick={() => onViewChange('workbench')}
            >
              <span className="text-[17px]">🧰</span>
              <span className="text-[10px]">工作台</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">工作台</TooltipContent>
        </Tooltip>
      </div>

      <div className="flex flex-col gap-0.5 w-full items-center mt-3 pt-2 border-t border-[#2f2f38]">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" className="w-11 h-14 flex-col gap-1" onClick={onSettings}>
              <span className="text-[17px]">⚙️</span>
              <span className="text-[10px]">设置</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">设置</TooltipContent>
        </Tooltip>
      </div>
    </nav>
  )
}
```

- [ ] **Step 2: 创建 `sidebar.tsx`**

会话列表侧栏。

```tsx
// web-ui/src/components/layout/sidebar.tsx
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { Conversation } from '@/lib/types'

interface SidebarProps {
  conversations: Conversation[]
  currentId: number | null
  searchKw: string
  onSearch: (kw: string) => void
  onSelect: (id: number) => void
  onNew: () => void
  onDelete: (id: number) => void
}

function fmtTime(iso?: string) {
  if (!iso) return ''
  const d = new Date(iso)
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 3600) return Math.max(1, Math.round(diff / 60)) + ' 分钟前'
  if (diff < 86400) return Math.round(diff / 3600) + ' 小时前'
  if (diff < 2592000) return Math.round(diff / 86400) + ' 天前'
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function Sidebar({ conversations, currentId, searchKw, onSearch, onSelect, onNew, onDelete }: SidebarProps) {
  return (
    <aside className="w-52 bg-[#1d1d22] border-r border-[#2f2f38] flex flex-col shrink-0">
      <div className="flex items-center justify-between px-3.5 pt-4 pb-2">
        <h4 className="text-[#9a9aa4] text-xs font-semibold tracking-wider">会话</h4>
        <Button variant="ghost" size="icon" className="text-[#5b7cfa] h-7 w-7" onClick={onNew} title="新建会话">
          ＋
        </Button>
      </div>
      <Input
        className="mx-3 mb-2 h-7 text-xs bg-[#26262d] border-[#3a3a45]"
        placeholder={`🔍 搜索会话（共 ${conversations.length}）`}
        value={searchKw}
        onChange={e => onSearch(e.target.value)}
      />
      <div className="text-[10.5px] text-[#9a9aa4] text-center pb-1">{conversations.length} 个会话</div>
      <ScrollArea className="flex-1 px-2">
        {conversations.length === 0 ? (
          <div className="text-xs text-[#9a9aa4] p-2.5 text-center border border-dashed border-[#3a3a45] rounded-lg">
            暂无会话
          </div>
        ) : (
          conversations.map(c => (
            <div
              key={c.id}
              className={`relative group px-2.5 py-2 rounded-lg cursor-pointer text-[13px] mb-0.5 transition-colors ${
                c.id === currentId ? 'bg-[#26262d] text-white shadow-[inset_2px_0_0_#5b7cfa]' : 'hover:bg-[#26262d]'
              }`}
              onClick={() => onSelect(c.id)}
            >
              <div className="truncate text-[#e8e8ec]">{c.title || '未命名'}</div>
              <span className="text-[10.5px] text-[#9a9aa4]">{fmtTime(c.created_at)}</span>
              <button
                className="absolute right-1.5 top-1/2 -translate-y-1/2 hidden group-hover:block text-[#9a9aa4] hover:text-[#f56c6c] p-1 rounded-md hover:bg-[#f56c6c1a] text-[13px]"
                onClick={e => { e.stopPropagation(); onDelete(c.id) }}
              >
                🗑
              </button>
            </div>
          ))
        )}
      </ScrollArea>
    </aside>
  )
}
```

- [ ] **Step 3: 创建 `top-bar.tsx`**

```tsx
// web-ui/src/components/layout/top-bar.tsx
interface TopBarProps {
  healthy: boolean
}

export function TopBar({ healthy }: TopBarProps) {
  return (
    <div className="h-12 bg-[#1d1d22] border-b border-[#2f2f38] flex items-center gap-2.5 px-4 text-[13px] shrink-0">
      <div className={`w-2 h-2 rounded-full ${healthy ? 'bg-[#3ddc97] shadow-[0_0_6px_rgba(61,220,151,0.6)]' : 'bg-[#f56c6c] shadow-[0_0_6px_rgba(245,108,108,0.6)]'}`} />
      <span className="font-semibold text-[#e8e8ec]">数据库国产化智能体</span>
    </div>
  )
}
```

- [ ] **Step 4: Commit**

```bash
git add web-ui/src/components/layout/
git commit -m "feat: add layout components (IconBar, Sidebar, TopBar)"
```

---

## Task 6: 创建对话视图组件

**Files:**
- Create: `web-ui/src/components/chat/chat-view.tsx`
- Create: `web-ui/src/components/chat/message.tsx`
- Create: `web-ui/src/components/chat/composer.tsx`
- Create: `web-ui/src/components/chat/artifact-sidebar.tsx`

- [ ] **Step 1: 安装 react-markdown**

```bash
cd web-ui && npm install react-markdown
```

- [ ] **Step 2: 创建 `message.tsx`**

消息气泡组件，支持 Markdown 渲染。

```tsx
// web-ui/src/components/chat/message.tsx
import ReactMarkdown from 'react-markdown'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { ChatStep } from '@/hooks/use-chat-stream'

interface MessageProps {
  role: 'user' | 'assistant' | 'event'
  content: string
}

export function Message({ role, content }: MessageProps) {
  if (role === 'event') {
    return (
      <div className="self-start bg-transparent text-[#9a9aa4] text-xs border border-dashed border-[#3a3a45] max-w-[96%] px-3 py-1.5 rounded-[10px]"
        dangerouslySetInnerHTML={{ __html: content }}
      />
    )
  }

  return (
    <div className={`relative group max-w-[80%] px-4 py-3 text-sm leading-relaxed ${
      role === 'user'
        ? 'self-end bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white rounded-[14px] rounded-br-sm'
        : 'self-start bg-[#26262d] border border-[#2f2f38] text-[#e8e8ec] rounded-[14px] rounded-bl-sm'
    }`}>
      {role === 'assistant' ? (
        <div className="prose prose-invert prose-sm max-w-none">
          <ReactMarkdown>{content}</ReactMarkdown>
        </div>
      ) : (
        <span className="whitespace-pre-wrap break-words">{content}</span>
      )}
      <button
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 bg-[#2e2e37] border border-[#3a3a45] text-[#9a9aa4] rounded-md px-1.5 py-0.5 text-[11px] hover:text-white hover:border-[#5b7cfa] transition-opacity"
        onClick={() => navigator.clipboard.writeText(content)}
      >
        复制
      </button>
    </div>
  )
}

interface StepEventProps {
  step: ChatStep
}

const stepLabels: Record<string, string> = {
  parse: '🧭 识别意图',
  route: '🤖 路由',
  skill: '⚙️ 调用技能',
  artifact: '📦 产物',
  error: '❌ 错误',
}

export function StepEvent({ step }: StepEventProps) {
  const label = stepLabels[step.type] || step.type
  const c = typeof step.content === 'object' ? step.content : {}
  let detail = ''
  if (step.type === 'parse' && c.intent) detail = ` · 意图 ${c.intent as string}`
  if (step.type === 'route' && c.agent_id) detail = ` · ${c.agent_id as string}`
  if (step.type === 'skill' && c.skill_id) detail = ` · ${c.skill_id as string}`

  return (
    <div className="self-start bg-transparent text-[#9a9aa4] text-xs border border-dashed border-[#3a3a45] max-w-[96%] px-3 py-1.5 rounded-[10px]"
      dangerouslySetInnerHTML={{ __html: `${label}<b>${detail}</b>` }}
    />
  )
}
```

- [ ] **Step 3: 创建 `composer.tsx`**

```tsx
// web-ui/src/components/chat/composer.tsx
import { useState, useRef, type KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

interface ComposerProps {
  onSend: (text: string) => void
  disabled: boolean
}

export function Composer({ onSend, disabled }: ComposerProps) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  const handleSend = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    onSend(trimmed)
    setText('')
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="p-4 border-t border-[#2f2f38] flex gap-2.5 items-end bg-[#1d1d22]">
      <Textarea
        ref={ref}
        className="flex-1 h-[46px] bg-[#26262d] border-[#2f2f38] text-[#e8e8ec] text-sm resize-none focus:border-[#5b7cfa]"
        placeholder="输入需求，自动解析并路由到 Agent（Enter 发送，Shift+Enter 换行）"
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <Button
        className="bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white rounded-xl px-5 hover:shadow-[0_4px_14px_rgba(91,124,250,0.4)]"
        disabled={disabled}
        onClick={handleSend}
      >
        发送
      </Button>
    </div>
  )
}
```

- [ ] **Step 4: 创建 `artifact-sidebar.tsx`**

```tsx
// web-ui/src/components/chat/artifact-sidebar.tsx
import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import { ScrollArea } from '@/components/ui/scroll-area'

interface ArtifactSidebarProps {
  convId: number | null
}

export function ArtifactSidebar({ convId }: ArtifactSidebarProps) {
  const [namespaces, setNamespaces] = useState<string[]>([])
  const [preview, setPreview] = useState<{ title: string; content: string } | null>(null)

  useEffect(() => {
    if (convId == null) { setNamespaces([]); return }
    api.listArtifacts(convId).then(r => {
      if (r.success) setNamespaces((r.data as string[]) || [])
    })
  }, [convId])

  const viewFile = async (rid: number) => {
    const r = await api.getArtifactFile(rid)
    if (r.success) setPreview({ title: `产物 #${rid}`, content: (r.data as string) || '' })
  }

  return (
    <aside className="w-64 shrink-0 bg-[#1d1d22] border-l border-[#2f2f38] text-xs">
      <div className="p-3 font-semibold text-[#9a9aa4] tracking-wider">📦 产物 · 当前会话</div>
      <ScrollArea className="px-3 pb-3">
        {convId == null ? (
          <div className="text-[#9a9aa4] p-2.5 text-center border border-dashed border-[#3a3a45] rounded-lg">
            先新建或选择会话以生成产物
          </div>
        ) : namespaces.length === 0 ? (
          <div className="text-[#9a9aa4] p-2.5 text-center border border-dashed border-[#3a3a45] rounded-lg">
            本会话暂无产物
          </div>
        ) : (
          namespaces.map(ns => (
            <div key={ns} className="mb-3">
              <div className="text-[#e8e8ec] break-all text-xs">📁 {ns.split('/').slice(1).join(' / ')}</div>
            </div>
          ))
        )}
      </ScrollArea>

      {preview && (
        <div className="fixed inset-0 bg-black/65 flex items-center justify-center z-50 backdrop-blur-sm" onClick={() => setPreview(null)}>
          <div className="bg-[#1d1d22] border border-[#3a3a45] rounded-[14px] w-[760px] max-h-[88vh] p-5 overflow-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-[15px] mb-4">{preview.title}</h3>
            <pre className="bg-[#101015] border border-[#2f2f38] rounded-[10px] p-3.5 text-xs text-[#cdd3e0] whitespace-pre-wrap max-h-[62vh] overflow-auto">
              {preview.content}
            </pre>
            <div className="mt-3 text-right">
              <button className="px-3 py-1.5 text-xs rounded-lg bg-[#26262d] border border-[#3a3a45] text-[#e8e8ec] hover:border-[#5b7cfa]" onClick={() => setPreview(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
```

- [ ] **Step 5: 创建 `chat-view.tsx`**

```tsx
// web-ui/src/components/chat/chat-view.tsx
import { useState, useEffect, useRef } from 'react'
import { Message, StepEvent } from './message'
import { Composer } from './composer'
import { ArtifactSidebar } from './artifact-sidebar'
import { useChatStream, type ChatStep } from '@/hooks/use-chat-stream'
import { api } from '@/lib/api'
import type { Message as MsgType, TraceEvent } from '@/lib/types'
import { ScrollArea } from '@/components/ui/scroll-area'

interface ChatViewProps {
  convId: number | null
  onConvCreated: (id: number) => void
  onRefreshArtifacts: () => void
}

interface DisplayItem {
  kind: 'message' | 'step'
  role?: 'user' | 'assistant'
  content: string
  step?: ChatStep
}

export function ChatView({ convId, onConvCreated, onRefreshArtifacts }: ChatViewProps) {
  const [items, setItems] = useState<DisplayItem[]>([])
  const { streaming, assistantText, steps, send } = useChatStream()
  const scrollRef = useRef<HTMLDivElement>(null)
  const loadedConvRef = useRef<number | null>(null)

  // Load history when conversation changes
  useEffect(() => {
    if (convId == null || convId === loadedConvRef.current) return
    loadedConvRef.current = convId
    setItems([])

    Promise.all([api.getMessages(convId), api.getTrace(convId)]).then(([mr, tr]) => {
      const msgs = (mr.success ? mr.data : []) as MsgType[]
      const events = (tr.success ? tr.data : []) as TraceEvent[]
      const display: DisplayItem[] = []

      for (const m of msgs) {
        if (m.role === 'user' || m.role === 'assistant') {
          display.push({ kind: 'message', role: m.role, content: m.content })
        }
      }
      for (const ev of events) {
        display.push({ kind: 'step', step: { type: ev.node, content: ev.content } })
      }
      setItems(display)
    })
  }, [convId])

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [items, assistantText, steps])

  const handleSend = async (text: string) => {
    let cid = convId
    if (cid == null) {
      const r = await api.createConversation(text.slice(0, 20))
      if (r.success && r.data) {
        cid = r.data.id
        onConvCreated(r.data.id)
      }
    }

    // Clear timeline view, add user message
    setItems(prev => {
      // Remove old timeline head if present
      return [...prev.filter(i => !(i.kind === 'step')), { kind: 'message', role: 'user', content: text }]
    })

    const fullText = await send(text, cid)
    if (fullText) {
      setItems(prev => [...prev, { kind: 'message', role: 'assistant', content: fullText }])
    }
    onRefreshArtifacts()
  }

  // Build live items (history + streaming)
  const liveItems: DisplayItem[] = [...items]
  if (streaming && assistantText) {
    liveItems.push({ kind: 'message', role: 'assistant', content: assistantText })
  }
  // Add live steps that aren't from history
  if (streaming && steps.length > 0) {
    for (const s of steps) {
      liveItems.push({ kind: 'step', step: s })
    }
  }

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <div className="flex-1 min-h-0 flex">
        <ScrollArea className="flex-1" ref={scrollRef}>
          <div className="flex flex-col gap-3.5 p-6">
            {liveItems.map((item, i) =>
              item.kind === 'message' ? (
                <Message key={i} role={item.role!} content={item.content} />
              ) : item.step ? (
                <StepEvent key={`step-${i}`} step={item.step} />
              ) : null
            )}
          </div>
        </ScrollArea>
        <ArtifactSidebar convId={convId} />
      </div>
      <Composer onSend={handleSend} disabled={streaming} />
    </div>
  )
}
```

- [ ] **Step 6: Commit**

```bash
git add web-ui/src/components/chat/
git commit -m "feat: add chat view components"
```

---

## Task 7: 创建工作台视图 - 知识库、知识图谱、产物面板

**Files:**
- Create: `web-ui/src/components/workbench/workbench-view.tsx`
- Create: `web-ui/src/components/workbench/kb-panel.tsx`
- Create: `web-ui/src/components/workbench/kg-panel.tsx`
- Create: `web-ui/src/components/workbench/artifacts-panel.tsx`

- [ ] **Step 1: 创建 `workbench-view.tsx`**

工作台容器，使用 shadcn Tabs 组件切换面板。

```tsx
// web-ui/src/components/workbench/workbench-view.tsx
import { useState } from 'react'
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

const tabGroups = [
  {
    label: '资源',
    tabs: [
      { value: 'kb', label: '📚 知识库' },
      { value: 'kg', label: '🧠 知识图谱' },
      { value: 'artifacts', label: '📦 产物' },
    ],
  },
  {
    label: '智能',
    tabs: [
      { value: 'agents', label: '🤖 智能体' },
      { value: 'skills', label: '🧩 技能' },
      { value: 'prompts', label: '📝 提示词' },
    ],
  },
  {
    label: '数据',
    tabs: [
      { value: 'dbs', label: '🗄️ 数据源' },
      { value: 'mcp', label: '🔌 MCP' },
    ],
  },
  {
    label: '治理',
    tabs: [
      { value: 'ops', label: '🔧 运维' },
      { value: 'gov', label: '📊 治理' },
      { value: 'security', label: '🛡️ 安全' },
    ],
  },
]

const allTabs = tabGroups.flatMap(g => g.tabs)

export function WorkbenchView() {
  const [activeTab, setActiveTab] = useState('kb')

  const renderPanel = () => {
    switch (activeTab) {
      case 'kb': return <KBPanel />
      case 'kg': return <KGPanel />
      case 'artifacts': return <ArtifactsPanel />
      case 'agents': return <AgentsPanel />
      case 'skills': return <SkillsPanel />
      case 'prompts': return <PromptsPanel />
      case 'dbs': return <DatasourcesPanel />
      case 'mcp': return <MCPPanel />
      case 'ops': return <OpsPanel />
      case 'gov': return <GovPanel />
      case 'security': return <SecurityPanel />
      default: return null
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {/* Tab bar */}
      <div className="sticky top-0 z-5 flex items-center gap-0.5 mb-5 p-2 bg-[#10141e]/95 border border-[#2f2f38] rounded-[14px] overflow-x-auto">
        {tabGroups.map((group, gi) => (
          <div key={group.label} className={`flex items-center gap-0.5 shrink-0 ${gi > 0 ? 'border-l border-[#3a3a45] ml-2 pl-2' : ''}`}>
            <span className="text-[10px] tracking-wider text-[#9a9aa4] px-2 opacity-70 select-none">{group.label}</span>
            {group.tabs.map(tab => (
              <button
                key={tab.value}
                className={`px-3 py-1.5 text-[13px] rounded-lg whitespace-nowrap transition-all ${
                  activeTab === tab.value
                    ? 'text-white bg-gradient-to-br from-[#5b7cfa] to-[#2b6cb0] border border-white/20 shadow-[0_2px_10px_rgba(56,122,214,0.35)]'
                    : 'text-[#9a9aa4] hover:text-white hover:bg-[#26262d]'
                }`}
                onClick={() => setActiveTab(tab.value)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* Active panel */}
      {renderPanel()}
    </div>
  )
}
```

- [ ] **Step 2: 创建 `kb-panel.tsx`**

```tsx
// web-ui/src/components/workbench/kb-panel.tsx
import { useState, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { api } from '@/lib/api'
import type { KBDocument } from '@/lib/types'

export function KBPanel() {
  const [docs, setDocs] = useState<KBDocument[]>([])
  const [searchQ, setSearchQ] = useState('')
  const [searchResult, setSearchResult] = useState<unknown[]>([])
  const [rebuilding, setRebuilding] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = async () => {
    const r = await api.listDocuments()
    if (r.success) setDocs((r.data as KBDocument[]) || [])
  }

  useEffect(() => { load() }, [])

  const handleUpload = async () => {
    const file = fileRef.current?.files?.[0]
    if (!file) return
    const r = await api.uploadDocument(file)
    if (r.success) { fileRef.current.value = ''; load() }
    else alert('上传失败: ' + (r.detail || '未知错误'))
  }

  const handleDelete = async (id: number) => {
    if (!confirm('删除该文档？')) return
    await api.deleteDocument(id)
    load()
  }

  const handleSearch = async () => {
    if (!searchQ.trim()) return
    const r = await api.searchKB(searchQ.trim())
    setSearchResult((r.data as unknown[]) || [])
  }

  const handleRebuild = async () => {
    setRebuilding(true)
    const r = await api.rebuildKG()
    setRebuilding(false)
    if (r.success) alert(`图谱重建完成：${(r.data as { entities: number }).entities} 实体 / ${(r.data as { relations: number }).relations} 关系`)
    else alert('重建失败')
  }

  return (
    <div className="space-y-4">
      <Card className="bg-[#1d1d22] border-[#2f2f38] p-4 rounded-xl">
        <h3 className="text-sm font-semibold mb-3">上传知识文档（md / sql / txt / pdf，≤5MB）</h3>
        <div className="flex gap-2.5 items-center flex-wrap">
          <input type="file" ref={fileRef} accept=".md,.sql,.txt,.pdf" className="text-sm text-[#e8e8ec]" />
          <Button size="sm" className="bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" onClick={handleUpload}>上传并向量化</Button>
          <Button size="sm" variant="outline" className="ml-auto" onClick={handleRebuild} disabled={rebuilding}>
            {rebuilding ? '🔄 重建中…' : '🧠 重建知识图谱'}
          </Button>
        </div>
      </Card>

      <Card className="bg-[#1d1d22] border-[#2f2f38] p-4 rounded-xl">
        <h3 className="text-sm font-semibold mb-3">检索测试</h3>
        <div className="flex gap-2">
          <Input className="flex-1 bg-[#26262d] border-[#3a3a45]" placeholder="输入问题检索知识库" value={searchQ} onChange={e => setSearchQ(e.target.value)} />
          <Button size="sm" variant="outline" onClick={handleSearch}>检索</Button>
        </div>
        {searchResult.length > 0 && (
          <div className="mt-3 space-y-2">
            {(searchResult as Array<{ doc_name: string; chunk_index: number; score: number; content: string }>).map((hit, i) => (
              <div key={i} className="p-2.5 bg-[#26262d] rounded-lg border border-[#2f2f38] text-xs">
                <div className="flex justify-between mb-1">
                  <b>{hit.doc_name}#{hit.chunk_index}</b>
                  <Badge variant="secondary">score {hit.score}</Badge>
                </div>
                <p className="text-[#9a9aa4]">{hit.content?.slice(0, 200)}</p>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="bg-[#1d1d22] border-[#2f2f38] p-4 rounded-xl">
        <h3 className="text-sm font-semibold mb-3">文档列表</h3>
        {docs.length === 0 ? (
          <div className="text-xs text-[#9a9aa4] p-2.5 text-center border border-dashed border-[#3a3a45] rounded-lg">暂无文档，请上传知识文档</div>
        ) : (
          <table className="w-full text-[13px]">
            <thead><tr className="text-[#9a9aa4]"><th className="text-left p-2">ID</th><th className="text-left p-2">名称</th><th className="text-left p-2">类型</th><th className="text-left p-2">分块</th><th className="text-left p-2">操作</th></tr></thead>
            <tbody>
              {docs.map(d => (
                <tr key={d.id} className="hover:bg-[#26262d] transition-colors">
                  <td className="p-2">{d.id}</td>
                  <td className="p-2">{d.name}</td>
                  <td className="p-2"><Badge variant="outline">{d.source_type}</Badge></td>
                  <td className="p-2">{d.chunk_count}</td>
                  <td className="p-2"><Button size="sm" variant="ghost" className="text-[#f56c6c] hover:text-[#f56c6c] hover:bg-[#f56c6c1a]" onClick={() => handleDelete(d.id)}>删除</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}
```

- [ ] **Step 3: 创建 `kg-panel.tsx`**

```tsx
// web-ui/src/components/workbench/kg-panel.tsx
import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { api } from '@/lib/api'
import type { KGOverview, KBTriple } from '@/lib/types'

export function KGPanel() {
  const [overview, setOverview] = useState<KGOverview | null>(null)
  const [query, setQuery] = useState('')
  const [triples, setTriples] = useState<KBTriple[]>([])
  const [terms, setTerms] = useState<string[]>([])
  const [rebuilding, setRebuilding] = useState(false)

  const load = async () => {
    const r = await api.kgOverview()
    if (r.success) setOverview(r.data as KGOverview)
  }

  useEffect(() => { load() }, [])

  const handleRebuild = async () => {
    setRebuilding(true)
    const r = await api.rebuildKG()
    setRebuilding(false)
    if (r.success) { load(); alert('图谱重建完成') }
    else alert('重建失败')
  }

  const handleSearch = async () => {
    if (!query.trim()) return
    const r = await api.kgExpand(query.trim())
    if (r.success && r.data) {
      setTerms(r.data.terms || [])
      setTriples(r.data.triples || [])
    }
  }

  return (
    <div className="space-y-4">
      <Card className="bg-[#1d1d22] border-[#2f2f38] p-4 rounded-xl">
        <h3 className="text-sm font-semibold mb-3">知识图谱概览</h3>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-3 mb-4">
          <div className="bg-[#26262d] border border-[#2f2f38] rounded-xl p-4 text-center">
            <div className="text-2xl font-bold text-white">{overview?.entities ?? '—'}</div>
            <div className="text-xs text-[#9a9aa4] mt-1">实体</div>
          </div>
          <div className="bg-[#26262d] border border-[#2f2f38] rounded-xl p-4 text-center">
            <div className="text-2xl font-bold text-white">{overview?.relations ?? '—'}</div>
            <div className="text-xs text-[#9a9aa4] mt-1">关系</div>
          </div>
        </div>
        <Button size="sm" className="bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" onClick={handleRebuild} disabled={rebuilding}>
          {rebuilding ? '🔄 重建中…' : '🔄 从知识库重建'}
        </Button>
      </Card>

      <Card className="bg-[#1d1d22] border-[#2f2f38] p-4 rounded-xl">
        <h3 className="text-sm font-semibold mb-3">图谱扩展查询</h3>
        <div className="flex gap-2 mb-3">
          <Input className="flex-1 bg-[#26262d] border-[#3a3a45]" placeholder="输入实体或问题（如：达梦 兼容）" value={query} onChange={e => setQuery(e.target.value)} />
          <Button size="sm" variant="outline" onClick={handleSearch}>查询关联</Button>
        </div>
        {terms.length > 0 && (
          <div className="flex gap-1 flex-wrap mb-2">
            {terms.map(t => <Badge key={t} variant="outline">{t}</Badge>)}
          </div>
        )}
        {triples.length > 0 ? (
          <table className="w-full text-xs">
            <thead><tr className="text-[#9a9aa4]"><th className="text-left p-2">主体</th><th className="text-left p-2">关系</th><th className="text-left p-2">客体</th><th className="text-left p-2">来源</th></tr></thead>
            <tbody>
              {triples.map((t, i) => (
                <tr key={i} className="hover:bg-[#26262d]"><td className="p-2">{t.subject}</td><td className="p-2"><Badge variant="outline">{t.relation}</Badge></td><td className="p-2">{t.object}</td><td className="p-2 text-[#9a9aa4]">{t.doc || ''}</td></tr>
              ))}
            </tbody>
          </table>
        ) : terms.length === 0 ? null : (
          <div className="text-xs text-[#9a9aa4] p-2.5 text-center border border-dashed border-[#3a3a45] rounded-lg">暂无关联关系</div>
        )}
      </Card>

      {overview?.top_relations && overview.top_relations.length > 0 && (
        <Card className="bg-[#1d1d22] border-[#2f2f38] p-4 rounded-xl">
          <h3 className="text-sm font-semibold mb-3">高频关系</h3>
          <table className="w-full text-xs">
            <thead><tr className="text-[#9a9aa4]"><th className="text-left p-2">关系</th><th className="text-left p-2">次数</th></tr></thead>
            <tbody>
              {overview.top_relations.map((r, i) => (
                <tr key={i} className="hover:bg-[#26262d]"><td className="p-2">{r.relation}</td><td className="p-2">{r.count}</td></tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}
```

- [ ] **Step 4: 创建 `artifacts-panel.tsx`**

```tsx
// web-ui/src/components/workbench/artifacts-panel.tsx
import { useState, useEffect } from 'react'
import { Card } from '@/components/ui/card'
import { api } from '@/lib/api'

export function ArtifactsPanel() {
  const [namespaces, setNamespaces] = useState<string[]>([])

  useEffect(() => {
    api.listArtifacts().then(r => {
      if (r.success) setNamespaces((r.data as string[]) || [])
    })
  }, [])

  return (
    <Card className="bg-[#1d1d22] border-[#2f2f38] p-4 rounded-xl">
      <h3 className="text-sm font-semibold mb-3">产物（按 namespace）</h3>
      {namespaces.length === 0 ? (
        <div className="text-xs text-[#9a9aa4] p-2.5 text-center border border-dashed border-[#3a3a45] rounded-lg">暂无产物</div>
      ) : (
        namespaces.map(ns => (
          <div key={ns} className="font-mono text-xs py-1 text-[#cdd3e0]">📁 {ns}</div>
        ))
      )}
    </Card>
  )
}
```

- [ ] **Step 5: Commit**

```bash
git add web-ui/src/components/workbench/
git commit -m "feat: add workbench view with KB, KG, and artifacts panels"
```

---

## Task 8: 创建工作台视图 - 智能体、技能、提示词面板

**Files:**
- Create: `web-ui/src/components/workbench/agents-panel.tsx`
- Create: `web-ui/src/components/workbench/skills-panel.tsx`
- Create: `web-ui/src/components/workbench/prompts-panel.tsx`

- [ ] **Step 1: 创建 `agents-panel.tsx`**

```tsx
// web-ui/src/components/workbench/agents-panel.tsx
import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { api } from '@/lib/api'
import type { Agent } from '@/lib/types'

export function AgentsPanel() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [form, setForm] = useState({ agent_id: '', name: '', intent: '', description: '', default_prompt: '', gen_artifact: false, enabled: true })

  const load = async () => {
    const r = await api.listAgents()
    if (r.success) setAgents((r.data as Agent[]) || [])
  }
  useEffect(() => { load() }, [])

  const handleCreate = async () => {
    const r = await api.createAgent(form)
    if (r.success) {
      setForm({ agent_id: '', name: '', intent: '', description: '', default_prompt: '', gen_artifact: false, enabled: true })
      load()
    } else alert('保存失败: ' + (r.detail || ''))
  }

  const handleToggle = async (aid: string, enabled: boolean) => {
    await api.toggleAgent(aid, enabled); load()
  }

  const handleDelete = async (aid: string) => {
    if (!confirm(`删除智能体 ${aid}？`)) return
    await api.deleteAgent(aid); load()
  }

  return (
    <div className="space-y-4">
      <Card className="bg-[#1d1d22] border-[#2f2f38] p-4 rounded-xl">
        <h3 className="text-sm font-semibold mb-3">新建/更新智能体</h3>
        <div className="flex gap-2 flex-wrap">
          <Input className="w-36 bg-[#26262d] border-[#3a3a45]" placeholder="agent_id" value={form.agent_id} onChange={e => setForm({ ...form, agent_id: e.target.value })} />
          <Input className="w-36 bg-[#26262d] border-[#3a3a45]" placeholder="名称" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          <Input className="w-36 bg-[#26262d] border-[#3a3a45]" placeholder="intent" value={form.intent} onChange={e => setForm({ ...form, intent: e.target.value })} />
        </div>
        <Input className="w-full mt-2 bg-[#26262d] border-[#3a3a45]" placeholder="描述" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
        <div className="flex gap-3 mt-2 text-xs text-[#9a9aa4]">
          <label className="cursor-pointer"><input type="checkbox" checked={form.gen_artifact} onChange={e => setForm({ ...form, gen_artifact: e.target.checked })} className="mr-1" /> 产生产物</label>
          <label className="cursor-pointer"><input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} className="mr-1" /> 启用</label>
        </div>
        <Textarea className="mt-2 bg-[#26262d] border-[#3a3a45] font-mono text-xs min-h-[110px]" placeholder="系统提示词" value={form.default_prompt} onChange={e => setForm({ ...form, default_prompt: e.target.value })} />
        <Button size="sm" className="mt-2 bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" onClick={handleCreate}>保存</Button>
      </Card>

      <Card className="bg-[#1d1d22] border-[#2f2f38] p-4 rounded-xl">
        <h3 className="text-sm font-semibold mb-3">智能体列表</h3>
        <table className="w-full text-[13px]">
          <thead><tr className="text-[#9a9aa4]"><th className="text-left p-2">ID</th><th className="text-left p-2">名称</th><th className="text-left p-2">intent</th><th className="text-left p-2">产物</th><th className="text-left p-2">状态</th><th className="text-left p-2">操作</th></tr></thead>
          <tbody>
            {agents.map(a => (
              <tr key={a.id} className="hover:bg-[#26262d]">
                <td className="p-2">{a.id}</td>
                <td className="p-2">{a.name}</td>
                <td className="p-2"><Badge variant="outline">{a.intent || '—'}</Badge></td>
                <td className="p-2">{a.gen_artifact ? '📄' : '—'}</td>
                <td className="p-2"><Badge className={a.enabled ? 'bg-[#3ddc9726] text-[#3ddc97] border-[#3ddc9759]' : ''}>{a.enabled ? '启用' : '停用'}</Badge></td>
                <td className="p-2 flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => handleToggle(a.id, !a.enabled)}>{a.enabled ? '停用' : '启用'}</Button>
                  {!a.builtin && <Button size="sm" variant="ghost" className="text-[#f56c6c]" onClick={() => handleDelete(a.id)}>删除</Button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
```

- [ ] **Step 2: 创建 `skills-panel.tsx`**

```tsx
// web-ui/src/components/workbench/skills-panel.tsx
import { useState, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { api } from '@/lib/api'
import type { Skill } from '@/lib/types'

export function SkillsPanel() {
  const [skills, setSkills] = useState<Skill[]>([])
  const [skillText, setSkillText] = useState('')
  const [runResult, setRunResult] = useState<string | null>(null)
  const [editing, setEditing] = useState<Skill | null>(null)
  const scriptRef = useRef<HTMLInputElement>(null)

  const load = async () => {
    const r = await api.listSkills()
    if (r.success) setSkills((r.data as Skill[]) || [])
  }
  useEffect(() => { load() }, [])

  const handleCreate = async () => {
    if (!skillText.trim()) { alert('请粘贴 SKILL.md 文本'); return }
    const r = await api.createSkill(skillText)
    if (!r.success) { alert('创建失败: ' + (r.detail || '')); return }
    const sid = (r.data as Skill)?.skill_id
    const file = scriptRef.current?.files?.[0]
    if (file && sid) {
      await api.uploadSkillScript(sid, file)
      scriptRef.current.value = ''
    }
    setSkillText(''); load()
  }

  const handleRun = async (sid: string) => {
    setRunResult('⏳ 执行中…')
    const r = await api.runSkill(sid)
    if (r.success) setRunResult(JSON.stringify(r.data, null, 2))
    else setRunResult('运行失败: ' + (r.detail || ''))
  }

  const handleSaveEdit = async () => {
    if (!editing) return
    const r = await api.updateSkill(editing.skill_id, { name: editing.name, description: editing.description || '', content: editing.content || '' })
    if (r.success) { setEditing(null); load() }
    else alert('保存失败')
  }

  return (
    <div className="space-y-4">
      <Card className="bg-[#1d1d22] border-[#2f2f38] p-4 rounded-xl">
        <h3 className="text-sm font-semibold mb-3">新建技能</h3>
        <Textarea className="bg-[#26262d] border-[#3a3a45] font-mono text-xs min-h-[200px]" placeholder='---\nname: 换算\ndescription: 执行脚本换算\nscript: calc.py\n---' value={skillText} onChange={e => setSkillText(e.target.value)} />
        <div className="flex gap-2.5 mt-2 items-center">
          <input type="file" ref={scriptRef} accept=".py,.sh,.bash" className="text-sm text-[#e8e8ec]" />
          <Button size="sm" className="bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" onClick={handleCreate}>创建</Button>
        </div>
      </Card>

      <Card className="bg-[#1d1d22] border-[#2f2f38] p-4 rounded-xl">
        <h3 className="text-sm font-semibold mb-3">技能列表</h3>
        <table className="w-full text-[13px]">
          <thead><tr className="text-[#9a9aa4]"><th className="text-left p-2">ID</th><th className="text-left p-2">名称</th><th className="text-left p-2">描述</th><th className="text-left p-2">脚本/链</th><th className="text-left p-2">状态</th><th className="text-left p-2">操作</th></tr></thead>
          <tbody>
            {skills.map(s => (
              <tr key={s.skill_id} className="hover:bg-[#26262d]">
                <td className="p-2">{s.skill_id}</td>
                <td className="p-2">{s.name}</td>
                <td className="p-2 text-xs text-[#9a9aa4]">{s.description || ''}</td>
                <td className="p-2">
                  {s.chain && s.chain.length > 0
                    ? <Badge variant="outline" className="text-[#5b9cf5]">🔗 {s.chain.join(' → ')}</Badge>
                    : s.script ? <Badge variant="outline">{s.script}</Badge> : '—'}
                </td>
                <td className="p-2"><Badge className={s.enabled ? 'bg-[#3ddc9726] text-[#3ddc97] border-[#3ddc9759]' : ''}>{s.enabled ? '启用' : '停用'}</Badge></td>
                <td className="p-2 flex gap-1 flex-wrap">
                  <Button size="sm" variant="ghost" onClick={() => api.toggleSkill(s.skill_id, !s.enabled).then(load)}>{s.enabled ? '停用' : '启用'}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>编辑</Button>
                  <Button size="sm" variant="ghost" onClick={() => handleRun(s.skill_id)}>运行</Button>
                  <Button size="sm" variant="ghost" className="text-[#f56c6c]" onClick={() => { if (confirm('删除技能 ' + s.skill_id + '？')) api.deleteSkill(s.skill_id).then(load) }}>删除</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {runResult && <pre className="mt-3 text-xs text-[#cdd3e0] bg-[#0f0f14] border border-[#2f2f38] rounded-lg p-3 max-h-80 overflow-auto whitespace-pre-wrap">{runResult}</pre>}
      </Card>

      {/* Edit dialog */}
      {editing && (
        <div className="fixed inset-0 bg-black/65 flex items-center justify-center z-50 backdrop-blur-sm" onClick={() => setEditing(null)}>
          <div className="bg-[#1d1d22] border border-[#3a3a45] rounded-[14px] w-[760px] max-h-[88vh] p-5 overflow-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-[15px] mb-4">编辑技能：{editing.skill_id}</h3>
            <div className="space-y-3">
              <div><label className="text-xs text-[#9a9aa4]">名称</label><Input className="bg-[#26262d] border-[#3a3a45]" value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} /></div>
              <div><label className="text-xs text-[#9a9aa4]">描述</label><Input className="bg-[#26262d] border-[#3a3a45]" value={editing.description || ''} onChange={e => setEditing({ ...editing, description: e.target.value })} /></div>
              <div><label className="text-xs text-[#9a9aa4]">SKILL.md 正文</label><Textarea className="bg-[#26262d] border-[#3a3a45] font-mono text-xs min-h-[220px]" value={editing.content || ''} onChange={e => setEditing({ ...editing, content: e.target.value })} /></div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <Button variant="outline" onClick={() => setEditing(null)}>取消</Button>
              <Button className="bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" onClick={handleSaveEdit}>保存</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: 创建 `prompts-panel.tsx`**

```tsx
// web-ui/src/components/workbench/prompts-panel.tsx
import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/api'
import type { Prompt } from '@/lib/types'

export function PromptsPanel() {
  const [prompts, setPrompts] = useState<Prompt[]>([])
  const [name, setName] = useState('')
  const [category, setCategory] = useState('agent')
  const [content, setContent] = useState('')

  const load = async () => {
    const r = await api.listPrompts()
    if (r.success) setPrompts((r.data as Prompt[]) || [])
  }
  useEffect(() => { load() }, [])

  const handleCreate = async () => {
    const r = await api.createPrompt({ name, category, content })
    if (r.success) { setName(''); setContent(''); load() }
    else alert('保存失败: ' + (r.detail || ''))
  }

  return (
    <div className="space-y-4">
      <Card className="bg-[#1d1d22] border-[#2f2f38] p-4 rounded-xl">
        <h3 className="text-sm font-semibold mb-3">新增提示词</h3>
        <div className="flex gap-2 flex-wrap">
          <Input className="flex-1 min-w-[200px] bg-[#26262d] border-[#3a3a45]" placeholder="名称（agent 名称如 ddl_converter）" value={name} onChange={e => setName(e.target.value)} />
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="w-32 bg-[#26262d] border-[#3a3a45]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="agent">agent</SelectItem>
              <SelectItem value="router">router</SelectItem>
              <SelectItem value="system">system</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Textarea className="mt-2 bg-[#26262d] border-[#3a3a45] font-mono text-xs" placeholder="提示词内容" value={content} onChange={e => setContent(e.target.value)} />
        <Button size="sm" className="mt-2 bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" onClick={handleCreate}>保存</Button>
      </Card>

      <Card className="bg-[#1d1d22] border-[#2f2f38] p-4 rounded-xl">
        <h3 className="text-sm font-semibold mb-3">提示词列表</h3>
        <table className="w-full text-[13px]">
          <thead><tr className="text-[#9a9aa4]"><th className="text-left p-2">ID</th><th className="text-left p-2">名称</th><th className="text-left p-2">分类</th><th className="text-left p-2">启用</th><th className="text-left p-2">操作</th></tr></thead>
          <tbody>
            {prompts.map(p => (
              <tr key={p.id} className="hover:bg-[#26262d]">
                <td className="p-2">{p.id}</td>
                <td className="p-2">{p.name}</td>
                <td className="p-2"><Badge variant="outline">{p.category}</Badge></td>
                <td className="p-2"><Badge className={p.enabled ? 'bg-[#3ddc9726] text-[#3ddc97] border-[#3ddc9759]' : ''}>{p.enabled ? '启用' : '停用'}</Badge></td>
                <td className="p-2 flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => api.updatePrompt(p.id, { enabled: !p.enabled }).then(load)}>切换</Button>
                  <Button size="sm" variant="ghost" className="text-[#f56c6c]" onClick={() => { if (confirm('删除该提示词？')) api.deletePrompt(p.id).then(load) }}>删除</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
```

- [ ] **Step 4: Commit**

```bash
git add web-ui/src/components/workbench/
git commit -m "feat: add agents, skills, prompts panels"
```

---

## Task 9: 创建工作台视图 - 数据源、MCP、运维、治理、安全面板

**Files:**
- Create: `web-ui/src/components/workbench/datasources-panel.tsx`
- Create: `web-ui/src/components/workbench/mcp-panel.tsx`
- Create: `web-ui/src/components/workbench/ops-panel.tsx`
- Create: `web-ui/src/components/workbench/gov-panel.tsx`
- Create: `web-ui/src/components/workbench/security-panel.tsx`

- [ ] **Step 1: 创建 `datasources-panel.tsx`**

```tsx
// web-ui/src/components/workbench/datasources-panel.tsx
import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/api'
import type { Datasource } from '@/lib/types'

export function DatasourcesPanel() {
  const [datasources, setDatasources] = useState<Datasource[]>([])
  const [form, setForm] = useState({ name: '', kind: 'sqlite', location: '', username: '', password: '', dsn: '' })
  const [probeResult, setProbeResult] = useState<string | null>(null)
  const [queryDs, setQueryDs] = useState('')
  const [sql, setSql] = useState('')
  const [queryResult, setQueryResult] = useState<string | null>(null)

  const load = async () => {
    const r = await api.listDatasources()
    if (r.success) {
      const ds = (r.data as Datasource[]) || []
      setDatasources(ds)
      if (ds.length && !queryDs) setQueryDs(ds[0].name)
    }
  }
  useEffect(() => { load() }, [])

  const handleCreate = async () => {
    const r = await api.createDatasource(form)
    if (r.success) {
      setForm({ name: '', kind: 'sqlite', location: '', username: '', password: '', dsn: '' })
      load()
    } else alert('保存失败: ' + (r.detail || ''))
  }

  const handleProbe = async (name: string) => {
    setProbeResult('⏳ 探测中…')
    const r = await api.testDatasource(name)
    setProbeResult(r.success ? JSON.stringify(r.data, null, 2) : '探测失败: ' + (r.detail || ''))
  }

  const handleQuery = async () => {
    if (!queryDs || !sql.trim()) return
    setQueryResult('⏳ 执行中…')
    const r = await api.queryDatasource(queryDs, sql.trim())
    if (!r.success || !r.data) { setQueryResult('❌ ' + (r.detail || '查询被拒绝')); return }
    setQueryResult(JSON.stringify(r.data, null, 2))
  }

  return (
    <div className="space-y-4">
      <Card className="bg-[#1d1d22] border-[#2f2f38] p-4 rounded-xl">
        <h3 className="text-sm font-semibold mb-3">新增数据源</h3>
        <div className="flex gap-2 flex-wrap">
          <Input className="w-36 bg-[#26262d] border-[#3a3a45]" placeholder="名称" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          <Select value={form.kind} onValueChange={v => setForm({ ...form, kind: v })}>
            <SelectTrigger className="w-32 bg-[#26262d] border-[#3a3a45]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {['sqlite', 'mysql', 'postgresql', 'oracle', 'dm', 'kingbase', 'gaussdb'].map(k => <SelectItem key={k} value={k}>{k}</SelectItem>)}
            </SelectContent>
          </Select>
          <Input className="flex-1 min-w-[220px] bg-[#26262d] border-[#3a3a45]" placeholder="sqlite路径 或 host:port/db" value={form.location} onChange={e => setForm({ ...form, location: e.target.value })} />
        </div>
        <div className="flex gap-2 mt-2 flex-wrap">
          <Input className="w-30 bg-[#26262d] border-[#3a3a45]" placeholder="用户名" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} />
          <Input className="w-30 bg-[#26262d] border-[#3a3a45]" type="password" placeholder="密码" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} />
          <Input className="flex-1 min-w-[220px] bg-[#26262d] border-[#3a3a45]" placeholder="可选完整连接串" value={form.dsn} onChange={e => setForm({ ...form, dsn: e.target.value })} />
        </div>
        <Button size="sm" className="mt-2 bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" onClick={handleCreate}>保存</Button>
      </Card>

      <Card className="bg-[#1d1d22] border-[#2f2f38] p-4 rounded-xl">
        <h3 className="text-sm font-semibold mb-3">数据源列表</h3>
        {datasources.length === 0 ? (
          <div className="text-xs text-[#9a9aa4] p-2.5 text-center border border-dashed border-[#3a3a45] rounded-lg">暂无数据源</div>
        ) : (
          <table className="w-full text-[13px]">
            <thead><tr className="text-[#9a9aa4]"><th className="text-left p-2">名称</th><th className="text-left p-2">类型</th><th className="text-left p-2">位置</th><th className="text-left p-2">状态</th><th className="text-left p-2">操作</th></tr></thead>
            <tbody>
              {datasources.map(d => (
                <tr key={d.name} className="hover:bg-[#26262d]">
                  <td className="p-2">{d.name}</td>
                  <td className="p-2"><Badge variant="outline">{d.kind}</Badge></td>
                  <td className="p-2 text-xs">{d.location || '—'}</td>
                  <td className="p-2"><Badge className={d.enabled ? 'bg-[#3ddc9726] text-[#3ddc97] border-[#3ddc9759]' : ''}>{d.enabled ? '启用' : '停用'}</Badge></td>
                  <td className="p-2 flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => api.toggleDatasource(d.name, !d.enabled).then(load)}>{d.enabled ? '停用' : '启用'}</Button>
                    <Button size="sm" variant="ghost" onClick={() => handleProbe(d.name)}>探测</Button>
                    <Button size="sm" variant="ghost" className="text-[#f56c6c]" onClick={() => { if (confirm('删除数据源 ' + d.name + '？')) api.deleteDatasource(d.name).then(load) }}>删除</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {probeResult && <pre className="mt-3 text-xs text-[#cdd3e0] bg-[#0f0f14] border border-[#2f2f38] rounded-lg p-3 max-h-80 overflow-auto whitespace-pre-wrap">{probeResult}</pre>}
      </Card>

      <Card className="bg-[#1d1d22] border-[#2f2f38] p-4 rounded-xl">
        <h3 className="text-sm font-semibold mb-3">SQL 只读查询</h3>
        <div className="text-xs text-[#9a9aa4] mb-2">仅允许 SELECT / WITH 只读语句；写操作会被拒绝</div>
        <div className="flex gap-2">
          <Select value={queryDs} onValueChange={setQueryDs}>
            <SelectTrigger className="w-40 bg-[#26262d] border-[#3a3a45]"><SelectValue /></SelectTrigger>
            <SelectContent>{datasources.map(d => <SelectItem key={d.name} value={d.name}>{d.name}</SelectItem>)}</SelectContent>
          </Select>
          <Input className="flex-1 bg-[#26262d] border-[#3a3a45]" placeholder="SELECT * FROM table LIMIT 50" value={sql} onChange={e => setSql(e.target.value)} />
          <Button size="sm" className="bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" onClick={handleQuery}>执行查询</Button>
        </div>
        {queryResult && <pre className="mt-3 text-xs text-[#cdd3e0] bg-[#0f0f14] border border-[#2f2f38] rounded-lg p-3 max-h-80 overflow-auto whitespace-pre-wrap">{queryResult}</pre>}
      </Card>
    </div>
  )
}
```

- [ ] **Step 2: 创建 `mcp-panel.tsx`**

```tsx
// web-ui/src/components/workbench/mcp-panel.tsx
import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/api'
import type { MCPServer } from '@/lib/types'

export function MCPPanel() {
  const [servers, setServers] = useState<MCPServer[]>([])
  const [name, setName] = useState('')
  const [kind, setKind] = useState('http')
  const [url, setUrl] = useState('')
  const [testResult, setTestResult] = useState<string | null>(null)

  const load = async () => {
    const r = await api.listMCPServers()
    if (r.success) setServers((r.data as MCPServer[]) || [])
  }
  useEffect(() => { load() }, [])

  const handleCreate = async () => {
    const r = await api.createMCPServer({ name, kind, command_or_url: url })
    if (r.success) { setName(''); setUrl(''); load() }
    else alert('保存失败: ' + (r.detail || ''))
  }

  const handleTest = async (id: number) => {
    setTestResult('⏳ 测试中…')
    const r = await api.testMCPServer(id)
    setTestResult(r.success ? '✅ ' + ((r.data as { message: string })?.message || '可达') : '❌ ' + (r.detail || ''))
  }

  return (
    <div className="space-y-4">
      <Card className="bg-[#1d1d22] border-[#2f2f38] p-4 rounded-xl">
        <h3 className="text-sm font-semibold mb-3">新增 MCP server</h3>
        <div className="flex gap-2 flex-wrap">
          <Input className="w-44 bg-[#26262d] border-[#3a3a45]" placeholder="名称" value={name} onChange={e => setName(e.target.value)} />
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger className="w-28 bg-[#26262d] border-[#3a3a45]"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="http">http</SelectItem><SelectItem value="stdio">stdio</SelectItem></SelectContent>
          </Select>
          <Input className="flex-1 min-w-[220px] bg-[#26262d] border-[#3a3a45]" placeholder="URL 或命令" value={url} onChange={e => setUrl(e.target.value)} />
        </div>
        <Button size="sm" className="mt-2 bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" onClick={handleCreate}>保存</Button>
      </Card>

      <Card className="bg-[#1d1d22] border-[#2f2f38] p-4 rounded-xl">
        <h3 className="text-sm font-semibold mb-3">MCP server 列表</h3>
        {servers.length === 0 ? (
          <div className="text-xs text-[#9a9aa4] p-2.5 text-center border border-dashed border-[#3a3a45] rounded-lg">暂无 MCP server</div>
        ) : (
          <table className="w-full text-[13px]">
            <thead><tr className="text-[#9a9aa4]"><th className="text-left p-2">ID</th><th className="text-left p-2">名称</th><th className="text-left p-2">类型</th><th className="text-left p-2">地址</th><th className="text-left p-2">状态</th><th className="text-left p-2">操作</th></tr></thead>
            <tbody>
              {servers.map(m => (
                <tr key={m.id} className="hover:bg-[#26262d]">
                  <td className="p-2">{m.id}</td><td className="p-2">{m.name}</td>
                  <td className="p-2"><Badge variant="outline">{m.kind}</Badge></td>
                  <td className="p-2 font-mono text-xs">{m.command_or_url}</td>
                  <td className="p-2"><Badge className={m.enabled ? 'bg-[#3ddc9726] text-[#3ddc97] border-[#3ddc9759]' : ''}>{m.enabled ? '启用' : '停用'}</Badge></td>
                  <td className="p-2"><Button size="sm" variant="ghost" onClick={() => handleTest(m.id)}>测试连通</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {testResult && <pre className="mt-3 text-xs text-[#cdd3e0] bg-[#0f0f14] border border-[#2f2f38] rounded-lg p-3 whitespace-pre-wrap">{testResult}</pre>}
      </Card>
    </div>
  )
}
```

- [ ] **Step 3: 创建 `ops-panel.tsx`**

```tsx
// web-ui/src/components/workbench/ops-panel.tsx
import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { api } from '@/lib/api'
import type { OpsHealthRecord } from '@/lib/types'

export function OpsPanel() {
  const [history, setHistory] = useState<OpsHealthRecord[]>([])
  const [dsFilter, setDsFilter] = useState('')
  const [checking, setChecking] = useState(false)
  const [baseline, setBaseline] = useState<string | null>(null)

  const load = async () => {
    const r = await api.opsHealthHistory()
    if (r.success) setHistory((r.data as OpsHealthRecord[]) || [])
  }
  useEffect(() => { load() }, [])

  const handleCheck = async () => {
    setChecking(true)
    const r = await api.opsHealthCheck(dsFilter || undefined)
    setChecking(false)
    load()
  }

  const handleBaseline = async () => {
    setBaseline('⏳ 计算中…')
    const r = await api.opsBaseline()
    setBaseline(r.success ? JSON.stringify(r.data, null, 2) : '❌ ' + (r.detail || ''))
  }

  return (
    <div className="space-y-4">
      <Card className="bg-[#1d1d22] border-[#2f2f38] p-4 rounded-xl">
        <h3 className="text-sm font-semibold mb-3">健康巡检</h3>
        <div className="flex gap-2 items-center flex-wrap">
          <Input className="w-48 bg-[#26262d] border-[#3a3a45]" placeholder="数据源名（留空=全部）" value={dsFilter} onChange={e => setDsFilter(e.target.value)} />
          <Button size="sm" className="bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" disabled={checking} onClick={handleCheck}>
            {checking ? '⏳ 巡检中…' : '🚑 开始巡检'}
          </Button>
        </div>
        <table className="w-full text-[13px] mt-3">
          <thead><tr className="text-[#9a9aa4]"><th className="text-left p-2">数据源</th><th className="text-left p-2">类型</th><th className="text-left p-2">状态</th><th className="text-left p-2">延迟</th><th className="text-left p-2">详情</th></tr></thead>
          <tbody>
            {history.length === 0 ? (
              <tr><td colSpan={5}><div className="text-xs text-[#9a9aa4] p-2.5 text-center border border-dashed border-[#3a3a45] rounded-lg">尚未巡检</div></td></tr>
            ) : history.map((h, i) => (
              <tr key={i} className="hover:bg-[#26262d]">
                <td className="p-2">{h.ds}</td>
                <td className="p-2"><Badge variant="outline">{h.kind}</Badge></td>
                <td className="p-2"><Badge className={h.ok ? 'bg-[#3ddc9726] text-[#3ddc97] border-[#3ddc9759]' : 'text-[#f56c6c] bg-[#f56c6c26] border-[#f56c6c66]'}>{h.ok ? '正常' : '故障'}</Badge></td>
                <td className="p-2">{h.latency_ms}ms</td>
                <td className="p-2 text-xs text-[#9a9aa4] truncate max-w-[200px]">{h.detail || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card className="bg-[#1d1d22] border-[#2f2f38] p-4 rounded-xl">
        <h3 className="text-sm font-semibold mb-3">性能基线</h3>
        <Button size="sm" variant="outline" onClick={handleBaseline}>📈 生成性能基线</Button>
        {baseline && <pre className="mt-3 text-xs text-[#cdd3e0] bg-[#0f0f14] border border-[#2f2f38] rounded-lg p-3 max-h-80 overflow-auto whitespace-pre-wrap">{baseline}</pre>}
      </Card>
    </div>
  )
}
```

- [ ] **Step 4: 创建 `gov-panel.tsx`**

```tsx
// web-ui/src/components/workbench/gov-panel.tsx
import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { api } from '@/lib/api'
import type { GovAsset, GovQualityRow } from '@/lib/types'

export function GovPanel() {
  const [assets, setAssets] = useState<GovAsset[]>([])
  const [quality, setQuality] = useState<GovQualityRow[]>([])
  const [dsFilter, setDsFilter] = useState('')
  const [extracting, setExtracting] = useState(false)
  const [scoring, setScoring] = useState(false)

  const load = async () => {
    const [ar, qr] = await Promise.all([api.govAssets(dsFilter), api.govQualityRows(dsFilter)])
    if (ar.success) setAssets((ar.data as GovAsset[]) || [])
    if (qr.success) setQuality((qr.data as GovQualityRow[]) || [])
  }
  useEffect(() => { load() }, [])

  const handleCatalog = async () => {
    setExtracting(true)
    await api.govCatalog(dsFilter || undefined)
    setExtracting(false)
    load()
  }

  const handleQuality = async () => {
    setScoring(true)
    await api.govQuality(dsFilter || undefined)
    setScoring(false)
    load()
  }

  const handleKgSync = async () => {
    await api.govKgSync()
  }

  return (
    <div className="space-y-4">
      <Card className="bg-[#1d1d22] border-[#2f2f38] p-4 rounded-xl">
        <h3 className="text-sm font-semibold mb-3">元数据资产目录</h3>
        <div className="flex gap-2 items-center flex-wrap">
          <Input className="w-48 bg-[#26262d] border-[#3a3a45]" placeholder="数据源名（留空=全部）" value={dsFilter} onChange={e => setDsFilter(e.target.value)} />
          <Button size="sm" className="bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" disabled={extracting} onClick={handleCatalog}>
            {extracting ? '⏳ 抽取中…' : '🗂️ 抽取资产目录'}
          </Button>
          <Button size="sm" variant="outline" onClick={handleKgSync}>🧠 同步知识图谱</Button>
        </div>
        <table className="w-full text-[13px] mt-3">
          <thead><tr className="text-[#9a9aa4]"><th className="text-left p-2">数据源</th><th className="text-left p-2">对象</th><th className="text-left p-2">类型</th><th className="text-left p-2">列数</th><th className="text-left p-2">行数</th><th className="text-left p-2">主键</th></tr></thead>
          <tbody>
            {assets.length === 0 ? (
              <tr><td colSpan={6}><div className="text-xs text-[#9a9aa4] p-2.5 text-center border border-dashed border-[#3a3a45] rounded-lg">尚未抽取</div></td></tr>
            ) : assets.map((a, i) => (
              <tr key={i} className="hover:bg-[#26262d]">
                <td className="p-2">{a.ds}</td><td className="p-2">{a.object}</td>
                <td className="p-2"><Badge variant="outline">{a.obj_type}</Badge></td>
                <td className="p-2">{a.columns?.length || 0}</td>
                <td className="p-2">{a.row_count < 0 ? '—' : a.row_count}</td>
                <td className="p-2 text-xs">{a.pk || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card className="bg-[#1d1d22] border-[#2f2f38] p-4 rounded-xl">
        <h3 className="text-sm font-semibold mb-3">数据质量评分</h3>
        <Button size="sm" variant="outline" disabled={scoring} onClick={handleQuality}>
          {scoring ? '⏳ 评分中…' : '🔍 质量评分'}
        </Button>
        <table className="w-full text-[13px] mt-3">
          <thead><tr className="text-[#9a9aa4]"><th className="text-left p-2">数据源</th><th className="text-left p-2">对象</th><th className="text-left p-2">行数</th><th className="text-left p-2">非空率</th><th className="text-left p-2">唯一率</th><th className="text-left p-2">空值率</th><th className="text-left p-2">评分</th><th className="text-left p-2">问题</th></tr></thead>
          <tbody>
            {quality.length === 0 ? (
              <tr><td colSpan={8}><div className="text-xs text-[#9a9aa4] p-2.5 text-center border border-dashed border-[#3a3a45] rounded-lg">尚未评分</div></td></tr>
            ) : quality.map((q, i) => (
              <tr key={i} className="hover:bg-[#26262d]">
                <td className="p-2">{q.ds}</td><td className="p-2">{q.object}</td>
                <td className="p-2">{q.row_count}</td><td className="p-2">{q.filled_rate}%</td>
                <td className="p-2">{q.unique_rate}%</td><td className="p-2">{q.null_rate}%</td>
                <td className="p-2"><Badge className={q.score >= 80 ? 'bg-[#3ddc9726] text-[#3ddc97] border-[#3ddc9759]' : q.score >= 50 ? '' : 'text-[#f56c6c] bg-[#f56c6c26] border-[#f56c6c66]'}>{q.score}</Badge></td>
                <td className="p-2 text-xs text-[#9a9aa4]">{q.issues?.join('；') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
```

- [ ] **Step 5: 创建 `security-panel.tsx`**

```tsx
// web-ui/src/components/workbench/security-panel.tsx
import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/api'
import type { SecurityLog } from '@/lib/types'

export function SecurityPanel() {
  const [logs, setLogs] = useState<SecurityLog[]>([])
  const [pathFilter, setPathFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  const load = async () => {
    const r = await api.securityLogs()
    if (r.success) setLogs((r.data as SecurityLog[]) || [])
  }
  useEffect(() => { load() }, [])

  const filtered = logs.filter(x => {
    if (pathFilter && !(x.path || '').includes(pathFilter)) return false
    if (statusFilter) {
      const s = String(x.status)
      if (statusFilter === '0') { if (s !== '429' && s !== '401') return false }
      else if (!s.startsWith(statusFilter)) return false
    }
    return true
  })

  return (
    <Card className="bg-[#1d1d22] border-[#2f2f38] p-4 rounded-xl">
      <h3 className="text-sm font-semibold mb-3">API 请求审计日志</h3>
      <div className="flex gap-2 items-center mb-3 flex-wrap">
        <span className="text-xs text-[#9a9aa4]">筛选：</span>
        <Select value={pathFilter} onValueChange={setPathFilter}>
          <SelectTrigger className="w-52 bg-[#26262d] border-[#3a3a45]"><SelectValue placeholder="全部路径" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部路径</SelectItem>
            <SelectItem value="datasources">数据源</SelectItem>
            <SelectItem value="chat">对话</SelectItem>
            <SelectItem value="kg">知识图谱</SelectItem>
            <SelectItem value="agents">智能体</SelectItem>
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-32 bg-[#26262d] border-[#3a3a45]"><SelectValue placeholder="全部状态" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="2">2xx 成功</SelectItem>
            <SelectItem value="4">4xx/5xx 异常</SelectItem>
            <SelectItem value="0">拦截记录</SelectItem>
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" onClick={load}>刷新</Button>
        <span className="text-xs text-[#9a9aa4]">当前 {filtered.length} / {logs.length}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead><tr className="text-[#9a9aa4]"><th className="text-left p-2">时间</th><th className="text-left p-2">方法</th><th className="text-left p-2">路径</th><th className="text-left p-2">IP</th><th className="text-left p-2">状态</th><th className="text-left p-2">耗时</th><th className="text-left p-2">备注</th></tr></thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={7}><div className="text-xs text-[#9a9aa4] p-2.5 text-center border border-dashed border-[#3a3a45] rounded-lg">暂无日志</div></td></tr>
            ) : filtered.map((l, i) => {
              const st = String(l.status)
              const isDeny = st === '401' || st === '429'
              return (
                <tr key={i} className="hover:bg-[#26262d]">
                  <td className="p-2 whitespace-nowrap text-xs">{l.created_at ? new Date(l.created_at).toLocaleString() : ''}</td>
                  <td className="p-2"><Badge variant="outline">{l.method}</Badge></td>
                  <td className="p-2 font-mono text-xs truncate max-w-[260px]">{l.path}</td>
                  <td className="p-2">{l.ip}</td>
                  <td className="p-2"><Badge className={isDeny ? 'text-[#f56c6c] bg-[#f56c6c26] border-[#f56c6c66]' : st.startsWith('2') ? 'bg-[#3ddc9726] text-[#3ddc97] border-[#3ddc9759]' : ''}>{isDeny ? '⛔ ' : ''}{st}</Badge></td>
                  <td className="p-2">{l.duration_ms}ms</td>
                  <td className="p-2 text-xs text-[#9a9aa4] truncate max-w-[220px]">{l.notes || ''}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
```

- [ ] **Step 6: Commit**

```bash
git add web-ui/src/components/workbench/
git commit -m "feat: add datasources, MCP, ops, gov, security panels"
```

---

## Task 10: 创建设置对话框

**Files:**
- Create: `web-ui/src/components/settings/settings-dialog.tsx`

- [ ] **Step 1: 创建 `settings-dialog.tsx`**

```tsx
// web-ui/src/components/settings/settings-dialog.tsx
import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { api } from '@/lib/api'
import type { Settings } from '@/lib/types'

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [form, setForm] = useState<Settings>({ provider: 'ollama', model: '', base_url: '', api_key: '', embedding_model: '' })
  const [models, setModels] = useState<string[]>([])
  const [showModels, setShowModels] = useState(false)

  useEffect(() => {
    if (open) {
      api.getSettings().then(r => {
        if (r.success && r.data) setForm(r.data)
      })
    }
  }, [open])

  const handleFetchModels = async () => {
    const r = await api.fetchOllamaModels()
    if (r.success && r.data) setModels(r.data as string[])
  }

  const handleSave = async () => {
    await api.updateSettings(form)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[#1d1d22] border-[#3a3a45] text-[#e8e8ec] max-w-md">
        <DialogHeader><DialogTitle>设置</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs text-[#9a9aa4]">LLM 提供商</Label>
            <Select value={form.provider} onValueChange={v => setForm({ ...form, provider: v })}>
              <SelectTrigger className="bg-[#26262d] border-[#3a3a45]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ollama">Ollama（本地）</SelectItem>
                <SelectItem value="deepseek">DeepSeek</SelectItem>
                <SelectItem value="bailian">阿里云百炼</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-[#9a9aa4]">模型</Label>
            <div className="flex gap-1.5">
              <Input className="flex-1 bg-[#26262d] border-[#3a3a45]" placeholder="qwen2.5 / deepseek-chat" value={form.model} onChange={e => setForm({ ...form, model: e.target.value })} />
              <Button size="sm" variant="outline" onClick={handleFetchModels}>📡 模型列表</Button>
            </div>
            {showModels && models.length > 0 && (
              <div className="flex gap-1 flex-wrap">{models.map(m => <Button key={m} size="sm" variant="ghost" onClick={() => { setForm({ ...form, model: m }); setShowModels(false) }}>{m}</Button>)}</div>
            )}
            {models.length > 0 && !showModels && <Button size="sm" variant="ghost" className="text-xs" onClick={() => setShowModels(true)}>显示 {models.length} 个模型</Button>}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-[#9a9aa4]">Base URL</Label>
            <Input className="bg-[#26262d] border-[#3a3a45]" placeholder="http://localhost:11434" value={form.base_url} onChange={e => setForm({ ...form, base_url: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-[#9a9aa4]">API Key</Label>
            <Input className="bg-[#26262d] border-[#3a3a45]" type="password" placeholder="deepseek/百炼 必填" value={form.api_key} onChange={e => setForm({ ...form, api_key: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-[#9a9aa4]">Embedding 模型</Label>
            <Input className="bg-[#26262d] border-[#3a3a45]" placeholder="nomic-embed-text / text-embedding-v3" value={form.embedding_model} onChange={e => setForm({ ...form, embedding_model: e.target.value })} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
          <Button className="bg-gradient-to-br from-[#5b7cfa] to-[#7a5bfa] text-white" onClick={handleSave}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add web-ui/src/components/settings/
git commit -m "feat: add settings dialog"
```

---

## Task 11: 组装 App.tsx 根组件

**Files:**
- Modify: `web-ui/src/App.tsx`
- Modify: `web-ui/index.html`

- [ ] **Step 1: 更新 `index.html` 标题**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>数据库国产化智能体</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: 编写 `App.tsx`**

```tsx
// web-ui/src/App.tsx
import { useState } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { IconBar } from '@/components/layout/icon-bar'
import { Sidebar } from '@/components/layout/sidebar'
import { TopBar } from '@/components/layout/top-bar'
import { ChatView } from '@/components/chat/chat-view'
import { WorkbenchView } from '@/components/workbench/workbench-view'
import { SettingsDialog } from '@/components/settings/settings-dialog'
import { useConversations } from '@/hooks/use-conversations'
import { useHealth } from '@/hooks/use-health'

type View = 'chat' | 'workbench'

export default function App() {
  const [view, setView] = useState<View>('chat')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const conv = useConversations()
  const healthy = useHealth()

  const handleConvCreated = (id: number) => {
    conv.setCurrentId(id)
    conv.reload()
  }

  return (
    <TooltipProvider>
      <div className="bg-[#141417] text-[#e8e8ec] h-screen flex overflow-hidden font-sans text-sm">
        <IconBar currentView={view} onViewChange={setView} onSettings={() => setSettingsOpen(true)} />

        {view === 'chat' && (
          <Sidebar
            conversations={conv.conversations}
            currentId={conv.currentId}
            searchKw={conv.searchKw}
            onSearch={conv.setSearchKw}
            onSelect={conv.setCurrentId}
            onNew={() => conv.create('新会话')}
            onDelete={conv.remove}
          />
        )}

        <main className="flex-1 flex flex-col min-w-0">
          <TopBar healthy={healthy} />
          {view === 'chat' ? (
            <ChatView
              convId={conv.currentId}
              onConvCreated={handleConvCreated}
              onRefreshArtifacts={() => {}}
            />
          ) : (
            <WorkbenchView />
          )}
        </main>

        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      </div>
    </TooltipProvider>
  )
}
```

- [ ] **Step 3: 更新 `src/index.css` 添加全局暗色主题**

```css
@import "tailwindcss";

@layer base {
  :root {
    --background: #141417;
    --foreground: #e8e8ec;
    --card: #1d1d22;
    --card-foreground: #e8e8ec;
    --popover: #1d1d22;
    --popover-foreground: #e8e8ec;
    --primary: #5b7cfa;
    --primary-foreground: #ffffff;
    --secondary: #26262d;
    --secondary-foreground: #e8e8ec;
    --muted: #26262d;
    --muted-foreground: #9a9aa4;
    --accent: #26262d;
    --accent-foreground: #e8e8ec;
    --destructive: #f56c6c;
    --destructive-foreground: #ffffff;
    --border: #2f2f38;
    --input: #26262d;
    --ring: #5b7cfa;
    --radius: 0.75rem;
  }

  * {
    border-color: var(--border);
  }

  body {
    background-color: var(--background);
    color: var(--foreground);
    font-family: -apple-system, "PingFang SC", "Segoe UI", sans-serif;
  }

  /* Scrollbar */
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-thumb { background: #3a3a45; border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: #4a4a58; }
  ::-webkit-scrollbar-track { background: transparent; }
}
```

- [ ] **Step 4: 验证完整构建**

```bash
cd web-ui && npm run build
```

Expected: 构建成功，无 TypeScript 错误。

- [ ] **Step 5: 启动开发服务器验证**

```bash
cd web-ui && npm run dev
```

打开 http://localhost:5173，确认：
- 暗色主题正确渲染
- 左侧图标栏、会话列表、顶栏正常显示
- 对话/工作台视图切换正常
- 设置弹窗可打开
- 各工作台面板可切换

- [ ] **Step 6: Commit**

```bash
git add web-ui/
git commit -m "feat: assemble App.tsx with full layout and routing"
```

---

## Task 12: 后端集成 - 构建产物部署

**Files:**
- Modify: `db_loc_agent/app.py`（可选，添加构建后静态文件指向）

- [ ] **Step 1: 构建生产版本**

```bash
cd web-ui && npm run build
```

产物输出到 `web-ui/dist/`。

- [ ] **Step 2: 配置后端 serve 构建产物（可选）**

在 `app.py` 中，可以将 `static_dir` 指向 `web-ui/dist/`，或者在部署时将 `dist/` 内容复制到 `web/` 目录。

或者保持开发模式：前端 `npm run dev`（5173 端口，proxy 到后端 8000），后端独立运行。

- [ ] **Step 3: 最终 Commit**

```bash
git add web-ui/
git commit -m "feat: complete Vite + React + shadcn/ui frontend migration"
```

---

## 总结

| Task | 内容 | 产出文件 |
|------|------|----------|
| 1 | 初始化 Vite + React + TS | 项目脚手架 |
| 2 | 初始化 shadcn/ui | components.json + UI 组件 |
| 3 | 类型定义 + API 层 | `lib/types.ts`, `lib/api.ts` |
| 4 | 自定义 Hooks | 3 个 hooks |
| 5 | 布局组件 | IconBar, Sidebar, TopBar |
| 6 | 对话视图 | ChatView, Message, Composer, ArtifactSidebar |
| 7 | 工作台 - 知识库/图谱/产物 | WorkbenchView + 3 panels |
| 8 | 工作台 - 智能体/技能/提示词 | 3 panels |
|