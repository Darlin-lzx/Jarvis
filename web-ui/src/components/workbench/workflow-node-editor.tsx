import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { WorkflowGraph, WorkflowLink, WorkflowNode } from '@/lib/types'
import type { WorkflowLinkInput, WorkflowServiceInput } from './workflow-xml-editor'
import { Plus, Save, Trash2, X } from 'lucide-react'

const fieldClass = 'h-7 bg-[#0f0f14] text-[11px]'
const labelClass = 'w-11 shrink-0 text-[10px] leading-7 text-[#8b8b9e]'

export interface WorkflowNodeDraft {
  label: string
  service: WorkflowServiceInput
  links: WorkflowLinkInput[]
}

function draftFromNode(node: WorkflowNode): WorkflowNodeDraft {
  return {
    label: node.label,
    service: {
      runtype: node.service?.runtype ?? 'csfService',
      crossCenter: node.service?.cross_center ?? false,
      centercode: node.service?.centercode ?? '',
      servicecode: node.service?.servicecode ?? '',
      servicename: node.service?.servicename ?? '',
    },
    links: node.links.map((link: WorkflowLink) => ({
      direction: link.direction || 'IN',
      left: link.left,
      right: link.right,
      defaultValue: link.default_value,
      dataType: link.default_value_type,
    })),
  }
}

function LinkCard({
  link, onChange, onRemove,
}: {
  link: WorkflowLinkInput
  onChange: (next: WorkflowLinkInput) => void
  onRemove: () => void
}) {
  return (
    <div className="space-y-1 rounded-md border border-[#252530] bg-[#0f0f14] p-2">
      <div className="flex items-center justify-between gap-1">
        <select
          className="h-6 rounded border border-[#252530] bg-[#16161e] px-1.5 text-[10px] text-[#cdd3e0]"
          value={link.direction}
          onChange={event => onChange({ ...link, direction: event.target.value })}
        >
          <option value="IN">IN</option>
          <option value="OUT">OUT</option>
        </select>
        <button
          className="flex h-6 items-center rounded border border-[#252530] px-1.5 text-[10px] text-[#8b8b9e] hover:bg-white/5 hover:text-red-300"
          title="移除该参数映射（保存后生效）"
          onClick={onRemove}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="flex items-center gap-1">
        <span className={labelClass}>左值</span>
        <Input
          className={cn(fieldClass, 'h-6 flex-1')} placeholder="left"
          value={link.left} onChange={e => onChange({ ...link, left: e.target.value })}
        />
      </div>
      <div className="flex items-center gap-1">
        <span className={labelClass}>右值</span>
        <Input
          className={cn(fieldClass, 'h-6 flex-1')} placeholder="right"
          value={link.right} onChange={e => onChange({ ...link, right: e.target.value })}
        />
      </div>
      <div className="flex items-center gap-1">
        <span className={labelClass}>默认</span>
        <Input
          className={cn(fieldClass, 'h-6 flex-1 min-w-0')} placeholder="默认值"
          value={link.defaultValue} onChange={e => onChange({ ...link, defaultValue: e.target.value })}
        />
        <Input
          className={cn(fieldClass, 'h-6 w-[84px] shrink-0')} placeholder="dataType"
          value={link.dataType} onChange={e => onChange({ ...link, dataType: e.target.value })}
        />
      </div>
    </div>
  )
}

export function WorkflowNodeEditor({
  node, graph, onSave, onDeleteNode,
}: {
  node: WorkflowNode
  graph: WorkflowGraph
  /** 统一保存：label + 服务调用 + 全部参数映射，一次原子提交 */
  onSave: (draft: WorkflowNodeDraft) => void
  onDeleteNode: () => void
}) {
  const [draft, setDraft] = useState<WorkflowNodeDraft>(() => draftFromNode(node))
  const [newLink, setNewLink] = useState<WorkflowLinkInput>({
    direction: 'IN', left: '', right: '', defaultValue: '', dataType: '',
  })

  const outgoing = graph.edges.filter(edge => edge.source === node.id)
  const nodeMap = new Map(graph.nodes.map(item => [item.id, item]))

  function updateLink(index: number, next: WorkflowLinkInput) {
    setDraft(value => ({
      ...value,
      links: value.links.map((link, i) => (i === index ? next : link)),
    }))
  }

  return (
    <div className="space-y-3 text-[12px]" data-node-editor>
      <div>
        <div className="text-[13px] font-medium text-[#e4e4e9]">{node.label || node.id}</div>
        <div className="mt-1 font-mono text-[10px] text-[#8b8b9e]">ID {node.id} · {node.type}</div>
      </div>

      <div className="space-y-1.5 border-t border-[#252530] pt-3">
        <div className="text-[11px] font-medium text-[#cdd3e0]">节点属性</div>
        <div className="flex items-center gap-1">
          <span className={labelClass}>名称</span>
          <Input
            className={cn(fieldClass, 'flex-1')} value={draft.label}
            onChange={e => setDraft(value => ({ ...value, label: e.target.value }))}
          />
        </div>
        <div className="flex items-center gap-2 pt-0.5">
          <label className="flex items-center gap-1.5 text-[11px] text-[#8b8b9e]">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-indigo-500"
              checked={draft.service.crossCenter}
              onChange={e => setDraft(value => ({
                ...value, service: { ...value.service, crossCenter: e.target.checked },
              }))}
            />
            crossCenter
          </label>
          <div className="flex flex-1 items-center gap-1">
            <span className={cn(labelClass, 'w-14')}>runtype</span>
            <Input
              className={cn(fieldClass, 'h-6 flex-1')} value={draft.service.runtype}
              onChange={e => setDraft(value => ({
                ...value, service: { ...value.service, runtype: e.target.value },
              }))}
            />
          </div>
        </div>
        {(['centercode', 'servicecode', 'servicename'] as const).map(key => (
          <div key={key} className="flex items-center gap-1">
            <span className={cn(labelClass, 'w-14')}>{key === 'centercode' ? '中心' : key === 'servicecode' ? '服务码' : '服务名'}</span>
            <Input
              className={cn(fieldClass, 'h-6 flex-1')}
              value={draft.service[key]}
              onChange={e => setDraft(value => ({
                ...value, service: { ...value.service, [key]: e.target.value },
              }))}
            />
          </div>
        ))}
      </div>

      <div className="space-y-1.5 border-t border-[#252530] pt-3">
        <div className="text-[11px] font-medium text-[#cdd3e0]">
          参数映射
          <span className="ml-1.5 text-[10px] font-normal text-[#5a5a70]">改动后点底部保存生效</span>
        </div>
        {draft.links.length === 0 && (
          <div className="rounded-md border border-dashed border-[#3a3a45] px-2 py-2 text-center text-[11px] text-[#5a5a70]">
            暂无参数映射
          </div>
        )}
        {draft.links.map((link, index) => (
          <LinkCard
            key={index}
            link={link}
            onChange={next => updateLink(index, next)}
            onRemove={() => setDraft(value => ({
              ...value, links: value.links.filter((_, i) => i !== index),
            }))}
          />
        ))}
        <div className="space-y-1 rounded-md border border-dashed border-[#3a3a45] bg-[#0f0f14] p-2">
          <div className="flex items-center justify-between gap-1">
            <select
              className="h-6 rounded border border-[#252530] bg-[#16161e] px-1.5 text-[10px] text-[#cdd3e0]"
              value={newLink.direction}
              onChange={event => setNewLink(value => ({ ...value, direction: event.target.value }))}
            >
              <option value="IN">IN</option>
              <option value="OUT">OUT</option>
            </select>
            <button
              className="flex h-6 items-center gap-1 rounded border border-[#252530] px-1.5 text-[10px] text-[#8b8b9e] hover:bg-white/5 hover:text-emerald-300 disabled:opacity-40"
              disabled={!newLink.left.trim() && !newLink.right.trim()}
              title="新增一条参数映射（保存后生效）"
              onClick={() => {
                setDraft(value => ({ ...value, links: [...value.links, newLink] }))
                setNewLink({ direction: newLink.direction, left: '', right: '', defaultValue: '', dataType: '' })
              }}
            >
              <Plus className="h-3 w-3" />加入
            </button>
          </div>
          <div className="flex items-center gap-1">
            <span className={labelClass}>左值</span>
            <Input
              className={cn(fieldClass, 'h-6 flex-1')} placeholder="left"
              value={newLink.left} onChange={e => setNewLink(value => ({ ...value, left: e.target.value }))}
            />
          </div>
          <div className="flex items-center gap-1">
            <span className={labelClass}>右值</span>
            <Input
              className={cn(fieldClass, 'h-6 flex-1')} placeholder="right"
              value={newLink.right} onChange={e => setNewLink(value => ({ ...value, right: e.target.value }))}
            />
          </div>
          <div className="flex items-center gap-1">
            <span className={labelClass}>默认</span>
            <Input
              className={cn(fieldClass, 'h-6 flex-1 min-w-0')} placeholder="默认值"
              value={newLink.defaultValue} onChange={e => setNewLink(value => ({ ...value, defaultValue: e.target.value }))}
            />
            <Input
              className={cn(fieldClass, 'h-6 w-[84px] shrink-0')} placeholder="dataType"
              value={newLink.dataType} onChange={e => setNewLink(value => ({ ...value, dataType: e.target.value }))}
            />
          </div>
        </div>
      </div>

      <div className="space-y-1 border-t border-[#252530] pt-3">
        <div className="text-[11px] font-medium text-[#cdd3e0]">出边</div>
        {outgoing.length === 0 ? (
          <div className="text-[11px] text-[#5a5a70]">无</div>
        ) : outgoing.map(edge => (
          <div key={edge.id} className="truncate text-[11px] text-[#8b8b9e]">
            <span className="text-[#cdd3e0]">{nodeMap.get(edge.target)?.label || edge.target}</span>
            <span className="ml-1 font-mono text-[10px]">#{edge.target}</span>
          </div>
        ))}
      </div>

      <div className="space-y-2 border-t border-[#252530] pt-3">
        <Button size="sm" className="h-7 w-full text-[11px]" onClick={() => onSave(draft)}>
          <Save className="mr-1 h-3 w-3" />保存全部修改
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 w-full border-red-500/30 text-[11px] text-red-300 hover:bg-red-500/10 hover:text-red-200"
          onClick={onDeleteNode}
        >
          <Trash2 className="mr-1 h-3 w-3" />删除节点
        </Button>
      </div>
    </div>
  )
}
