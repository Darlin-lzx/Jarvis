import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('sidebar renders tasks directly below spaces', () => {
  const source = read('../src/components/layout/sidebar.tsx')

  assert.equal(source.includes('api.listTasks()'), true)
  assert.equal(source.includes('tasks.filter'), true)
  assert.equal(source.includes('onSelectTask'), true)
  assert.equal(source.includes('subsystems'), false)
  assert.equal(source.includes('onSelectSubSystem'), false)
  assert.equal(source.includes('createSubsystem'), false)
  assert.equal(source.includes('updateSubsystem'), false)
  assert.equal(source.includes('deleteSubsystem'), false)
})

test('sidebar task nodes expose direct deletion', () => {
  const sidebar = read('../src/components/layout/sidebar.tsx')
  const app = read('../src/App.tsx')

  assert.equal(sidebar.includes('deleteTaskFromSidebar'), true)
  assert.equal(sidebar.includes('api.deleteTask(taskId)'), true)
  assert.equal(sidebar.includes('onTaskDeleted'), true)
  assert.equal(sidebar.includes("title=\"删除任务\""), true)
  assert.equal(sidebar.includes('group-hover/child:opacity-100'), true)
  assert.equal(app.includes('handleTaskDeleted'), true)
})

test('task deletion uses a shared styled confirmation dialog', () => {
  const dialog = read('../src/components/project/delete-task-dialog.tsx')
  const sidebar = read('../src/components/layout/sidebar.tsx')
  const taskList = read('../src/components/project/task-list-page.tsx')
  const taskDetail = read('../src/components/project/task-detail-page.tsx')

  assert.equal(dialog.includes('删除任务'), true)
  assert.equal(dialog.includes('全部会话与产物'), true)
  assert.equal(dialog.includes('知识库'), true)
  assert.equal(dialog.includes('不可恢复'), true)
  assert.equal(dialog.includes('deleting'), true)
  assert.equal(dialog.includes('onConfirm'), true)

  for (const source of [sidebar, taskList, taskDetail]) {
    assert.equal(source.includes('DeleteTaskDialog'), true)
    assert.equal(source.includes('window.confirm(`删除任务'), false)
  }
})

test('sidebar space nodes support creating a task in place', () => {
  const sidebar = read('../src/components/layout/sidebar.tsx')
  const app = read('../src/App.tsx')

  assert.equal(sidebar.includes('onCreateTask?: (group: WorkspaceGroup) => void'), true)
  assert.equal(sidebar.includes('title="新增任务"'), true)
  assert.equal(sidebar.includes('onCreateTask?.(group)'), true)
  assert.equal(app.includes('handleCreateTaskInSpace'), true)
  assert.equal(app.includes('lockSpace: true'), true)
  assert.equal(app.includes('onCreateTask={handleCreateTaskInSpace}'), true)
})

test('new task dialog surfaces API rejection details', () => {
  const dialog = read('../src/components/project/new-task-dialog.tsx')

  assert.equal(dialog.includes('const [error, setError]'), true)
  assert.equal(dialog.includes('setError(null)'), true)
  assert.equal(dialog.includes("r.error || r.detail || '任务创建失败"), true)
  assert.equal(dialog.includes('text-red-400'), true)
})

test('task screens and app routing no longer expose subsystem hierarchy', () => {
  const app = read('../src/App.tsx')
  const taskList = read('../src/components/project/task-list-page.tsx')
  const newTask = read('../src/components/project/new-task-dialog.tsx')
  const taskDetail = read('../src/components/project/task-detail-page.tsx')
  const convert = read('../src/components/chat/convert-to-project-dialog.tsx')

  for (const source of [app, taskList, newTask, taskDetail, convert]) {
    assert.equal(source.includes('subId'), false)
    assert.equal(source.includes('sub_system_id'), false)
    assert.equal(source.includes('子系统'), false)
  }

  assert.equal(app.includes('SubSystemDetailPage'), false)
  assert.equal(taskList.includes('api.listTasks(sid, st || undefined)'), true)
  assert.equal(newTask.includes('space_id: spaceId,'), true)
  assert.equal(convert.includes('subsystems'), false)
})

test('project conversion submits only space ownership', () => {
  const convert = read('../src/components/chat/convert-to-project-dialog.tsx')
  const welcome = read('../src/components/chat/welcome-page.tsx')
  const app = read('../src/App.tsx')

  assert.equal(convert.includes('onConfirm: (spaceId: number) => void'), true)
  assert.equal(welcome.includes('dialogSubId'), false)
  assert.equal(welcome.includes('sub_system_id: task.sub_system_id'), false)
  assert.equal(app.includes('attachSpace(conv.currentId, { space_id:'), true)
  assert.equal(app.includes('sub_system_id: subId'), false)
})
