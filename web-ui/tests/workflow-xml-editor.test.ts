import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseXmlDocument, serializeXmlDocument,
  findTaskElement, moveTaskElement, setTaskLabel, setTaskService,
  addTaskElement, deleteTaskElement, addGotoItem, deleteGotoItem, deleteJoinElement,
  addTaskLink, updateTaskLink, deleteTaskLink, setTaskLinks,
  childElements, getElementText, getAttributeDecoded, escapeXmlAttr,
} from '../src/components/workbench/workflow-xml-editor.ts'

const XML = `<?xml version="1.0" encoding="GBK" ?>
<workflow label="测试调度" tasktag="demo.tag" tasktype="workflow" owntype="CSF">
  <description>测试描述</description>
  <vars name="custOrderId" datatype="long" />
  <join id="flow2" name="flow2" taska="6" taskb="5" />
  <task id="3" label="开始节点" tasktype="csf_start">
    <uiinfo>10,20,30,29</uiinfo>
    <gotoitem goto="6" />
  </task>
  <task id="6" label="Fork" tasktype="fork">
    <uiinfo>5,60,30,30</uiinfo>
    <gotoitem goto="5" />
  </task>
  <task id="5" label="业务流程" tasktype="csf_service">
    <uiinfo>0,120,120,60</uiinfo>
    <autodeal>
      <runtype>csfService</runtype>
      <crossCenter>false</crossCenter>
      <centercode>ord</centercode>
      <servicecode>demo_service</servicecode>
      <servicename>startWorkflow</servicename>
    </autodeal>
    <relationship>
      <task_>
        <link name="IN">
          <left>custOrderId</left>
          <right>custOrderId</right>
        </link>
      </task_>
    </relationship>
  </task>
</workflow>`

test('parse and serialize round-trips untouched content byte for byte', () => {
  const doc = parseXmlDocument(XML)
  assert.equal(serializeXmlDocument(doc), XML)
})

test('parse reports malformed xml', () => {
  assert.throws(() => parseXmlDocument('<workflow><task></workflow>'), /不匹配/)
  assert.throws(() => parseXmlDocument('<workflow>'), /缺少闭合标签/)
  assert.throws(() => parseXmlDocument('plain text'), /缺少根元素/)
  assert.throws(() => parseXmlDocument('<a attr=x />'), /未加引号/)
})

test('moveTaskElement rewrites uiinfo coordinates as json', () => {
  const doc = parseXmlDocument(XML)
  moveTaskElement(doc, '5', 12.6, 240, 120.4, 60)
  const task = findTaskElement(doc, '5')
  const uiinfo = childElements(task!, 'uiinfo')[0]
  assert.equal(getElementText(uiinfo), '{"x":13,"y":240,"width":120,"height":60}')
  // 其他内容不变：未编辑的 task 原文保留
  assert.ok(serializeXmlDocument(doc).includes('<uiinfo>10,20,30,29</uiinfo>'))
})

test('moveTaskElement inserts uiinfo when missing', () => {
  const doc = parseXmlDocument('<workflow><task id="9" label="x" tasktype="csf_service"><autodeal /></task></workflow>')
  moveTaskElement(doc, '9', 100, 200, 120, 60)
  const xml = serializeXmlDocument(doc)
  assert.ok(xml.includes('<uiinfo>{"x":100,"y":200,"width":120,"height":60}</uiinfo>'))
})

test('setTaskLabel escapes attribute value', () => {
  const doc = parseXmlDocument(XML)
  setTaskLabel(doc, '5', '含"引号"&<标签>')
  const task = findTaskElement(doc, '5')
  assert.equal(getAttributeDecoded(task!, 'label'), '含"引号"&<标签>')
  assert.ok(serializeXmlDocument(doc).includes('label="含&quot;引号&quot;&amp;&lt;标签&gt;"'))
})

test('setTaskService updates autodeal fields and keeps empty ones self-closing', () => {
  const doc = parseXmlDocument(XML)
  setTaskService(doc, '5', {
    runtype: 'csfService', crossCenter: true,
    centercode: 'crm', servicecode: 'new_code', servicename: '',
  })
  const autodeal = childElements(findTaskElement(doc, '5')!, 'autodeal')[0]
  assert.equal(getElementText(childElements(autodeal, 'centercode')[0]), 'crm')
  assert.equal(getElementText(childElements(autodeal, 'servicecode')[0]), 'new_code')
  assert.equal(getElementText(childElements(autodeal, 'crossCenter')[0]), 'true')
  const servicename = childElements(autodeal, 'servicename')[0]
  assert.equal(serializeXmlDocument(doc).includes('<servicename />'), true)
  assert.equal(getElementText(servicename), '')
})

test('setTaskService creates autodeal when missing', () => {
  const doc = parseXmlDocument('<workflow><task id="7" label="x" tasktype="csf_auto"><uiinfo>1,2,30,30</uiinfo></task></workflow>')
  setTaskService(doc, '7', {
    runtype: 'csfService', crossCenter: false,
    centercode: '', servicecode: 'auto_code', servicename: 'autoName',
  })
  const xml = serializeXmlDocument(doc)
  assert.ok(xml.includes('<servicecode>auto_code</servicecode>'))
  assert.ok(xml.includes('<centercode />'))
})

test('addTaskElement appends task with uiinfo and autodeal, rejects duplicates and unknown types', () => {
  const doc = parseXmlDocument(XML)
  addTaskElement(doc, { id: '99001', label: '新服务', tasktype: 'csf_service', x: 320, y: 180, width: 120, height: 60 })
  const xml = serializeXmlDocument(doc)
  assert.ok(xml.includes('<task id="99001" label="新服务" tasktype="csf_service" tasktag="">'))
  assert.ok(xml.includes('<uiinfo>{"x":320,"y":180,"width":120,"height":60}</uiinfo>'))
  assert.throws(() => addTaskElement(doc, { id: '3', label: 'dup', tasktype: 'fork', x: 0, y: 0, width: 30, height: 30 }), /已存在/)
  assert.throws(() => addTaskElement(doc, { id: '99', label: 'bad', tasktype: 'unknown', x: 0, y: 0, width: 30, height: 30 }), /未知节点类型/)
})

test('deleteTaskElement removes task, inbound gotoitems and related joins', () => {
  const doc = parseXmlDocument(XML)
  deleteTaskElement(doc, '5')
  const xml = serializeXmlDocument(doc)
  assert.ok(!xml.includes('<task id="5"'))
  assert.ok(!xml.includes('<gotoitem goto="5"'))
  assert.ok(!xml.includes('taska="6" taskb="5"'))
  // 与被删节点无关的内容保留
  assert.ok(xml.includes('<task id="3"'))
})

test('goto and join edge operations round-trip', () => {
  const doc = parseXmlDocument(XML)
  assert.equal(addGotoItem(doc, '3', '5'), true)
  assert.equal(addGotoItem(doc, '3', '5'), false) // 重复添加跳过
  const xml = serializeXmlDocument(doc)
  assert.ok(xml.includes('<gotoitem goto="5" />'))
  assert.equal(deleteGotoItem(doc, '3', '5'), true)
  assert.equal(deleteGotoItem(doc, '3', '5'), false)
  assert.equal(deleteJoinElement(doc, '6', '5'), true)
  assert.equal(deleteJoinElement(doc, '6', '5'), false)
  const after = serializeXmlDocument(doc)
  assert.ok(!after.includes('taska="6"'))
})

test('addGotoItem places new gotoitem after existing ones', () => {
  const doc = parseXmlDocument(XML)
  addGotoItem(doc, '6', '3')
  const source = findTaskElement(doc, '6')
  const gotos = childElements(source!, 'gotoitem').map(item => item.attributes[0].value)
  assert.deepEqual(gotos, ['5', '3'])
})

test('task link operations add, update and delete parameter mappings', () => {
  const doc = parseXmlDocument(XML)
  addTaskLink(doc, '5', { direction: 'OUT', left: 'return', right: '$IS_WAIT_USER', defaultValue: 'X', dataType: 'java.lang.String' })
  let xml = serializeXmlDocument(doc)
  assert.ok(xml.includes('<defaultValue dataType="java.lang.String">X</defaultValue>'))
  assert.ok(xml.includes('<right>$IS_WAIT_USER</right>'))

  updateTaskLink(doc, '5', 1, { direction: 'IN', left: 'order', right: 'orderId', defaultValue: '', dataType: '' })
  xml = serializeXmlDocument(doc)
  assert.ok(xml.includes('<left>order</left>'))
  assert.ok(!xml.includes('<defaultValue'))

  deleteTaskLink(doc, '5', 1)
  xml = serializeXmlDocument(doc)
  assert.ok(!xml.includes('<left>order</left>'))
})

test('task link operations create relationship holder when missing', () => {
  const doc = parseXmlDocument('<workflow><task id="8" label="x" tasktype="csf_service"><uiinfo>1,2,120,60</uiinfo></task></workflow>')
  addTaskLink(doc, '8', { direction: 'IN', left: 'a', right: 'b', defaultValue: '', dataType: '' })
  const xml = serializeXmlDocument(doc)
  assert.ok(xml.includes('<relationship>'))
  assert.ok(xml.includes('<task_>'))
  assert.ok(xml.includes('<link name="IN">'))
})

test('setTaskLinks replaces the whole mapping group atomically', () => {
  const doc = parseXmlDocument(XML)
  setTaskLinks(doc, '5', [
    { direction: 'IN', left: 'order', right: 'orderId', defaultValue: '1', dataType: 'java.lang.Long' },
    { direction: 'OUT', left: 'ret', right: '$RESULT', defaultValue: '', dataType: '' },
  ])
  const xml = serializeXmlDocument(doc)
  assert.ok(xml.includes('<left>order</left>'))
  assert.ok(xml.includes('<defaultValue dataType="java.lang.Long">1</defaultValue>'))
  assert.ok(xml.includes('<link name="OUT">'))
  // 原有映射被整组替换，不再存在
  assert.ok(!xml.includes('<left>custOrderId</left>'))

  // 空数组 = 清空全部参数映射（relationship/task_ 保留为空容器）
  setTaskLinks(doc, '5', [])
  const cleared = serializeXmlDocument(doc)
  assert.ok(!cleared.includes('<left>order</left>'))
  assert.ok(!cleared.includes('<link name='))
})

test('escapeXmlAttr escapes quotes for attribute injection', () => {
  assert.equal(escapeXmlAttr('a\'b"c<d>&e'), 'a\'b&quot;c&lt;d&gt;&amp;e')
})
