import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path: string) => readFileSync(path, 'utf8')

test('Jarvis console uses one persisted commander conversation', () => {
  const app = read('src/App.tsx')
  const consoleSource = read('src/components/workbench/jarvis-console.tsx')
  const agentTabs = read('src/components/chat/agent-tabs.tsx')

  assert.match(app, /const JARVIS_CONV_STORAGE_KEY = 'jarvis\.console\.convId'/)
  assert.match(app, /api\.createConversation\('贾维斯控制台', \{\s*space_id: spaceResponse\.data\.id,\s*agent_id: 'jarvis_commander',\s*\}\)/)
  assert.match(app, /window\.localStorage\.setItem\(JARVIS_CONV_STORAGE_KEY, String\(conversationResponse\.data\.id\)\)/)
  assert.match(consoleSource, /await send\(command, id, 'jarvis_commander'\)/)
  assert.match(agentTabs, /\{ id: 'jarvis_commander', name: '贾维斯'/)
  assert.equal(agentTabs.includes("id: 'jarvis_commander', name: '迭代指挥官'"), false)
  assert.equal(consoleSource.includes('setActiveAgent'), false)
  assert.equal(consoleSource.includes('window.location.hash'), false)
})

test('Jarvis console renders chat, telemetry, faults, forms, and abort', () => {
  const consoleSource = read('src/components/workbench/jarvis-console.tsx')
  const css = read('src/components/workbench/jarvis-workbench.css')

  assert.match(consoleSource, /OPERATOR&gt;/)
  assert.match(consoleSource, /JARVIS&gt;/)
  assert.match(consoleSource, /TRACE ·/)
  assert.match(consoleSource, /FAULT ·/)
  assert.match(consoleSource, /PROCESSING/)
  assert.match(consoleSource, /ABORT/)
  assert.match(consoleSource, /<UiForm/)
  assert.match(consoleSource, /useChatStream/)
  assert.match(consoleSource, /api\.getMessages\(convId\)/)
  assert.match(consoleSource, /stop\(\)/)
  assert.equal(consoleSource.includes('ChatView'), false)
  assert.equal(consoleSource.includes('window.alert'), false)

  assert.match(css, /\.jarvis-console \{/)
  assert.match(css, /\.jarvis-console-log \{/)
  assert.match(css, /\.jarvis-line-user \{/)
  assert.match(css, /\.jarvis-line-jarvis \{/)
  assert.match(css, /\.jarvis-trace \{/)
  assert.match(css, /\.jarvis-fault \{/)
  assert.match(css, /\.jarvis-reactor\.compact \{/)
})

test('Jarvis console clear action resets only the local display', () => {
  const consoleSource = read('src/components/workbench/jarvis-console.tsx')
  const css = read('src/components/workbench/jarvis-workbench.css')

  assert.match(consoleSource, /import \{ Eraser \} from 'lucide-react'/)
  assert.match(consoleSource, /const handleClearConsole = useCallback/)
  assert.match(consoleSource, /const \[consoleCleared, setConsoleCleared\] = useState\(false\)/)
  assert.match(consoleSource, /const runEpochRef = useRef\(0\)/)
  assert.match(consoleSource, /if \(streaming\) stop\(\)/)
  assert.match(consoleSource, /setLines\(\[\]\)/)
  assert.match(consoleSource, /setPreserveAssistantText\(false\)/)
  assert.match(consoleSource, /setConsoleCleared\(true\)/)
  assert.match(consoleSource, /data-active=\{lines\.length > 0 \|\| \(streaming && !consoleCleared\)/)
  assert.match(consoleSource, /\{streaming && !consoleCleared && timeline\.map/)
  assert.match(consoleSource, /aria-label="清空贾维斯控制台显示"/)
  assert.match(consoleSource, /title="清空当前显示，不删除历史"/)
  assert.match(consoleSource, /<Eraser size=\{12\} aria-hidden="true" \/>/)
  assert.match(consoleSource, /CLEAR/)
  assert.match(css, /\.jarvis-console-clear \{/)
  assert.equal(consoleSource.includes('api.deleteConversation'), false)
  assert.equal(consoleSource.includes('api.createConversation'), false)
})
