export interface FileLocation {
  path: string
  line?: number
}

/** 识别常见工程文件引用：path、path:12、path#L12。协议地址和块级代码不视为文件位置。 */
export function parseFileLocation(raw: string): FileLocation | null {
  const value = String(raw || '').trim().replace(/^["'`]|["'`]$/g, '')
  if (!value || /^\w+:\/\//i.test(value) || value.includes('\n')) return null

  const lineMatch = value.match(/(?::L?(\d{1,7})|#L(\d{1,7}))$/)
  const line = Number(lineMatch?.[1] || lineMatch?.[2] || 0)
  const path = value.slice(0, value.length - (lineMatch?.[0].length || 0))
  const match = path.match(
    /^(?:(?:\/|[A-Za-z]:\\)?[\w.@+-]+(?:[\\/][\w.@+-]+)*)\.[A-Za-z][A-Za-z0-9]{0,14}$/,
  )
  if (!match) return null
  return line > 0 ? { path, line } : { path }
}
