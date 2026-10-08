import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import {
  MIGRATE_STATUS_LABEL,
  type MigrateTask, type MigrateTaskDetail, type MigrateAsset,
  type RuleScanResult, type RuleFinding,
} from '@/lib/types'
import {
  RefreshCw, Database, Play, Trash2, FileSpreadsheet, FlaskConical,
  ChevronDown, ChevronRight, Loader2, ScanSearch, Workflow, Boxes,
  RotateCw, ArrowLeft,
} from 'lucide-react'
import { StateBoard, BOARD_STAGES, effectiveIdx, StageDrawer } from '@/components/migrate/state-board'
import { FlowBoard } from '@/components/migrate/flow-board'

/* ---- 风险色 ---- */
const riskColor = (r: string) =>
  r === '高' ? 'text-red-400 bg-red-500/10 border-red-500/20'
    : r === '中' ? 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20'
      : 'text-green-400 bg-green-500/10 border-green-500/20'

/* ---- 规则引擎扫描测试 ---- */
function RuleScanBox({ onStatsChange }: { onStatsChange?: (s: RuleScanResult) => void }) {
  const [sql, setSql] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<RuleScanResult | null>(null)
  const [error, setError] = useState('')

  const run = async () => {
    if (!sql.trim()) return
    setRunning(true)
    setError('')
    const r = await api.ruleScan(sql).catch(e => ({ success: false, error: String(e), data: undefined }))
    if (r.success && r.data) {
      setResult(r.data as RuleScanResult)
      onStatsChange?.(r.data as RuleScanResult)
    } else {
      setError((r as { error?: string }).error || '扫描失败')
    }
    setRunning(false)
  }

  return (
    <div className="rounded-xl border border-[#252530] bg-[#16161e] p-3">
      <div className="flex items-center gap-2 mb-2">
        <FlaskConical className="w-3.5 h-3.5 text-cyan-400" />
        <span className="text-[12px] font-medium text-[#e4e4e9]">规则引擎静态扫描（规则找问题，LLM 解释问题）</span>
      </div>
      <textarea
        className="w-full h-24 rounded-lg bg-[#0f0f14] border border-[#252530] p-2 text-[11px] font-mono text-[#cdd3e0] resize-none outline-none focus:border-indigo-500/50"
        placeholder={'粘贴 Oracle/MySQL 的 SQL 或 DDL 进行静态词法扫描，如：\nSELECT ROWNUM, SYSDATE FROM dual WHERE NVL(a,0)=1\nCREATE TABLE t (id NUMBER, remark VARCHAR2(200));'}
        value={sql}
        onChange={e => setSql(e.target.value)}
      />
      <div className="flex items-center gap-2 mt-2">
        <Button size="sm" className="h-7 text-[11px] bg-cyan-600 hover:bg-cyan-500 text-white" onClick={run} disabled={running || !sql.trim()}>
          {running ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <ScanSearch className="w-3 h-3 mr-1" />}
          扫描风险
        </Button>
        {result && (
          <span className="text-[11px] text-[#8b8b9e]">
            高危 <span className="text-red-400">{result.summary.high}</span> / 中危 <span className="text-yellow-400">{result.summary.medium}</span> / 低危 <span className="text-green-400">{result.summary.low}</span>
          </span>
        )}
      </div>
      {error && <div className="mt-2 text-[11px] text-red-400">{error}</div>}
      {result && result.findings.length > 0 && (
        <div className="mt-2 space-y-1.5 max-h-40 overflow-y-auto">
          {result.findings.map((f, i) => (
            <div key={i} className="rounded-lg border border-[#252530] bg-[#0f0f14] px-2.5 py-2">
              <div className="flex items-center gap-2">
                <span className={cn('px-1.5 py-0.5 rounded border text-[10px] font-medium', riskColor(f.risk))}>{f.risk}风险</span>
                <span className="text-[11px] text-[#d8d8e5]">{f.rule_id} · {f.desc}</span>
              </div>
              {f.snippet && <div className="mt-1 text-[10px] font-mono text-[#8b8b9e] truncate">命中：{f.snippet}</div>}
              <div className="mt-0.5 text-[10px] text-indigo-300">改造建议：{f.suggest}</div>
            </div>
          ))}
        </div>
      )}
      {result && result.findings.length === 0 && (
        <div className="mt-2 text-[11px] text-green-400">✓ 未命中任何规则，语法兼容性良好（可交 LLM 做业务复核）</div>
      )}
    </div>
  )
}

/* ---- 资产详情节 ---- */
function AssetRow({ asset, expanded, onToggle }: { asset: MigrateAsset; expanded: boolean; onToggle: () => void }) {
  let findings: RuleFinding[] = []
  try { findings = JSON.parse(asset.incompatible_detail || '[]') as RuleFinding[] } catch { /* ignore */ }
  let rules: string[] = []
  try { rules = JSON.parse(asset.rule_ids || '[]') as string[] } catch { rules = [] }
  return (
    <div className="rounded-lg border border-[#252530] bg-[#16161e] overflow-hidden">
      <button className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/[0.02] text-left" onClick={onToggle}>
        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-[#5a5a70]" /> : <ChevronRight className="w-3.5 h-3.5 text-[#5a5a70]" />}
        <span className="text-[11px] text-[#8b8b9e] w-16 flex-shrink-0">{asset.asset_type}</span>
        <span className="text-[12px] font-mono text-[#e4e4e9] flex-1 truncate">{asset.asset_name}</span>
        <span className={cn('px-1.5 py-0.5 rounded border text-[10px] font-medium flex-shrink-0', riskColor(asset.risk_level))}>{asset.risk_level}</span>
        <span className="text-[10px] text-[#8b8b9e] w-16 flex-shrink-0 text-right">{asset.source === 'rule_engine' ? '规则引擎' : asset.source}</span>
        <span className={cn('text-[10px] w-12 text-right flex-shrink-0', asset.status === '已改造' ? 'text-green-400' : 'text-[#8b8b9e]')}>{asset.status}</span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t border-[#1e1e28] pt-2">
          <div className="space-y-1">
            <div className="text-[10px] text-[#8b8b9e]">不兼容点</div>
            {findings.length > 0 && (
              <div className="space-y-1">
                {findings.map((f, i) => (
                  <div key={i} className="text-[11px] text-[#d8d8e5]">· {f.rule_id} {f.desc} {f.snippet && <span className="text-[#8b8b9e] font-mono">（{f.snippet}）</span>}</div>
                ))}
              </div>
            )}
            {rules.length > 0 && <div className="text-[11px] text-cyan-300">命中规则：{rules.join('、')}</div>}
          </div>
          <div>
            <div className="text-[10px] text-[#8b8b9e] mb-0.5">原始 SQL</div>
            <pre className="rounded bg-[#0f0f14] border border-[#1e1e28] p-2 text-[10px] font-mono text-[#cdd3e0] overflow-x-auto whitespace-pre-wrap">{asset.original_sql || '—'}</pre>
          </div>
          {asset.converted_sql && (
            <div>
              <div className="text-[10px] text-[#8b8b9e] mb-0.5">转换 SQL（目标国产库）</div>
              <pre className="rounded bg-[#0a1f16] border border-[#143228] p-2 text-[10px] font-mono text-[#7ee2b8] overflow-x-auto whitespace-pre-wrap">{asset.converted_sql}</pre>
            </div>
          )}
          <div>
            <div className="text-[10px] text-[#8b8b9e] mb-0.5">改造建议</div>
            <div className="text-[11px] text-indigo-300">{asset.suggestion || '—'}</div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ---- 主面板 ---- */
export function MigratePanel() {
  const [tasks, setTasks] = useState<MigrateTask[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [detail, setDetail] = useState<MigrateTaskDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [statusFilter, setStatusFilter] = useState('')
  const [message, setMessage] = useState('')
  const [loadReport, setLoadReport] = useState(false)
  /** 阶段详情抽屉：当前打开的展示节点下标 */
  const [drawerStage, setDrawerStage] = useState<number | null>(null)

  const load = async () => {
    setLoading(true)
    const r = await api.listMigrateTasks(statusFilter ? { status: statusFilter } : {}).catch(e => ({ success: false, data: undefined }))
    if (r.success && r.data) {
      setTasks(r.data as MigrateTask[])
      if (r.data.length > 0 && (activeId == null || !r.data.some(t => t.task_id === activeId))) {
        setActiveId(r.data[0].task_id)
      } else if (r.data.length === 0) {
        setActiveId(null); setDetail(null)
      }
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [statusFilter])

  useEffect(() => {
    if (activeId == null) { setDetail(null); setDrawerStage(null); return }
    setBusy(true)
    api.getMigrateTask(activeId).then(r => {
      if (r.success && r.data) setDetail(r.data as MigrateTaskDetail)
    }).catch(() => setDetail(null)).finally(() => setBusy(false))
  }, [activeId])

  const stats = detail?.assets_stats
  // 执行锁：被其他会话占用 / 任务已完成 → 只读，禁用状态变更按钮
  const lockBusy = detail ? (!!detail.exec_lock?.locked || !!detail.exec_lock?.readonly) : false
  const doAdvance = async (params: Record<string, unknown>) => {
    if (activeId == null) return
    setBusy(true); setMessage('')
    const r: { success?: boolean; data?: { from: string; to: string; advanced: boolean; warning?: string }; error?: string } =
      await api.advanceMigrateTask(activeId, params).catch(e => ({ success: false, error: String(e) }))
    if (r.success && r.data) {
      setMessage(`状态机推进：${r.data.from} → ${r.data.to}${r.data.warning ? `，⚠️ ${r.data.warning}` : ''}`)
      const fresh = await api.getMigrateTask(activeId).catch(() => null)
      if (fresh?.success && fresh.data) setDetail(fresh.data as MigrateTaskDetail)
      load()
    } else {
      setMessage(r.error || '推进失败')
    }
    setBusy(false)
  }

  const doScan = async () => {
    if (activeId == null) return
    setBusy(true); setMessage('')
    const r: { success?: boolean; data?: { object_count: number; findings: number }; error?: string } =
      await api.scanMigrateTask(activeId).catch(e => ({ success: false, error: String(e) }))
    if (r.success && r.data) setMessage(`数据采集·对象扫描完成：${r.data.object_count} 个对象，规则命中 ${r.data.findings} 条，已写入结构化资产`)
    else setMessage(r.error || '扫描失败')
    const fresh = await api.getMigrateTask(activeId).catch(() => null)
    if (fresh?.success && fresh.data) setDetail(fresh.data as MigrateTaskDetail)
    load()
    setBusy(false)
  }

  /** 断点续跑：仅 ERROR 亮起；不从头重跑，恢复到可继续阶段 */
  const doResume = async () => {
    if (activeId == null) return
    if (!window.confirm('从当前异常节点继续执行？已采集参数与资产保留，不会从头重跑。')) return
    setBusy(true); setMessage('')
    const r: { success?: boolean; data?: MigrateTask; error?: string } =
      await api.resumeMigrateTask(activeId).catch(e => ({ success: false, error: String(e) }))
    if (r.success && r.data) setMessage(`断点续跑成功：已恢复到「${r.data.status_label || r.data.status}」，可继续推进`)
    else setMessage(r.error || '断点续跑失败')
    const fresh = await api.getMigrateTask(activeId).catch(() => null)
    if (fresh?.success && fresh.data) setDetail(fresh.data as MigrateTaskDetail)
    load()
    setBusy(false)
  }

  /** 重置任务：状态回 INIT，清空参数与资产（二次确认） */
  const doReset = async () => {
    if (activeId == null) return
    if (!window.confirm('确定重置该迁移任务？状态将回到「数据采集」，已采集参数与已生成资产全部清空。此操作不可恢复！')) return
    setBusy(true); setMessage('')
    const r: { success?: boolean; data?: MigrateTask; error?: string } =
      await api.resetMigrateTask(activeId).catch(e => ({ success: false, error: String(e) }))
    if (r.success && r.data) setMessage('任务已重置：回到 INIT「选择数据源」，可重新发起迁移')
    else setMessage(r.error || '重置失败')
    const fresh = await api.getMigrateTask(activeId).catch(() => null)
    if (fresh?.success && fresh.data) setDetail(fresh.data as MigrateTaskDetail)
    load()
    setBusy(false)
  }

  const doDelete = async () => {
    if (activeId == null) return
    if (!confirm('确认删除该迁移任务及其资产？')) return
    await api.deleteMigrateTask(activeId)
    setActiveId(null); setDetail(null); load()
  }

  const doExport = () => {
    if (activeId == null) return
    const a = document.createElement('a')
    a.href = api.exportMigrateExcel(activeId)
    a.download = `migrate_assets_${activeId}.xlsx`
    a.click()
  }

  const flowIdx = detail ? effectiveIdx(detail) : -1
  const nextStatus = detail && flowIdx >= 0 && flowIdx < BOARD_STAGES.length - 1
    ? BOARD_STAGES[flowIdx + 1].keys[0]
    : null

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Workflow className="w-4 h-4 text-indigo-400" />
          <h2 className="text-[15px] font-semibold text-[#e4e4e9]">数据库迁移评估（领域状态机）</h2>
          <span className="text-[11px] text-[#8b8b9e]">流程由后端硬编码控制，LLM 只负责对话与内容生成，无权跳转节点</span>
        </div>
        <div className="flex items-center gap-2">
          <Input
            className="h-7 w-36 text-[11px] bg-[#16161e] border-[#252530]"
            placeholder="状态筛选（如 FINISHED）"
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
          />
          <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={load}><RefreshCw className="w-3 h-3 mr-1" />刷新</Button>
        </div>
      </div>

      {message && (
        <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-3 py-2 text-[12px] text-indigo-200">{message}</div>
      )}

      {/* 迁移任务列表 */}
      <div className="rounded-xl border border-[#252530] bg-[#16161e] p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 text-[12px] font-medium text-[#e4e4e9]"><Database className="w-3.5 h-3.5 text-indigo-400" />迁移任务列表</div>
          <span className="text-[10px] text-[#4a4a5a]">{loading ? '加载中…' : `${tasks.length} 个任务`}</span>
        </div>
        {tasks.length === 0 && !loading ? (
          <div className="text-[12px] text-[#8b8b9e] py-3 text-center">暂无迁移任务。到会话中开启「数据库迁移/国产化」对话，状态机会自动创建任务。</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {tasks.map(t => (
              <button
                key={t.task_id}
                className={cn(
                  'rounded-lg border border-[#252530] bg-[#0f0f14] px-3 py-2 text-left hover:border-indigo-500/40 transition-colors',
                  activeId === t.task_id && 'border-indigo-500/60 bg-indigo-500/[0.06]',
                )}
                onClick={() => setActiveId(t.task_id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] text-[#e4e4e9] truncate">#{t.task_id} {t.task_name}</span>
                  <span className={cn(
                    'text-[10px] flex-shrink-0',
                    t.status === 'FINISHED' ? 'text-green-400' : t.status === 'ERROR' ? 'text-red-400' : 'text-indigo-300',
                  )}>{t.status_label || t.status}</span>
                </div>
                <div className="text-[10px] text-[#8b8b9e] mt-1 truncate">
                  {t.source_ds_name || '未选源'} → {t.target_db_type || '?'} ｜ {t.db_business_level || '-'} ｜ {t.object_count || 0} 对象
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 任务详情：头部 + 状态机看板 + 详情 */}
      {detail && (
        <div className="rounded-xl border border-[#252530] bg-[#16161e] p-3 space-y-3">
          {/* 任务头部：名称 | 状态 | 导出/重置/断点续跑 */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold text-[#e4e4e9]">任务 #{detail.task_id} · {detail.task_name}</span>
              <span className={cn(
                'px-2 py-0.5 rounded-full border text-[10px] font-medium',
                detail.status === 'FINISHED' ? 'text-green-400 border-green-500/30 bg-green-500/10'
                  : detail.status === 'ERROR' ? 'text-red-400 border-red-500/30 bg-red-500/10'
                    : 'text-indigo-300 border-indigo-500/30 bg-indigo-500/10',
              )}>{detail.status_label || detail.status}</span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {/* 断点续跑：仅 ERROR 亮起；被锁占用时（理论上 ERROR 已释放锁）仍允许抢占 */}
              {detail.status === 'ERROR' && (
                <Button size="sm" className="h-7 text-[11px] bg-red-600 hover:bg-red-500 text-white" onClick={doResume} disabled={busy} title="任务异常中断支持断点续跑，从当前节点继续，不从头重跑">
                  <RotateCw className="w-3 h-3 mr-1" />断点续跑
                </Button>
              )}
              <Button size="sm" className="h-7 text-[11px] bg-indigo-600 hover:bg-indigo-500 text-white" onClick={doExport} disabled={!stats || stats.total === 0} title="导出资产清单 Excel（含风险/转换SQL/建议）">
                <FileSpreadsheet className="w-3 h-3 mr-1" />导出资产清单
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-[11px] text-amber-400 hover:text-white hover:border-amber-500/40" onClick={doReset} disabled={busy || lockBusy} title="重置整个任务：状态回 INIT，清空已采集参数与资产（二次确认）">
                <RotateCw className="w-3 h-3 mr-1" />重置任务
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-[11px] text-red-400 hover:text-white hover:border-red-500/40" onClick={doDelete} title="删除任务">
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          </div>

          {/* 状态机看板（任务总状态流转，主入口） */}
          <StateBoard detail={detail} onOpenStage={setDrawerStage} />

          {/* 参数信息 */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
            <Info label="源数据源" value={detail.source_ds_name || detail.source_ds_id || '未选择'} />
            <Info label="源库类型" value={detail.source_db_type || '—'} />
            <Info label="目标国产库" value={detail.target_db_type || '—'} />
            <Info label="业务等级" value={detail.db_business_level || '—'} />
            <Info label="库容量" value={detail.db_capacity || '—'} />
            <Info label="停机窗口" value={detail.stop_window || '—'} />
            <Info label="扫描对象数" value={String(detail.object_count || 0)} />
            <Info label="资产风险（高/中/低）" value={stats ? `${stats.high}/${stats.medium}/${stats.low}` : '0/0/0'} />
          </div>

          {/* 操作按钮：被锁占有时全部状态变更按钮置灰（只读） */}
          <div className="flex items-center gap-2 flex-wrap">
            {lockBusy && (
              <span className="text-[11px] text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-2.5 py-1.5">
                ⚠️ 任务执行中（操作人：{detail.exec_lock?.owner_user_id || detail.exec_lock?.session_id || '其他会话'}）｜只读模式，状态变更按钮已禁用
              </span>
            )}
            {nextStatus && (
              <Button size="sm" className="h-7 text-[11px]" onClick={() => doAdvance({ task_confirm: '继续' })} disabled={busy || lockBusy}>
                <Play className="w-3 h-3 mr-1" />确认并推进到 {MIGRATE_STATUS_LABEL[nextStatus]}
              </Button>
            )}
            <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={doScan} disabled={busy || lockBusy}>
              <ScanSearch className="w-3 h-3 mr-1" />扫描对象并生成资产
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={() => setLoadReport(v => !v)}>
              <Boxes className="w-3 h-3 mr-1" />{loadReport ? '收起' : '生成'}报告预览
            </Button>
          </div>

          {/* 报告预览 */}
          {loadReport && <ReportPreview taskId={activeId!} />}

          {/* 资产清单 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[12px] font-medium text-[#e4e4e9]">结构化资产清单（{stats?.total || 0} 项）— 机器可读、可溯源、可导出 Excel</span>
            </div>
            {detail.assets.length === 0 ? (
              <div className="text-[11px] text-[#8b8b9e] py-3 text-center">暂无资产。点击「扫描对象并生成资产」由规则引擎自动打风险标签入库。</div>
            ) : (
              <div className="space-y-1.5">
                {detail.assets.map(a => (
                  <AssetRow key={a.id} asset={a} expanded={expanded === a.id} onToggle={() => setExpanded(expanded === a.id ? null : a.id)} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 任务流程静态表（页面可编排，状态机按此表驱动） */}
      <FlowBoard />

      {/* 规则引擎 */}
      <RuleScanBox onStatsChange={() => { /* 扫描结果已就地展示 */ }} />

      {/* 阶段详情抽屉 */}
      {detail && drawerStage != null && (
        <StageDrawer detail={detail} stageIdx={drawerStage} onClose={() => setDrawerStage(null)} />
      )}
    </div>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[#1e1e28] bg-[#0f0f14] px-2.5 py-1.5">
      <div className="text-[9px] text-[#5a5a70]">{label}</div>
      <div className="text-[11.5px] text-[#d8d8e5] truncate mt-0.5" title={value}>{value}</div>
    </div>
  )
}

function ReportPreview({ taskId }: { taskId: number }) {
  const [md, setMd] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    setLoading(true)
    api.getMigrateReport(taskId).then(r => setMd(r.success && r.data ? r.data.markdown : '（暂无报告）')).finally(() => setLoading(false))
  }, [taskId])
  return (
    <div className="rounded-lg border border-[#252530] bg-[#0f0f14] p-3">
      <div className="text-[11px] text-[#8b8b9e] mb-2">报告由结构化资产自动渲染生成（模板渲染，LLM 只填充业务描述）</div>
      {loading ? <div className="text-[11px] text-[#8b8b9e]">加载中…</div> : (
        <pre className="text-[10.5px] leading-relaxed font-mono text-[#cdd3e0] whitespace-pre-wrap max-h-72 overflow-y-auto">{md}</pre>
      )}
    </div>
  )
}