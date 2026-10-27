/** 轻量 XML token 树编辑器：文本/属性保留原文片段，未编辑部分序列化后逐字节不变。
 *  无 DOM 依赖，浏览器与 Node 测试共用同一份实现。 */

export interface XmlAttribute {
  name: string
  value: string
}

export interface XmlElement {
  kind: 'element'
  name: string
  attributes: XmlAttribute[]
  children: XmlNode[]
  selfClosing: boolean
  parent: XmlElement | null
}

export interface XmlTextNode {
  kind: 'text'
  raw: string
}

export interface XmlMiscNode {
  kind: 'misc'
  raw: string
}

export type XmlNode = XmlElement | XmlTextNode | XmlMiscNode

export interface XmlDocument {
  nodes: XmlNode[]
  root: XmlElement | null
}

export function parseXmlDocument(content: string): XmlDocument {
  const doc: XmlDocument = { nodes: [], root: null }
  const stack: XmlElement[] = []
  let pos = 0

  const pushNode = (node: XmlNode) => {
    const parent = stack[stack.length - 1]
    if (parent) {
      parent.children.push(node)
    } else {
      doc.nodes.push(node)
      if (node.kind === 'element' && doc.root === null) doc.root = node
    }
  }

  while (pos < content.length) {
    const lt = content.indexOf('<', pos)
    if (lt === -1) {
      pushNode({ kind: 'text', raw: content.slice(pos) })
      break
    }
    if (lt > pos) pushNode({ kind: 'text', raw: content.slice(pos, lt) })
    if (content.startsWith('<!--', lt)) {
      const end = content.indexOf('-->', lt + 4)
      if (end === -1) throw new Error('XML 解析失败: 注释未闭合')
      pushNode({ kind: 'misc', raw: content.slice(lt, end + 3) })
      pos = end + 3
      continue
    }
    if (content.startsWith('<?', lt)) {
      const end = content.indexOf('?>', lt + 2)
      if (end === -1) throw new Error('XML 解析失败: 处理指令未闭合')
      pushNode({ kind: 'misc', raw: content.slice(lt, end + 2) })
      pos = end + 2
      continue
    }
    if (content.startsWith('<!', lt)) {
      const end = content.indexOf('>', lt + 2)
      if (end === -1) throw new Error('XML 解析失败: DOCTYPE 未闭合')
      pushNode({ kind: 'misc', raw: content.slice(lt, end + 1) })
      pos = end + 1
      continue
    }
    if (content.startsWith('</', lt)) {
      const end = content.indexOf('>', lt + 2)
      if (end === -1) throw new Error('XML 解析失败: 闭合标签格式无效')
      const name = content.slice(lt + 2, end).trim()
      const current = stack.pop()
      if (!current || current.name !== name) {
        throw new Error(`XML 解析失败: 闭合标签 </${name}> 与 <${current?.name ?? '?'}> 不匹配`)
      }
      pos = end + 1
      continue
    }

    pos = lt + 1
    const nameMatch = /^[^\s/>]+/.exec(content.slice(pos))
    if (!nameMatch) throw new Error('XML 解析失败: 标签名格式无效')
    const name = nameMatch[0]
    pos += name.length
    const element: XmlElement = {
      kind: 'element', name, attributes: [], children: [], selfClosing: false, parent: null,
    }
    let closed = false
    while (pos < content.length) {
      while (pos < content.length && /\s/.test(content[pos])) pos += 1
      if (content.startsWith('/>', pos)) {
        element.selfClosing = true
        pos += 2
        closed = true
        break
      }
      if (content[pos] === '>') {
        pos += 1
        closed = true
        break
      }
      const attrNameMatch = /^[^\s=/>]+/.exec(content.slice(pos))
      if (!attrNameMatch) throw new Error(`XML 解析失败: <${name}> 属性格式无效`)
      const attrName = attrNameMatch[0]
      pos += attrName.length
      while (pos < content.length && /\s/.test(content[pos])) pos += 1
      if (content[pos] !== '=') throw new Error(`XML 解析失败: 属性 ${attrName} 缺少取值`)
      pos += 1
      while (pos < content.length && /\s/.test(content[pos])) pos += 1
      const quote = content[pos]
      if (quote !== '"' && quote !== "'") {
        throw new Error(`XML 解析失败: 属性 ${attrName} 取值未加引号`)
      }
      pos += 1
      const valueEnd = content.indexOf(quote, pos)
      if (valueEnd === -1) throw new Error(`XML 解析失败: 属性 ${attrName} 取值未闭合`)
      element.attributes.push({ name: attrName, value: content.slice(pos, valueEnd) })
      pos = valueEnd + 1
    }
    if (!closed) throw new Error(`XML 解析失败: <${name}> 标签未闭合`)

    element.parent = stack[stack.length - 1] ?? null
    pushNode(element)
    if (!element.selfClosing) stack.push(element)
  }

  if (stack.length > 0) {
    throw new Error(`XML 解析失败: 缺少闭合标签 </${stack[stack.length - 1].name}>`)
  }
  if (doc.root === null) throw new Error('XML 解析失败: 缺少根元素')
  return doc
}

function serializeNode(node: XmlNode): string {
  if (node.kind === 'text' || node.kind === 'misc') return node.raw
  const attrs = node.attributes.map(attr => ` ${attr.name}="${attr.value}"`).join('')
  if (node.selfClosing) return `<${node.name}${attrs} />`
  if (node.children.length === 0) return `<${node.name}${attrs}></${node.name}>`
  return `<${node.name}${attrs}>${node.children.map(serializeNode).join('')}</${node.name}>`
}

export function serializeXmlDocument(doc: XmlDocument): string {
  return doc.nodes.map(serializeNode).join('')
}

export function escapeXmlText(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function escapeXmlAttr(value: string) {
  return escapeXmlText(value).replace(/"/g, '&quot;')
}

export function unescapeXmlValue(raw: string) {
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => safeCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
}

function safeCodePoint(code: number) {
  try {
    return String.fromCodePoint(code)
  } catch {
    return `&#${code};`
  }
}

export function childElements(element: XmlElement, name?: string): XmlElement[] {
  return element.children.filter((child): child is XmlElement =>
    child.kind === 'element' && (name === undefined || child.name === name))
}

export function getAttributeValue(element: XmlElement, name: string): string | null {
  const attr = element.attributes.find(item => item.name === name)
  return attr ? attr.value : null
}

export function getAttributeDecoded(element: XmlElement, name: string): string {
  const raw = getAttributeValue(element, name)
  return raw === null ? '' : unescapeXmlValue(raw)
}

export function setAttributeValue(element: XmlElement, name: string, value: string) {
  const attr = element.attributes.find(item => item.name === name)
  if (attr) attr.value = value
  else element.attributes.push({ name, value })
}

export function getElementText(element: XmlElement): string {
  return element.children
    .filter((child): child is XmlTextNode => child.kind === 'text')
    .map(child => child.raw)
    .join('')
    .trim()
}

export function setElementText(element: XmlElement, text: string) {
  element.children = text === '' ? [] : [{ kind: 'text', raw: text }]
  element.selfClosing = false
}

export function createElement(name: string, attributes: XmlAttribute[] = []): XmlElement {
  return { kind: 'element', name, attributes, children: [], selfClosing: true, parent: null }
}

function textNode(raw: string): XmlTextNode {
  return { kind: 'text', raw }
}

/** 新子元素的缩进：参考父元素既有子元素的换行空白，缺省退化为 4 空格层级。 */
function childIndent(parent: XmlElement): string {
  const elementIndex = findLastElementIndex(parent)
  if (elementIndex > 0) {
    const prev = parent.children[elementIndex - 1]
    if (prev.kind === 'text') {
      const match = /\n([ \t]*)$/.exec(prev.raw)
      if (match) return `\n${match[1]}`
    }
  }
  const depth = elementDepth(parent)
  return `\n${'    '.repeat(depth)}`
}

function findLastElementIndex(parent: XmlElement): number {
  for (let i = parent.children.length - 1; i >= 0; i -= 1) {
    if (parent.children[i].kind === 'element') return i
  }
  return -1
}

function elementDepth(element: XmlElement): number {
  let depth = 1
  let current = element.parent
  while (current) {
    depth += 1
    current = current.parent
  }
  return depth
}

/** 在末尾收尾空白之前追加新元素（自动带缩进文本）。 */
export function appendElement(parent: XmlElement, element: XmlElement) {
  const indent = childIndent(parent)
  let insertAt = parent.children.length
  while (insertAt > 0) {
    const child = parent.children[insertAt - 1]
    if (child.kind === 'text' && /^\s*$/.test(child.raw)) {
      insertAt -= 1
      continue
    }
    break
  }
  parent.children.splice(insertAt, 0, textNode(indent), element)
  element.parent = parent
}

/** 在参考元素之后插入新元素（复用参考元素前面的缩进）。 */
export function insertAfterElement(reference: XmlElement, element: XmlElement) {
  const parent = reference.parent
  if (!parent) throw new Error('XML 编辑失败: 参考元素没有父节点')
  const index = parent.children.indexOf(reference)
  if (index === -1) throw new Error('XML 编辑失败: 参考元素不在父节点内')
  const prev = parent.children[index - 1]
  const indent = prev && prev.kind === 'text' && /\n/.test(prev.raw) ? prev.raw : childIndent(parent)
  parent.children.splice(index + 1, 0, textNode(indent), element)
  element.parent = parent
}

export function removeElement(element: XmlElement) {
  const parent = element.parent
  if (!parent) throw new Error('XML 编辑失败: 根节点不能删除')
  const index = parent.children.indexOf(element)
  if (index === -1) return
  parent.children.splice(index, 1)
  element.parent = null
}

function requireRoot(doc: XmlDocument): XmlElement {
  if (!doc.root) throw new Error('XML 编辑失败: 缺少根元素')
  return doc.root
}

export function findTaskElement(doc: XmlDocument, taskId: string): XmlElement | null {
  const root = doc.root
  if (!root) return null
  return childElements(root, 'task').find(task => getAttributeValue(task, 'id') === taskId) ?? null
}

function requireTask(doc: XmlDocument, taskId: string): XmlElement {
  const task = findTaskElement(doc, taskId)
  if (!task) throw new Error(`XML 编辑失败: 节点不存在 ${taskId}`)
  return task
}

function geometryJson(x: number, y: number, width: number, height: number) {
  return JSON.stringify({
    x: Math.round(x), y: Math.round(y),
    width: Math.round(width), height: Math.round(height),
  })
}

/** 移动节点：改写（或补插）对应 task 的 <uiinfo> 坐标。 */
export function moveTaskElement(
  doc: XmlDocument, taskId: string,
  x: number, y: number, width: number, height: number,
) {
  const task = requireTask(doc, taskId)
  let uiinfo = childElements(task, 'uiinfo')[0]
  if (!uiinfo) {
    uiinfo = createElement('uiinfo')
    task.children.unshift(uiinfo)
    uiinfo.parent = task
  }
  setElementText(uiinfo, geometryJson(x, y, width, height))
}

export function setTaskLabel(doc: XmlDocument, taskId: string, label: string) {
  setAttributeValue(requireTask(doc, taskId), 'label', escapeXmlAttr(label))
}

export interface WorkflowServiceInput {
  runtype: string
  crossCenter: boolean
  centercode: string
  servicecode: string
  servicename: string
}

function ensureChildText(parent: XmlElement, name: string, text: string) {
  let child = childElements(parent, name)[0]
  if (!child) {
    child = createElement(name)
    appendElement(parent, child)
    parent.selfClosing = false
  }
  setElementText(child, text === '' ? '' : escapeXmlText(text))
  if (text === '') child.selfClosing = true
}

export function setTaskService(doc: XmlDocument, taskId: string, service: WorkflowServiceInput) {
  const task = requireTask(doc, taskId)
  let autodeal = childElements(task, 'autodeal')[0]
  if (!autodeal) {
    autodeal = createElement('autodeal')
    appendElement(task, autodeal)
  }
  ensureChildText(autodeal, 'runtype', service.runtype)
  ensureChildText(autodeal, 'crossCenter', service.crossCenter ? 'true' : 'false')
  ensureChildText(autodeal, 'centercode', service.centercode)
  ensureChildText(autodeal, 'servicecode', service.servicecode)
  ensureChildText(autodeal, 'servicename', service.servicename)
}

const TASK_TYPES = ['csf_start', 'csf_finish', 'fork', 'and', 'csf_service', 'csf_auto', 'decision', 'shell']

export function taskTypeOptions() {
  return TASK_TYPES
}

export function addTaskElement(
  doc: XmlDocument,
  options: { id: string; label: string; tasktype: string; x: number; y: number; width: number; height: number },
) {
  const root = requireRoot(doc)
  if (!TASK_TYPES.includes(options.tasktype)) {
    throw new Error(`XML 编辑失败: 未知节点类型 ${options.tasktype}`)
  }
  if (findTaskElement(doc, options.id)) throw new Error(`XML 编辑失败: 节点 id 已存在 ${options.id}`)
  const task = createElement('task', [
    { name: 'id', value: options.id },
    { name: 'label', value: escapeXmlAttr(options.label) },
    { name: 'tasktype', value: options.tasktype },
    { name: 'tasktag', value: '' },
  ])
  task.selfClosing = false

  const uiinfo = createElement('uiinfo')
  setElementText(uiinfo, geometryJson(options.x, options.y, options.width, options.height))
  const autodeal = createElement('autodeal')
  autodeal.selfClosing = false
  ensureChildText(autodeal, 'runtype', 'csfService')
  ensureChildText(autodeal, 'crossCenter', 'false')
  ensureChildText(autodeal, 'centercode', '')
  ensureChildText(autodeal, 'servicecode', '')
  ensureChildText(autodeal, 'servicename', '')

  const innerIndent = `${childIndent(root).slice(1)}    `
  task.children.push(uiinfo, textNode(`\n${innerIndent}`), autodeal, textNode(`\n${innerIndent}`))
  appendElement(root, task)
  return task
}

/** 删除节点，并清理其他 task 中指向它的 gotoitem 与相关 join 连线。 */
export function deleteTaskElement(doc: XmlDocument, taskId: string) {
  const root = requireRoot(doc)
  const task = requireTask(doc, taskId)
  removeElement(task)
  for (const other of childElements(root, 'task')) {
    if (other === task) continue
    for (const gotoItem of childElements(other, 'gotoitem')) {
      if (getAttributeValue(gotoItem, 'goto') === taskId) removeElement(gotoItem)
    }
  }
  for (const join of childElements(root, 'join')) {
    if (getAttributeValue(join, 'taska') === taskId || getAttributeValue(join, 'taskb') === taskId) {
      removeElement(join)
    }
  }
}

/** 新增连线：在源 task 内追加 <gotoitem goto="target"/>，已存在则跳过。 */
export function addGotoItem(doc: XmlDocument, sourceId: string, targetId: string) {
  const source = requireTask(doc, sourceId)
  requireTask(doc, targetId)
  const existing = childElements(source, 'gotoitem')
  if (existing.some(item => getAttributeValue(item, 'goto') === targetId)) return false
  const gotoItem = createElement('gotoitem', [{ name: 'goto', value: targetId }])
  if (existing.length > 0) {
    insertAfterElement(existing[existing.length - 1], gotoItem)
  } else {
    appendElement(source, gotoItem)
  }
  return true
}

export function deleteGotoItem(doc: XmlDocument, sourceId: string, targetId: string) {
  const source = requireTask(doc, sourceId)
  const item = childElements(source, 'gotoitem')
    .find(element => getAttributeValue(element, 'goto') === targetId)
  if (!item) return false
  removeElement(item)
  return true
}

export function deleteJoinElement(doc: XmlDocument, sourceId: string, targetId: string) {
  const root = requireRoot(doc)
  const join = childElements(root, 'join')
    .find(element => getAttributeValue(element, 'taska') === sourceId
      && getAttributeValue(element, 'taskb') === targetId)
  if (!join) return false
  removeElement(join)
  return true
}

export interface WorkflowLinkInput {
  direction: string
  left: string
  right: string
  defaultValue: string
  dataType: string
}

function listLinkElements(task: XmlElement): XmlElement[] {
  return childElements(childElements(task, 'relationship')[0] ?? createElement('x'), 'task_')
    .flatMap(holder => childElements(holder, 'link'))
}

function requireLinkHolder(doc: XmlDocument, taskId: string): XmlElement {
  const task = requireTask(doc, taskId)
  let relationship = childElements(task, 'relationship')[0]
  if (!relationship) {
    relationship = createElement('relationship')
    relationship.selfClosing = false
    appendElement(task, relationship)
  }
  let holder = childElements(relationship, 'task_')[0]
  if (!holder) {
    holder = createElement('task_')
    holder.selfClosing = false
    appendElement(relationship, holder)
  }
  return holder
}

function applyLinkValues(link: XmlElement, input: WorkflowLinkInput) {
  setAttributeValue(link, 'name', escapeXmlAttr(input.direction))
  const children: XmlNode[] = []
  const indent = childIndent(link)
  const innerIndent = `${indent.slice(1)}    `
  const pushTextElement = (name: string, value: string, attrs: XmlAttribute[] = []) => {
    const element = createElement(name, attrs)
    if (value !== '') setElementText(element, escapeXmlText(value))
    children.push(textNode(innerIndent), element)
  }
  pushTextElement('left', input.left)
  pushTextElement('right', input.right)
  if (input.defaultValue !== '') {
    pushTextElement('defaultValue', input.defaultValue,
      input.dataType ? [{ name: 'dataType', value: escapeXmlAttr(input.dataType) }] : [])
  }
  children.push(textNode(indent))
  link.children = children
  link.selfClosing = false
}

export function addTaskLink(doc: XmlDocument, taskId: string, input: WorkflowLinkInput) {
  const holder = requireLinkHolder(doc, taskId)
  const link = createElement('link')
  applyLinkValues(link, input)
  appendElement(holder, link)
}

/** 整组替换节点的参数映射（编辑器统一保存用）：清空后按入参顺序重建。 */
export function setTaskLinks(doc: XmlDocument, taskId: string, inputs: WorkflowLinkInput[]) {
  const holder = requireLinkHolder(doc, taskId)
  holder.children = []
  holder.selfClosing = false
  for (const input of inputs) {
    const link = createElement('link')
    applyLinkValues(link, input)
    appendElement(holder, link)
  }
}

export function updateTaskLink(doc: XmlDocument, taskId: string, index: number, input: WorkflowLinkInput) {
  const task = requireTask(doc, taskId)
  const links = listLinkElements(task)
  const link = links[index]
  if (!link) throw new Error(`XML 编辑失败: 参数映射不存在 ${taskId}#${index}`)
  applyLinkValues(link, input)
}

export function deleteTaskLink(doc: XmlDocument, taskId: string, index: number) {
  const task = requireTask(doc, taskId)
  const link = listLinkElements(task)[index]
  if (!link) throw new Error(`XML 编辑失败: 参数映射不存在 ${taskId}#${index}`)
  removeElement(link)
}
