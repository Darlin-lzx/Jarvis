import { useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import { Copy, Check } from 'lucide-react'

/* 关键词高亮词表：数据库类型 + 技术栈关键词（较长词在前，避免短词先命中） */
const KEYWORDS = [
  'SQL Server', 'KingbaseES', '人大金仓', 'GaussDB', 'openGauss', 'OceanBase',
  'PostgreSQL', 'Oracle', '达梦', 'MySQL', 'JDBC', 'MyBatis-Plus', 'MyBatis', 'Hibernate',
]

/** 把普通文本按关键词切分并高亮（大小写不敏感） */
export function splitByKeywords(text: string): ReactNode[] {
  if (!text) return [text]
  const nodes: ReactNode[] = []
  let pos = 0
  let key = 0
  while (pos < text.length) {
    let matchAt = -1
    let matchLen = 0
    for (let i = 0; i < KEYWORDS.length; i++) {
      const idx = text.toLowerCase().indexOf(KEYWORDS[i].toLowerCase(), pos)
      if (idx === -1) continue
      if (matchAt === -1 || idx < matchAt || (idx === matchAt && KEYWORDS[i].length > matchLen)) {
        matchAt = idx
        matchLen = KEYWORDS[i].length
      }
    }
    if (matchAt === -1) {
      nodes.push(text.slice(pos))
      break
    }
    if (matchAt > pos) nodes.push(text.slice(pos, matchAt))
    nodes.push(
      <mark key={key++} className="rounded bg-cyan-500/15 text-cyan-200 px-0.5 py-[1px] font-medium">
        {text.slice(matchAt, matchAt + matchLen)}
      </mark>,
    )
    pos = matchAt + matchLen
  }
  return nodes
}

/** ReactMarkdown text 渲染器：仅作用于纯文本节点，不影响代码块/行内代码 */
export function keywordTextRenderer(props: { children?: unknown }) {
  return <>{splitByKeywords(String(props.children ?? ''))}</>
}

/* @Agent 提及正则（@+非空白序列，避开中文标点/括号边界） */
const MENTION_RE = /(@[^\s@，,。；;：:（）()]+)/g

/** 文本高亮：先切分 @提及（蓝色高亮），剩余片段再做关键字高亮 */
export function highlightText(text: string): ReactNode[] {
  if (!text) return [text]
  const nodes: ReactNode[] = []
  const parts = String(text).split(MENTION_RE)
  parts.forEach((part, i) => {
    if (!part) return
    if (part.startsWith('@') && part.length > 1) {
      nodes.push(
        <span
          key={`m-${i}`}
          className="rounded bg-sky-500/15 text-sky-300 px-0.5 py-[1px] font-medium cursor-pointer select-none hover:bg-sky-500/25 hover:text-sky-200 transition-colors"
          title={part.slice(1)}
        >
          {part}
        </span>,
      )
    } else {
      nodes.push(<span key={`k-${i}`}>{splitByKeywords(part)}</span>)
    }
  })
  return nodes
}

/** ReactMarkdown text 渲染器（含 @提及 高亮，仅作用纯文本节点） */
export function mentionTextRenderer(props: { children?: unknown }) {
  return <>{highlightText(String(props.children ?? ''))}</>
}

/* 提取代码块纯文本 */
export function extractCodeText(node: unknown): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractCodeText).join('')
  if (typeof node === 'object') {
    const anyNode = node as { props?: { children?: unknown } }
    if (anyNode.props && anyNode.props.children != null) return extractCodeText(anyNode.props.children)
  }
  return ''
}

/* 代码块：行内代码原样，块级代码带复制按钮 + 语言标签 */
function CodeBlock(props: any) {
  const [copied, setCopied] = useState(false)
  const { node, children, className, inline, ...rest } = props
  const lang = (className || (node?.properties?.className as string | undefined) || '') || ''
  const codeText = extractCodeText(children).replace(/\n$/, '')

  if (inline) {
    return (
      <code
        {...rest}
        className="px-1.5 py-0.5 rounded-md bg-[#1a1a24] border border-[#252530] text-[12.5px] font-mono text-cyan-300"
      >
        {children}
      </code>
    )
  }

  const copy = async () => {
    await navigator.clipboard.writeText(codeText)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="relative group/code my-3">
      <pre
        {...rest}
        className="text-[12.5px] leading-relaxed bg-[#12121a] border border-[#252530] rounded-lg p-4 pt-9 overflow-x-auto whitespace-pre-wrap break-words"
      >
        {children}
      </pre>
      {lang && (
        <div className="absolute top-2 left-3 text-[10px] text-[#5a5a70] font-mono">
          {lang.replace('language-', '')}
        </div>
      )}
      <div className="absolute top-2 right-2 opacity-0 group-hover/code:opacity-100 transition-opacity">
        <button
          className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-[#1a1a24] border border-[#252530] text-[#9a9aa4] hover:text-indigo-400 transition-colors"
          onClick={copy}
          title="复制代码"
        >
          {copied ? <Check className="w-2.5 h-2.5" /> : <Copy className="w-2.5 h-2.5" />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
    </div>
  )
}

const mdComponents = {
  pre: (props: any) => <CodeBlock {...props} />,
  text: keywordTextRenderer,
}

/** 结构化 Markdown 渲染：标题加粗 / 列表 / 代码块复制 / 关键词高亮 */
export function MdRender({ content }: { content: string }) {
  return (
    <div className="prose prose-invert prose-sm max-w-none text-[13px] leading-relaxed [&_h1]:text-[15px] [&_h2]:text-[14px] [&_h3]:text-[13px] [&_ul]:my-2 [&_ol]:my-2 [&_p]:my-2">
      <ReactMarkdown components={mdComponents}>{content}</ReactMarkdown>
    </div>
  )
}

/** 引导消息检测：命中「能力介绍 / 我能做什么 / 需要你提供」等即视为空会话引导 */
export function isGuidanceMessage(content: string): boolean {
  const c = content || ''
  return /能力介绍|我能做什么|我能帮你|我可以帮你|可以帮你完成|需要你提供|请提供以下信息|帮我完成数据库/.test(c)
}