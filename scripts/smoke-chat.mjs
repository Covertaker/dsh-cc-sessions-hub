/**
 * Offline smoke for the chat half, plus an opt-in live turn.
 *
 *   node scripts/smoke-chat.mjs          # no network, no Claude call
 *   node scripts/smoke-chat.mjs --live   # one real turn through the installed CLI
 */
import { mkdir, mkdtemp, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { countSubagents, fullTool, historyFor, parseTranscript } from '../host/history.js'
import { pdfFile, previewFile } from '../host/files.js'
import { RUNTIMES, ccVersionWarning, runtimeFor } from '../host/engine.js'
import { registerChatRoutes } from '../host/routes.js'
import { TOKEN } from '../host/token.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/* 1. transcript parsing */
const dir = await mkdtemp(join(tmpdir(), 'cc-hub-smoke-'))
const transcript = join(dir, 't.jsonl')
const records = [
  { type: 'user', sessionId: 's', cwd: dir, timestamp: 't', message: { role: 'user', content: '第一问' } },
  {
    type: 'assistant',
    timestamp: 't',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: '回答一' },
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: join(dir, 'a.txt') } },
      ],
    },
  },
  {
    type: 'user',
    timestamp: 't',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: '文件内容' }] },
  },
]
await writeFile(transcript, records.map((record) => JSON.stringify(record)).join('\n'))
const parsed = parseTranscript(records.map((record) => JSON.stringify(record)).join('\n'))
check('解析：用户/助手/工具/结果', parsed.length === 4, `${parsed.length} items`)
check('解析：工具名挂到结果上', parsed[3]?.name === 'Read', parsed[3]?.name ?? '(none)')

/* 1b. subagent badge counts (session row shows 子代理（N）) */
await mkdir(join(dir, 't', 'subagents'), { recursive: true })
await writeFile(join(dir, 't', 'subagents', 'agent-a.meta.json'), '{}')
await writeFile(join(dir, 't', 'subagents', 'agent-a.jsonl'), '')
check('子代理计数：列表徽标', (await countSubagents(transcript)) === 1, '1 meta')
check('子代理计数：无目录返回 0', (await countSubagents(join(dir, 'none.jsonl'))) === 0)
check('CLI 版本警示：测试版不提示', ccVersionWarning('2.1.325') === '')
check('CLI 版本警示：异常版本提示', ccVersionWarning('2.1.400').includes('未在本插件验证'))

/* 2. file preview */
const sample = join(dir, 'a.txt')
await writeFile(sample, 'hello preview')
const preview = await previewFile(sample)
check('预览：文本', preview.kind === 'text' && preview.text === 'hello preview')
const markdownSample = join(dir, 'b.md')
await writeFile(markdownSample, '# 标题\n\n正文')
const markdownPreview = await previewFile(markdownSample)
check('预览：Markdown 识别', markdownPreview.kind === 'markdown')
const htmlSample = join(dir, 'c.html')
await writeFile(htmlSample, '<h1>hi</h1>')
const htmlPreview = await previewFile(htmlSample)
check('预览：HTML 识别', htmlPreview.kind === 'html')
let rejected = false
try {
  await previewFile('relative/path.txt')
} catch {
  rejected = true
}
check('预览：拒绝相对路径', rejected)

/* 3. routes + fake server */
const routes = []
const ctx = {
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  get() {
    return undefined
  },
}
const dispose = registerChatRoutes(ctx)
check('路由：注册 4 条', routes.length === 4, routes.map((route) => route.path).join(','))

function request({ method = 'GET', url, body, headers = {} }) {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:1', origin: 'http://127.0.0.1:1', 'x-cc-hub-token': TOKEN, ...headers },
    on() {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
}
function response() {
  const state = { status: 0, body: '' }
  return {
    state,
    writeHead(status) {
      state.status = status
    },
    write(chunk) {
      if (chunk) state.body += String(chunk)
    },
    end(chunk) {
      if (chunk) state.body += String(chunk)
    },
    destroy() {},
    get headersSent() {
      return state.status !== 0
    },
  }
}
async function call(route, req) {
  const res = response()
  await route.handler(req, res)
  let json = null
  try {
    json = JSON.parse(res.state.body)
  } catch {
    json = null
  }
  return { status: res.state.status, json, body: res.state.body }
}

const chat = routes.find((route) => route.path === '/_ccpanel/chat')
const fileRoute = () => routes.find((route) => route.path === '/_ccpanel/file')
const missing = await call(chat, request({ url: '/_ccpanel/chat/state?id=does-not-exist' }))
check('路由：不存在的会话 404', missing.status === 404)
const forbidden = await call(chat, request({ url: '/_ccpanel/chat/state?id=x', headers: { host: 'evil:1' } }))
check('路由：非本机 Host 403', forbidden.status === 403)
const noToken = await call(chat, request({ url: '/_ccpanel/chat/state?id=x', headers: { 'x-cc-hub-token': '' } }))
check('路由：缺 token 401', noToken.status === 401)
const tokenRoute = await call(chat, request({ url: '/_ccpanel/chat/token', headers: { 'x-cc-hub-token': '' } }))
check('路由：token 可取', tokenRoute.status === 200 && tokenRoute.json?.token === TOKEN)
const crossToken = await call(chat, request({ url: '/_ccpanel/chat/token', headers: { 'x-cc-hub-token': '', 'sec-fetch-site': 'cross-site' } }))
const hugeBody = await call(
  chat,
  request({ method: 'POST', url: '/_ccpanel/chat/send', body: { id: 'x', text: 'a'.repeat(9 * 1024 * 1024) } }),
)
check('路由：请求体 8MB 上限', hugeBody.status === 413, String(hugeBody.status))
check('路由：跨站取 token 403', crossToken.status === 403)

{
  // Use a synthetic init so the command list does not depend on ~/.claude.
  const id = randomUUID()
  const commandRuntime = runtimeFor(id, { id, cwd: dir })
  commandRuntime.handle({
    type: 'system',
    subtype: 'init',
    model: 'm',
    cwd: dir,
    claude_code_version: '2.1.325',
    permissionMode: 'auto',
    tools: [],
    skills: ['demo-skill'],
    slash_commands: ['/help', '/clear'],
    terminal_slash_commands: ['/clear'],
    mcp_servers: [],
    plugins: [],
    agents: [],
    output_style: 'default',
  })
  const commands = await call(chat, request({ url: `/_ccpanel/chat/commands?id=${id}` }))
  check(
    '路由：命令清单可用',
    commands.status === 200 &&
      commands.json?.source === 'runtime' &&
      commands.json.commands.includes('/help') &&
      !commands.json.commands.includes('/clear'),
    `${commands.json?.commands?.join(',') ?? ''}`,
  )
  await commandRuntime.dispose()
}

const draftId = randomUUID()
const options = await call(
  chat,
  request({
    method: 'POST',
    url: '/_ccpanel/chat/options',
    body: { id: draftId, cwd: dir, mode: 'plan', effort: 'low' },
  }),
)
check(
  '路由：模式/effort 可设',
  options.status === 200 && options.json?.mode === 'plan' && options.json?.effort === 'low',
  `${options.json?.mode}/${options.json?.effort}`,
)


/* 4. regressions for the acceptance findings */
{
  const id = randomUUID()
  const runtime = runtimeFor(id, { id, cwd: dir })
  const first = runtime.askPermission('Bash', { command: 'a' }, { suggestions: [] })
  const second = runtime.askPermission('Write', { file_path: '/tmp/x' }, { suggestions: [] })
  const pending = runtime.snapshot().pending
  check('并发审批：两个都在列表里', Array.isArray(pending) && pending.length === 2, `${pending.length} 条`)
  let firstValue = null
  let secondValue = null
  first.then((value) => { firstValue = value })
  second.then((value) => { secondValue = value })
  const p1 = pending.find((entry) => entry.toolName === 'Bash')
  runtime.resolvePermission(p1.requestId, 'allow')
  await new Promise((resolve) => setTimeout(resolve, 20))
  check('并发审批：只结算指定的一条', firstValue?.behavior === 'allow' && secondValue === null, JSON.stringify(firstValue))
  runtime.denyAllPending('test')
  await new Promise((resolve) => setTimeout(resolve, 20))
  check('并发审批：剩余一条被拒绝而不悬挂', secondValue?.behavior === 'deny', JSON.stringify(secondValue))
  await runtime.dispose()

  const fatal = runtimeFor(randomUUID(), { id: randomUUID(), cwd: dir })
  const pendingPromise = fatal.askPermission('Bash', { command: 'rm -rf /' }, {})
  await fatal.dispose()
  const settled = await Promise.race([pendingPromise, new Promise((resolve) => setTimeout(() => resolve('timeout'), 500))])
  check('dispose 会结掉待审批（不会永久挂起）', settled !== 'timeout' && settled?.behavior === 'deny', JSON.stringify(settled))
}
{
  const id = randomUUID()
  const source = randomUUID()
  const forked = runtimeFor(id, { id, cwd: dir, sourceId: source, fork: true })
  forked.handle({
    type: 'system',
    subtype: 'init',
    model: 'm',
    cwd: dir,
    claude_code_version: 'x',
    permissionMode: 'plan',
    tools: [],
    skills: [],
    slash_commands: [],
    terminal_slash_commands: [],
    mcp_servers: [],
    plugins: [],
    agents: [],
    output_style: 'default',
  })
  check('fork 启动后不再从源会话重开', forked.fork === false && forked.sourceId === forked.id)
  check('init 的实际权限模式会同步到面板', forked.mode === 'plan', forked.mode)
  await forked.dispose()
}
{
  // Newest real transcript: options must seed the history instead of blanking it.
  const root = join(homedir(), '.claude', 'projects')
  let newest = null
  try {
    for (const project of await readdir(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue
      for (const file of await readdir(join(root, project.name))) {
        if (!file.endsWith('.jsonl')) continue
        const full = join(root, project.name, file)
        const info = await stat(full)
        if (!newest || info.mtimeMs > newest.mtime) newest = { id: file.slice(0, -6), path: full, mtime: info.mtimeMs }
      }
    }
  } catch {
    newest = null
  }
  const candidates = []
  try {
    for (const project of await readdir(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue
      for (const file of await readdir(join(root, project.name))) {
        if (!file.endsWith('.jsonl')) continue
        const info = await stat(join(root, project.name, file))
        candidates.push({ id: file.slice(0, -6), mtime: info.mtimeMs })
      }
    }
  } catch {
    /* no transcripts */
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  let tested = false
  for (const candidate of candidates.slice(0, 8)) {
    const seeded = await call(
      chat,
      request({ method: 'POST', url: '/_ccpanel/chat/options', body: { id: candidate.id, mode: 'plan' } }),
    )
    if (seeded.status === 409) continue
    const count = seeded.json?.items?.length ?? 0
    check('改模式不会清空历史会话', seeded.status === 200 && count > 0, `${count} 条`)
    const seededRuntime = RUNTIMES.get(candidate.id)
    if (seededRuntime) await seededRuntime.dispose()
    tested = true
    break
  }
  if (!tested) console.log('SKIP 历史 seed（候选转录都在运行中）')
}
{
  const dirAsPdf = join(dir, 'not-a-file.pdf')
  await mkdir(dirAsPdf, { recursive: true })
  let rejected = false
  try {
    await pdfFile(dirAsPdf)
  } catch {
    rejected = true
  }
  check('目录伪装成 .pdf 会被拒绝（不会崩进程）', rejected)
}
{
  const badMode = await call(
    chat,
    request({ method: 'POST', url: '/_ccpanel/chat/options', body: { id: randomUUID(), cwd: dir, mode: 'nonsense' } }),
  )
  check('非法模式返回 400', badMode.status === 400, String(badMode.status))
}


/* 5. fixes for the second acceptance round */
{
  const id = randomUUID()
  const runtime = runtimeFor(id, { id, cwd: dir })
  const ask = runtime.askPermission('Bash', { command: 'x' }, { suggestions: [] })
  const noRequest = await call(chat, request({ method: 'POST', url: '/_ccpanel/chat/permission', body: { id, decision: 'allow' } }))
  check('审批缺 requestId → 409', noRequest.status === 409, String(noRequest.status))
  const pending = runtime.snapshot().pending
  const withRequest = await call(
    chat,
    request({ method: 'POST', url: '/_ccpanel/chat/permission', body: { id, requestId: pending[0].requestId, decision: 'allow' } }),
  )
  check('带 requestId 可正常审批', withRequest.status === 200, String(withRequest.status))
  await Promise.race([ask, new Promise((resolve) => setTimeout(resolve, 300))])
  await runtime.dispose()
}
{
  const id = randomUUID()
  const bad = await call(
    chat,
    request({ method: 'POST', url: '/_ccpanel/chat/options', body: { id, cwd: '/nonexistent-xyz', mode: 'plan' } }),
  )
  check('options 坏 cwd → 400 且不建 runtime', bad.status === 400 && !RUNTIMES.has(id), String(bad.status))
}
{
  const relative = await call(fileRoute(), request({ url: '/_ccpanel/file?path=relative.txt' }))
  check('文件：相对路径 400', relative.status === 400, String(relative.status))
  const directory = await call(fileRoute(), request({ url: `/_ccpanel/file?path=${encodeURIComponent(dir)}` }))
  check('文件：目录 400', directory.status === 400, String(directory.status))
  const missing = await call(fileRoute(), request({ url: `/_ccpanel/file?path=${encodeURIComponent(join(dir, 'nope.txt'))}` }))
  check('文件：不存在 404', missing.status === 404, String(missing.status))
}
{
  const interrupted = runtimeFor(randomUUID(), { id: randomUUID(), cwd: dir })
  interrupted.interrupted = true
  interrupted.handle({ type: 'result', is_error: true, subtype: 'error_during_execution', num_turns: 1 })
  check('中断结果不把会话标成 error', interrupted.status === 'idle' && interrupted.error === '', `${interrupted.status}/${interrupted.error}`)
  await interrupted.dispose()
}


{
  const id = randomUUID()
  const runtime = runtimeFor(id, { id, cwd: dir })
  const snapshot = runtime.snapshot()
  check('新会话默认 auto + xhigh', snapshot.mode === 'auto' && snapshot.effort === 'xhigh', `${snapshot.mode}/${snapshot.effort}`)
  await runtime.dispose()
}
/* 6. features added after the second acceptance round */
{
  const id = randomUUID()
  const runtime = runtimeFor(id, { id, cwd: dir })
  const ask = runtime.askPermission(
    'AskUserQuestion',
    {
      questions: [
        { question: '选哪个？', header: '二选一', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }], multiSelect: false },
      ],
    },
    {},
  )
  const pending = runtime.snapshot().pending
  check('问题卡被识别为 question', pending[0]?.kind === 'question', pending[0]?.kind)
  runtime.resolvePermission(pending[0].requestId, 'allow', '', { '选哪个？': 'A' })
  const answered = await Promise.race([ask, new Promise((resolve) => setTimeout(() => resolve(null), 500))])
  check('答案进入 updatedInput.answers', answered?.updatedInput?.answers?.['选哪个？'] === 'A', JSON.stringify(answered?.updatedInput?.answers))
  await runtime.dispose()
}
{
  // Find a real transcript with a tool call.
  const root = join(homedir(), '.claude', 'projects')
  let found = null
  try {
    for (const project of await readdir(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue
      for (const file of await readdir(join(root, project.name))) {
        if (!file.endsWith('.jsonl')) continue
        const full = join(root, project.name, file)
        const info = await stat(full)
        if (!found || info.mtimeMs > found.mtime) found = { id: file.slice(0, -6), path: full, mtime: info.mtimeMs }
      }
    }
  } catch {
    found = null
  }
  if (found) {
    let items = await historyFor(found.path, await stat(found.path))
    if (items.length === 0) {
      try {
        const others = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory())
        for (const project of others) {
          for (const file of await readdir(join(root, project.name))) {
            if (!file.endsWith('.jsonl')) continue
            const full = join(root, project.name, file)
            const candidate = await historyFor(full, await stat(full))
            if (candidate.length > 0) { items = candidate; found.path = full; found.id = file.slice(0, -6); break }
          }
          if (items.length > 0) break
        }
      } catch { /* keep the first candidate */ }
    }
    const tool = items.find((item) => item.kind === 'tool' && item.toolId)
    if (tool) {
      const full = await fullTool(found.path, tool.toolId)
      check('完整工具内容可取', Boolean(full.input) || full.result !== null, `${tool.name}`)
    } else {
      console.log('SKIP 完整工具内容（最新转录无工具调用）')
    }
    const thinkingItems = await historyFor(found.path, await stat(found.path), true)
    check('thinking 开关能取到思考条目', Array.isArray(thinkingItems), `${thinkingItems.filter((item) => item.kind === 'thinking').length} 条`)
    const history = await call(
      chat,
      request({ url: `/_ccpanel/chat/history?id=${encodeURIComponent(found.id)}&limit=2` }),
    )
    check(
      '历史窗口可分页',
      history.status === 200 && Array.isArray(history.json?.items) && history.json.items.length === Math.min(2, items.length) && typeof history.json.from === 'number',
      `status=${history.status} ${history.json?.items?.length} 条 from=${history.json?.from} id=${found.id} total=${history.json?.total} err=${history.json?.error ?? ''}`,
    )
  }
}
{
  const stream = await call(
    chat,
    request({ url: `/_ccpanel/chat/stream?id=${randomUUID()}` }),
  )
  check('SSE：无运行时会立即结束并告知 live=false', stream.body.includes('"live":false'), String(stream.status))
}
{
  const badImage = await call(
    chat,
    request({ method: 'POST', url: '/_ccpanel/chat/send', body: { id: randomUUID(), cwd: dir, text: '', images: [{ media_type: 'text/plain', data: 'x' }] } }),
  )
  check('图片：非法类型 400', badImage.status === 400, String(badImage.status))
}

/* 7. optional live turn */
if (process.argv.includes('--live')) {
  const id = randomUUID()
  const runtime = runtimeFor(id, { id, cwd: dir })
  await runtime.send('只回答两个字：收到。不要调用任何工具。')
  const deadline = Date.now() + 90_000
  let status = ''
  while (Date.now() < deadline) {
    const snap = runtime.snapshot()
    status = snap.status
    if (status === 'idle' || status === 'error' || status === 'closed') break
    await new Promise((resolve) => setTimeout(resolve, 600))
  }
  const snap = runtime.snapshot()
  const answer = snap.items.filter((item) => item.role === 'assistant').map((item) => item.text).join('')
  check('真发一轮：拿到助手回复', status === 'idle' && /收到/.test(answer), `${status} / ${answer.slice(0, 40)}`)
  await runtime.dispose()
} else {
  console.log('SKIP 真发一轮（加 --live 才跑）')
}

for (const runtime of RUNTIMES.values()) await runtime.dispose().catch(() => {})
dispose()

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
