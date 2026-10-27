import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import {
  buildWorkflowInsertSql, chunkXmlContent, formatSqlDate, formatSqlDateTime,
} from './workflow-sql-export'
import { Check, Copy, Download, FileDown } from 'lucide-react'

export interface WorkflowExportDefaults {
  templateTag: string
  orderNum: string
  createStaffId: string
}

export function WorkflowExportDialog({
  open, onOpenChange, xml, defaults, table,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  xml: string
  defaults: WorkflowExportDefaults
  table?: string
}) {
  const [templateVersionId, setTemplateVersionId] = useState(() => String(Date.now()))
  const [orderNum, setOrderNum] = useState(defaults.orderNum)
  const [templateTag, setTemplateTag] = useState(defaults.templateTag)
  const [createStaffId, setCreateStaffId] = useState(defaults.createStaffId)
  const [createDate, setCreateDate] = useState(() => formatSqlDateTime(new Date()))
  const [modifyDesc, setModifyDesc] = useState('')
  const [validDate, setValidDate] = useState(() => formatSqlDate(new Date()))
  const [expireDate, setExpireDate] = useState('2099-12-31 00:00:00.000')
  const [copied, setCopied] = useState(false)

  const result = useMemo(() => buildWorkflowInsertSql({
    templateVersionId, orderNum, templateTag, createStaffId,
    createDate, modifyDesc, validDate, expireDate, xml, table,
  }), [templateVersionId, orderNum, templateTag, createStaffId, createDate, modifyDesc, validDate, expireDate, xml, table])

  const chunkCount = useMemo(() => chunkXmlContent(xml).length, [xml])
  const charCount = useMemo(() => Array.from(xml).length, [xml])
  const sql = 'sql' in result ? result.sql : ''
  const error = 'error' in result ? result.error : ''

  async function copySql() {
    if (!sql) return
    try {
      await navigator.clipboard.writeText(sql)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  function downloadSql() {
    if (!sql) return
    const blob = new Blob([sql], { type: 'text/sql;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `vm_template_version_${templateVersionId || Date.now()}.sql`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const fieldClass = 'h-7 bg-[#0f0f14] text-[11px]'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <FileDown className="h-4 w-4 text-indigo-400" />导出工作流模板 SQL
          </DialogTitle>
          <DialogDescription className="text-[12px] text-[#8b8b9e]">
            XML 按 4000 字符（UTF-8 码点）拆分为 content..content15，共 {chunkCount} 块 / {charCount} 字符。
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2 text-[11px] text-[#8b8b9e]">
          <label className="space-y-1">
            <span>template_version_id</span>
            <Input className={fieldClass} value={templateVersionId} onChange={e => setTemplateVersionId(e.target.value)} />
          </label>
          <label className="space-y-1">
            <span>order_num</span>
            <Input className={fieldClass} value={orderNum} onChange={e => setOrderNum(e.target.value)} />
          </label>
          <label className="col-span-2 space-y-1">
            <span>template_tag</span>
            <Input className={fieldClass} value={templateTag} onChange={e => setTemplateTag(e.target.value)} />
          </label>
          <label className="space-y-1">
            <span>create_staff_id</span>
            <Input className={fieldClass} value={createStaffId} onChange={e => setCreateStaffId(e.target.value)} />
          </label>
          <label className="space-y-1">
            <span>create_date</span>
            <Input className={fieldClass} value={createDate} onChange={e => setCreateDate(e.target.value)} />
          </label>
          <label className="space-y-1">
            <span>valid_date</span>
            <Input className={fieldClass} value={validDate} onChange={e => setValidDate(e.target.value)} />
          </label>
          <label className="space-y-1">
            <span>expire_date</span>
            <Input className={fieldClass} value={expireDate} onChange={e => setExpireDate(e.target.value)} />
          </label>
          <label className="col-span-2 space-y-1">
            <span>modify_desc</span>
            <Input className={fieldClass} placeholder="版本修改说明" value={modifyDesc} onChange={e => setModifyDesc(e.target.value)} />
          </label>
        </div>

        {error ? (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">{error}</div>
        ) : (
          <pre data-export-sql className="max-h-[38vh] overflow-auto rounded-md border border-[#252530] bg-[#0b0b10] p-3 font-mono text-[11px] leading-5 whitespace-pre text-[#cdd3e0] select-text">
            {sql}
          </pre>
        )}

        <DialogFooter>
          <Button size="sm" className="h-8" variant="outline" disabled={!sql} onClick={() => void copySql()}>
            {copied ? <Check className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
            {copied ? '已复制' : '复制 SQL'}
          </Button>
          <Button size="sm" className="h-8" disabled={!sql} onClick={downloadSql}>
            <Download className="mr-1 h-3.5 w-3.5" />下载 .sql
          </Button>
          <Button size="sm" className={cn('h-8')} variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
