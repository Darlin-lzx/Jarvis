/** 工作流模板 SQL 导出：XML 按 4000 字符（UTF-8 码点）拆块填入 content..content15。 */

export const CONTENT_CHUNK_SIZE = 4000
export const CONTENT_CHUNK_COUNT = 16
export const CONTENT_COLUMNS = [
  '"content"',
  ...Array.from({ length: CONTENT_CHUNK_COUNT - 1 }, (_, index) => `content${index + 1}`),
]

export const WORKFLOW_TABLE = 'aif_comframe.vm_template_version'

/** 按码点切分，不切断多字节字符与代理对。 */
export function chunkXmlContent(xml: string, size = CONTENT_CHUNK_SIZE): string[] {
  const chars = Array.from(xml)
  const chunks: string[] = []
  for (let i = 0; i < chars.length; i += size) {
    chunks.push(chars.slice(i, i + size).join(''))
  }
  return chunks
}

function sqlString(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}

export interface WorkflowSqlExportInput {
  templateVersionId: string
  orderNum: string
  templateTag: string
  createStaffId: string
  createDate: string
  modifyDesc: string
  validDate: string
  expireDate: string
  xml: string
  /** 目标表名，默认远端 aif_comframe 前缀；jarvis 本地库为 vm_template_version */
  table?: string
}

export type WorkflowSqlExportResult = { sql: string } | { error: string }

export function buildWorkflowInsertSql(input: WorkflowSqlExportInput): WorkflowSqlExportResult {
  const tag = input.templateTag.trim()
  if (!tag) return { error: 'template_tag 不能为空' }
  const xml = input.xml
  if (!xml.trim()) return { error: 'XML 内容为空' }
  const chunks = chunkXmlContent(xml)
  if (chunks.length > CONTENT_CHUNK_COUNT) {
    const total = Array.from(xml).length
    return { error: `XML 共 ${total} 字符，超过 ${CONTENT_CHUNK_COUNT * CONTENT_CHUNK_SIZE} 字符（${CONTENT_CHUNK_COUNT} × ${CONTENT_CHUNK_SIZE}）存储上限` }
  }

  const head = [
    input.templateVersionId.trim(),
    input.orderNum.trim() || '0',
    sqlString(tag),
    sqlString(input.createStaffId.trim()),
    sqlString(input.createDate),
    sqlString(input.modifyDesc),
    sqlString(input.validDate),
    sqlString(input.expireDate),
  ]
  const nulls = Array.from(
    { length: CONTENT_CHUNK_COUNT - chunks.length },
    () => 'NULL',
  )
  const columns = [
    'template_version_id', 'order_num', 'template_tag', 'create_staff_id',
    'create_date', 'modify_desc', 'valid_date', 'expire_date',
    ...CONTENT_COLUMNS,
  ].join(',')

  const chunkLine = chunks.map(sqlString).join(',\n') + (nulls.length > 0 ? ',' : '')
  const lines = [
    `INSERT INTO ${input.table?.trim() || WORKFLOW_TABLE} (${columns}) VALUES`,
    `\t(${head.join(',')},`,
    chunkLine,
  ]
  lines.push(nulls.length > 0 ? `${nulls.join(',\n')});` : ');')
  return { sql: `${lines.join('\n')}\n` }
}

function pad(value: number, length = 2) {
  return String(value).padStart(length, '0')
}

/** 'YYYY-MM-DD HH:mm:ss.SSS'，与库内既有时间格式一致。 */
export function formatSqlDateTime(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

/** 'YYYY-MM-DD 00:00:00.000' */
export function formatSqlDate(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} 00:00:00.000`
}
