/**
 * Regression test for the client's markdown renderer.
 *
 * The renderer once froze the whole window on CRLF text: `# title\r` fails the
 * heading test (`.` never matches `\r`) while the paragraph loop's guard still
 * matches the prefix, so the loop body never ran and `i` never advanced — the
 * panel pegged every core and grew past 3 GB until the renderer died.
 *
 * The real functions are lifted out of client.js and run inside a worker, so a
 * regression that spins is reported as a failure instead of hanging the run.
 *
 *   node scripts/test-client-markdown.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker, isMainThread, parentPort } from 'node:worker_threads'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(here, '..', 'client.js')
const BUDGET_MS = 5000

const CASES = [
  {
    name: 'CRLF 文档不再死循环',
    text: [
      '# 视频口播文案提取 Skill\r',
      '',
      '正文一段。\r',
      '## 环境\r',
      '- 列表项\r',
      '1. 有序项\r',
      '> 引用\r',
      '```bash\r',
      'echo hi\r',
      '```\r',
    ].join('\n'),
    expect: (n) => n > 0,
  },
  {
    name: 'CRLF 表格能解析',
    text: '标题\r\n\r\n| a | b |\r\n| --- | --- |\r\n| 1 | 2 |\r\n',
    expect: (n) => n > 0,
  },
  {
    name: 'LF 文档不受影响',
    text: '# 标题\n\n正文\n',
    expect: (n) => n === 2,
  },
  {
    name: '畸形标题行不会卡住',
    text: '# x\r\n##\r\n',
    expect: (n) => n > 0,
  },
]

function buildParser() {
  const source = readFileSync(CLIENT, 'utf8')
  const extract = (name) => {
    const start = source.indexOf(`function ${name}(`)
    if (start < 0) throw new Error(`function ${name} not found in client.js`)
    let depth = 0
    for (let i = source.indexOf('{', start); i < source.length; i += 1) {
      if (source[i] === '{') depth += 1
      else if (source[i] === '}') {
        depth -= 1
        if (depth === 0) return source.slice(start, i + 1)
      }
    }
    throw new Error(`unbalanced braces in ${name}`)
  }
  const factory = new Function(`
    const h = (tag, props, ...kids) => ({ tag, props, kids })
    const T = { line: 'x', lineStrong: 'x', layer1: 'x', layer2: 'x', text: 'x', sub: 'x', accentText: 'x', caption: 'x' }
    const MONO = 'monospace'
    const HAIRLINE = 1
    const CODE_STYLE = {}
    ${extract('inlineNodes')}
    ${extract('markdownBlocks')}
    return { markdownBlocks }
  `)
  return factory()
}

if (!isMainThread) {
  const results = []
  try {
    const { markdownBlocks } = buildParser()
    for (const testCase of CASES) {
      const started = Date.now()
      const nodes = markdownBlocks(testCase.text, null, '')
      const elapsed = Date.now() - started
      results.push({ name: testCase.name, ok: testCase.expect(nodes.length), detail: `${nodes.length} blocks, ${elapsed}ms` })
    }
  } catch (error) {
    results.push({ name: '解析器可加载', ok: false, detail: String(error?.message ?? error) })
  }
  parentPort.postMessage(results)
} else {
  const worker = new Worker(new URL(import.meta.url))
  let reported = false
  const timer = setTimeout(() => {
    if (reported) return
    reported = true
    console.log(`FAIL 解析在 ${BUDGET_MS}ms 内没有返回 —— 说明渲染循环又卡住了`)
    console.log(`\n0/${CASES.length + 1} passed`)
    worker.terminate()
    process.exit(1)
  }, BUDGET_MS)

  worker.on('message', (results) => {
    if (reported) return
    reported = true
    clearTimeout(timer)
    for (const row of results) console.log(`${row.ok ? 'PASS' : 'FAIL'} ${row.name}${row.detail ? ` — ${row.detail}` : ''}`)
    const failed = results.filter((row) => !row.ok).length
    console.log(`\n${results.length - failed}/${results.length} passed`)
    process.exit(failed === 0 ? 0 : 1)
  })

  worker.on('error', (error) => {
    if (reported) return
    reported = true
    clearTimeout(timer)
    console.log('FAIL worker error:', String(error?.message ?? error))
    process.exit(1)
  })
}
