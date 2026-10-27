import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path: string) => readFileSync(path, 'utf8')

test('agent workspace uses isolated summary, changes, project and evidence APIs', () => {
  const types = read('src/lib/types.ts')
  const api = read('src/lib/api.ts')

  assert.match(types, /export interface WorkspaceSummary \{/)
  assert.match(types, /export interface WorkspaceChange \{/)
  assert.match(types, /export interface WorkspaceEvidence \{/)
  assert.match(api, /agentWorkspaceSummary: \(agentId: string\)/)
  assert.match(api, /agentWorkspaceChanges: \(agentId: string\)/)
  assert.match(api, /agentWorkspaceTree: \(agentId: string, path = ''\)/)
  assert.match(api, /agentWorkspaceFile: \(agentId: string, path: string\)/)
  assert.match(api, /agentWorkspaceDiff: \(agentId: string, path: string\)/)
  assert.match(api, /agentWorkspaceEvidence: \(agentId: string, convId\?: number \| null\)/)
})

test('workspace panel separates real changes from evidence', () => {
  const panel = read('src/components/chat/workspace-panel.tsx')

  assert.match(panel, /const \[tab, setTab\] = useState<WorkspaceTab>\('changes'\)/)
  assert.match(panel, /agentWorkspaceChanges\(/)
  assert.match(panel, /agentWorkspaceTree\(/)
  assert.match(panel, /agentWorkspaceEvidence\(/)
  assert.match(panel, /Evidence/)
  assert.match(panel, /未绑定工程目录/)
  assert.doesNotMatch(panel, /listArtifacts\(/)
})

test('chat view refreshes selected agent workspace after each run', () => {
  const chat = read('src/components/chat/chat-view.tsx')

  assert.match(chat, /import \{ WorkspacePanel \} from '\.\/workspace-panel'/)
  assert.doesNotMatch(chat, /ChangedFilesPanel/)
  assert.match(chat, /workspaceRefreshKey/)
  assert.match(chat, /setWorkspaceRefreshKey\(value => value \+ 1\)/)
  assert.match(chat, /<WorkspacePanel/)
  assert.match(chat, /agent=\{selectedWorkspaceAgent\}/)
})

test('message file locations open the workspace preview at a line', () => {
  const message = read('src/components/chat/message.tsx')
  const panel = read('src/components/chat/workspace-panel.tsx')
  const chat = read('src/components/chat/chat-view.tsx')

  assert.match(message, /onOpenWorkspaceFile/)
  assert.match(panel, /openFileRequest/)
  assert.match(panel, /data-line=/)
  assert.match(chat, /handleOpenWorkspaceFile/)
  assert.match(chat, /workspaceOpenRequest/)
})
