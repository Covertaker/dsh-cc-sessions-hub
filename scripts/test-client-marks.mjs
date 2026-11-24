/**
 * Regression test for the row editor's save path (tags + note).
 *
 * The first version had a trap: the tag input only committed a tag on Enter,
 * so typing a tag and clicking 保存 sent an empty draft. The server treats an
 * empty record as "no marks", the editor closed, and nothing appeared anywhere
 * — the save looked successful and did nothing.
 *
 * Row is lifted out of client.js and rendered against a tiny hook runtime, so
 * the real handlers (menu → editor → inputs → 保存) run without DSH or a DOM.
 *
 *   node scripts/test-client-marks.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(here, '..', 'client.js')

/* ── minimal hook + element runtime ─────────────────────────────────── */

let store = []
let cursor = 0
function useState(init) {
  const array = store
  const index = cursor++
  if (!(index in array)) array[index] = typeof init === 'function' ? init() : init
  return [
    array[index],
    (value) => {
      array[index] = typeof value === 'function' ? value(array[index]) : value
    },
  ]
}

const fakeReact = {
  createElement: (type, props, ...children) => {
    const kids = children.flat(Infinity).filter((child) => child !== undefined && child !== null && child !== false)
    return { type, props: { ...(props || {}), children: kids.length <= 1 ? kids[0] : kids }, children: kids }
  },
  useState,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: () => ({ current: null }),
  Fragment: 'Fragment',
}

let spec
globalThis.window = { __ModuleLoader__: { load(value) { spec = value } } }
new Function('window', readFileSync(CLIENT, 'utf8'))(globalThis.window)
const mod = spec.factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error(`unexpected require: ${name}`)
})
const Row = mod.__test.Row

function renderNode(node, root = false) {
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child) => renderNode(child))
  if (typeof node.type === 'function') {
    let out
    if (root) {
      out = node.type(node.props)
    } else {
      // Nested components keep their own hook slots; only Row's state matters here.
      const savedStore = store
      const savedCursor = cursor
      store = []
      cursor = 0
      out = node.type(node.props)
      store = savedStore
      cursor = savedCursor
    }
    return renderNode(out)
  }
  return { type: node.type, props: node.props, children: node.children.map((child) => renderNode(child)) }
}

function walk(node, fn) {
  if (!node) return
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, fn))
    return
  }
  if (typeof node === 'object') {
    fn(node)
    walk(node.children, fn)
  }
}

function textOf(node) {
  if (typeof node === 'string') return node
  if (!node || typeof node !== 'object') return ''
  return (node.children || []).map(textOf).join('')
}

function findByButton(tree, label) {
  let hit = null
  walk(tree, (node) => {
    if (!hit && node.type === 'button' && textOf(node).trim() === label) hit = node
  })
  return hit
}

function findInput(tree, predicate) {
  let hit = null
  walk(tree, (node) => {
    if (!hit && node.type === 'input' && predicate(node.props)) hit = node
  })
  return hit
}

function findTextarea(tree) {
  let hit = null
  walk(tree, (node) => {
    if (!hit && node.type === 'textarea') hit = node
  })
  return hit
}

/* ── render Row and drive the editor ────────────────────────────────── */

const id = 's1'
const baseRow = { id, path: '/tmp/x.jsonl', cwd: '/tmp', title: '测试会话', preview: 'p', live: false, meta: { favorite: false, tags: [], note: '' } }
const calls = []
const props = {
  row: baseRow,
  selected: false,
  onToggleSelect() {},
  onTakeOver: () => Promise.resolve({ ok: true }),
  onOpen() {},
  onRelease() {},
  onSubagents() {},
  onMeta: (row, body) => {
    calls.push(body)
    return Promise.resolve({ updated: { [id]: { favorite: false, tags: body.tags || [], note: body.note || '' } }, tags: [] })
  },
  onDelete: () => Promise.resolve({ deleted: [{ id }] }),
  tagOptions: [],
}

let tree
function render() {
  cursor = 0
  tree = renderNode({ type: Row, props }, true)
}

function openEditor() {
  // 新行结构：⋯ 展开详情，详情里才出现「标签与备注」；已展开时不要再点（会收起）
  if (!findByButton(tree, '标签与备注')) {
    findByButton(tree, '⋯').props.onClick({ stopPropagation() {} })
    render()
  }
  const edit = findByButton(tree, '标签与备注')
  if (!edit) throw new Error('展开详情后找不到「标签与备注」')
  edit.props.onClick({ stopPropagation() {} })
  render()
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

render()
openEditor()

const tagInput = findInput(tree, (p) => String(p.placeholder || '').includes('加标签'))
tagInput.props.onChange({ target: { value: '材料' } })
render()
findInput(tree, (p) => String(p.placeholder || '').includes('加标签')).props.onKeyDown({ key: 'Enter', preventDefault() {} })
render()
findTextarea(tree).props.onChange({ target: { value: '下次接着做' } })
render()
findByButton(tree, '保存').props.onClick({ stopPropagation() {} })

const last = calls[calls.length - 1]
check(
  '先回车成标签，保存请求体正确',
  Boolean(last) && last.action === 'edit' && last.ids[0] === id && last.tags.join(',') === '材料' && last.note === '下次接着做',
  JSON.stringify(last),
)

// Let the save promise settle so state clears before the second scenario.
await new Promise((resolve) => setTimeout(resolve, 0))
props.row = { ...baseRow, meta: { favorite: false, tags: [], note: '' } }
render()
openEditor()

findInput(tree, (p) => String(p.placeholder || '').includes('加标签')).props.onChange({ target: { value: '开发' } })
render()
findTextarea(tree).props.onChange({ target: { value: '备注B' } })
render()
findByButton(tree, '保存').props.onClick({ stopPropagation() {} })

const lastPending = calls[calls.length - 1]
check(
  '未回车的标签在保存时也被收下',
  Boolean(lastPending) && lastPending.tags.join(',') === '开发' && lastPending.note === '备注B',
  JSON.stringify(lastPending),
)

/* 场景 C：铅笔改名 */
await new Promise((resolve) => setTimeout(resolve, 0))
props.row = { ...baseRow, meta: { favorite: false, tags: [], note: '' } }
store = []
cursor = 0
render()
const pencil = findByButton(tree, '✎')
check('重命名：行内有 ✎ 入口', Boolean(pencil))
if (pencil) {
  pencil.props.onClick({ stopPropagation() {} })
  render()
  const nameInput = findInput(tree, (p) => p.className === 'ccs-name-input')
  if (!nameInput) throw new Error('点 ✎ 后没有出现改名输入框')
  nameInput.props.onChange({ target: { value: '新名字' } })
  render()
  findInput(tree, (p) => p.className === 'ccs-name-input').props.onKeyDown({ key: 'Enter', preventDefault() {} })
  const lastRename = calls[calls.length - 1]
  check(
    '重命名：请求体正确',
    Boolean(lastRename) && lastRename.action === 'rename' && lastRename.ids[0] === id && lastRename.name === '新名字',
    JSON.stringify(lastRename),
  )
} else {
  check('重命名：请求体正确', false, '没有 ✎ 入口')
}

/* 面板外壳：data 为空时也要能渲染出侧栏（收藏入口）与空状态。 */
const SessionsPanel = mod.__test.SessionsPanel
store = []
cursor = 0
let panelTree = null
let panelError = ''
try {
  panelTree = renderNode({ type: SessionsPanel, props: {} }, true)
} catch (cause) {
  panelError = String(cause?.message ?? cause)
}
const panelText = panelTree ? textOf(panelTree) : ''
check(
  '面板：新壳可渲染（收藏入口在侧栏）',
  !panelError && panelText.includes('收藏') && panelText.includes('全部') && panelText.includes('回收站'),
  panelError || panelText.slice(0, 90),
)

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
