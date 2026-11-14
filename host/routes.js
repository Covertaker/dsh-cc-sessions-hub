/**
 * HTTP surface of the chat panel.
 *
 * Registered under `/_ccpanel/chat`, `/_ccpanel/file`, `/_ccpanel/pick-dir`
 * and `/_ccpanel/open`. The existing `/_ccpanel` prefix route keeps serving
 * the list/digest; longest-prefix matching keeps these handlers separate.
 *
 * Handlers are Node-style because they accept POST; `resource` routes only
 * answer GET/HEAD.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CLAUDE_BIN,
  RUNTIMES,
  expandHome,
  archivedSnapshot,
  runtimeFor,
  tickMaintenance,
} from './engine.js'
import { fullTool, headMeta, historyFor, listSubagents, subagentFor } from './history.js'
import { openWithDefaultApp, pdfFile, previewFile, readImage, revealInFinder } from './files.js'
import { TOKEN } from './token.js'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const SESSIONS_DIR = join(homedir(), '.claude', 'sessions')
const MAX_BODY = 8 * 1024 * 1024
const MAX_BODY_MB = MAX_BODY / 1024 / 1024
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Per-process token for state-changing requests.
 *
 * A web page can aim a no-cors form or image at 127.0.0.1, and it can omit or
 * null the Origin header. It cannot set a custom header without a CORS
 * preflight, and it cannot read a cross-origin response. So the token is handed
 * out by a GET the page cannot read, and required on every chat/file/pick/open
 * request except `/chat/token` itself and `/file/raw` (an <img> cannot send
 * headers; that route only serves image MIME types).
 */
function hostTrusted(request) {
  const host = String(request.headers.host ?? '')
  if (!LOOPBACK.test(host)) return false
  const origin = request.headers.origin
  if (origin && origin !== 'null' && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) return false
  return true
}

function tokenOk(request) {
  const value = String(request.headers['x-cc-hub-token'] ?? '')
  return value.length > 0 && value === TOKEN
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

async function readBody(request) {
  const chunks = []
  let total = 0
  let tooLarge = false
  // Draining matters: responding while the client is still writing makes Node
  // tear the connection down, and the error never reaches the caller.
  for await (const chunk of request) {
    total += chunk.length
    if (total > 16 * 1024 * 1024) {
      request.destroy()
      throw new HttpError(413, `请求体超过 ${MAX_BODY_MB}MB`)
    }
    if (tooLarge) continue
    if (total > MAX_BODY) {
      tooLarge = true
      chunks.length = 0
      continue
    }
    chunks.push(chunk)
  }
  if (tooLarge) throw new HttpError(413, `请求体超过 ${MAX_BODY_MB}MB`)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, '请求体必须是 JSON 对象')
  }
  return parsed
}

/* ── transcript lookup ─────────────────────────────────────────────── */

async function locateTranscript(id) {
  const needle = String(id ?? '')
  // Ids come from the client; never let one walk out of the projects root.
  if (!UUID.test(needle)) return null
  let projects = []
  try {
    projects = await readdir(PROJECTS_DIR, { withFileTypes: true })
  } catch {
    return null
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const file = join(PROJECTS_DIR, project.name, `${needle}.jsonl`)
    try {
      const info = await stat(file)
      return { path: file, size: info.size, mtime: info.mtimeMs, project: project.name }
    } catch {
      /* not in this project */
    }
  }
  return null
}

async function staticCommands() {
  const skillsDir = join(homedir(), '.claude', 'skills')
  const commandsDir = join(homedir(), '.claude', 'commands')
  const skills = []
  const commands = []
  try {
    for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) skills.push(entry.name)
    }
  } catch {
    /* no skills dir */
  }
  try {
    for (const file of await readdir(commandsDir)) {
      if (file.endsWith('.md')) commands.push(file.slice(0, -3))
    }
  } catch {
    /* no commands dir */
  }
  skills.sort()
  commands.sort()
  return { commands: [...new Set([...commands, ...skills])], skills }
}

let liveCache = { at: 0, ids: new Set() }

function claudeAgents() {
  return new Promise((resolve) => {
    execFile(
      CLAUDE_BIN || 'claude',
      ['agents', '--json'],
      { timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve(null)
        try {
          const parsed = JSON.parse(stdout)
          resolve(Array.isArray(parsed) ? parsed : null)
        } catch {
          resolve(null)
        }
      },
    )
  })
}

/**
 * Live sessions, with `claude agents --json` as the authority and the session
 * registry as the fallback. This decides read-only vs writable: a miss here
 * would let the panel resume a session that a terminal is still writing, which
 * is the silent-fork failure this plugin refuses to risk.
 */
async function liveSessionIds(force = false) {
  if (!force && Date.now() - liveCache.at < 15_000) return liveCache.ids
  const ids = new Set()
  const agents = await claudeAgents()
  if (agents) {
    for (const row of agents) {
      const id = row?.sessionId ?? row?.id
      if (id) ids.add(String(id))
    }
  } else {
    let entries = []
    try {
      entries = await readdir(SESSIONS_DIR)
    } catch {
      entries = []
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      try {
        const parsed = JSON.parse(await readFile(join(SESSIONS_DIR, entry), 'utf8'))
        if (parsed?.sessionId) ids.add(String(parsed.sessionId))
      } catch {
        /* half-written registry file */
      }
    }
  }
  liveCache = { at: Date.now(), ids }
  return ids
}

async function stateFor(id, { includeThinking = false } = {}) {
  const runtime = RUNTIMES.get(id)
  if (runtime) {
    if (includeThinking) runtime.includeThinking = true
    // An unstarted runtime is only an option holder; display still comes from the
    // transcript (so toggling thinking re-reads it instead of showing an empty list).
    if (runtime.started) return runtime.snapshot()
  }
  const located = await locateTranscript(id)
  if (!located) return runtime ? runtime.snapshot() : null
  const [meta, live] = await Promise.all([headMeta(located.path), liveSessionIds()])
  const snapshot = await archivedSnapshot(
    { id, path: located.path, cwd: meta.cwd, mtime: located.mtime },
    { live: live.has(id), includeThinking },
  )
  snapshot.title = meta.firstPrompt
  if (runtime) {
    snapshot.mode = runtime.mode
    snapshot.effort = runtime.effort
    snapshot.thinking = runtime.includeThinking
    snapshot.source = 'panel'
  }
  return snapshot
}

/* ── chat actions ──────────────────────────────────────────────────── */

async function handleChat(request, response, ctx) {
  const url = new URL(request.url, 'http://placeholder.invalid')
  const path = url.pathname.replace(/\/+$/, '')
  const method = request.method ?? 'GET'

  if (path === '/_ccpanel/chat/token' && method === 'GET') {
    // Same-origin only. A cross-origin page can send this request but cannot
    // read the body (CORS), and cannot set the header the token unlocks.
    const site = String(request.headers['sec-fetch-site'] ?? '')
    if (site && site !== 'same-origin' && site !== 'none') {
      return sendJson(response, 403, { error: 'cross-site token request refused' })
    }
    return sendJson(response, 200, { token: TOKEN })
  }

  if (path === '/_ccpanel/chat/state' && method === 'GET') {
    const id = url.searchParams.get('id') ?? ''
    if (!id) return sendJson(response, 400, { error: '缺少 id' })
    const snapshot = await stateFor(id, { includeThinking: url.searchParams.get('thinking') === '1' })
    if (!snapshot) return sendJson(response, 404, { error: '找不到该会话的转录' })
    return sendJson(response, 200, snapshot)
  }

  if (path === '/_ccpanel/chat/commands' && method === 'GET') {
    const id = url.searchParams.get('id') ?? ''
    const runtime = id ? RUNTIMES.get(id) : null
    if (runtime?.init) {
      const terminal = new Set(runtime.init.terminalSlashCommands ?? [])
      return sendJson(response, 200, {
        source: 'runtime',
        commands: runtime.init.slashCommands.filter((name) => !terminal.has(name)),
        skills: runtime.init.skills,
      })
    }
    return sendJson(response, 200, { source: 'static', ...(await staticCommands()) })
  }

  if (path === '/_ccpanel/chat/history' && method === 'GET') {
    const id = url.searchParams.get('id') ?? ''
    const located = await locateTranscript(id)
    if (!located) return sendJson(response, 404, { error: '找不到该会话的转录' })
    const includeThinking = url.searchParams.get('thinking') === '1'
    const all = await historyFor(located.path, await stat(located.path), includeThinking)
    const beforeParam = url.searchParams.get('before')
    const beforeRaw = beforeParam === null ? Number.NaN : Number(beforeParam)
    const before = Number.isFinite(beforeRaw) ? Math.max(0, Math.min(all.length, Math.trunc(beforeRaw))) : all.length
    const limitParam = url.searchParams.get('limit')
    const limitRaw = limitParam === null ? Number.NaN : Number(limitParam)
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(250, Math.trunc(limitRaw))) : 250
    const start = Math.max(0, before - limit)
    return sendJson(response, 200, { id, items: all.slice(start, before), from: start, total: all.length })
  }

  if (path === '/_ccpanel/chat/tool' && method === 'GET') {
    const id = url.searchParams.get('id') ?? ''
    const toolId = url.searchParams.get('toolId') ?? ''
    if (!toolId) return sendJson(response, 400, { error: '缺少 toolId' })
    const located = await locateTranscript(id)
    if (!located) return sendJson(response, 404, { error: '找不到该会话的转录' })
    const full = await fullTool(located.path, toolId)
    if (!full.result && !full.input) return sendJson(response, 404, { error: '该工具调用没有完整记录' })
    return sendJson(response, 200, { id, ...full })
  }

  if (path === '/_ccpanel/chat/subagents' && method === 'GET') {
    const session = url.searchParams.get('session') ?? ''
    if (!session) return sendJson(response, 400, { error: 'session is required' })
    const located = await locateTranscript(session)
    if (!located) return sendJson(response, 404, { error: '找不到该会话的转录' })
    return sendJson(response, 200, { subagents: await listSubagents(located.path) })
  }

  if (path === '/_ccpanel/chat/subagent' && method === 'GET') {
    const session = url.searchParams.get('session') ?? ''
    const toolId = url.searchParams.get('toolId') ?? ''
    if (!session || !toolId) return sendJson(response, 400, { error: 'session and toolId are required' })
    const located = await locateTranscript(session)
    if (!located) return sendJson(response, 404, { error: '找不到该会话的转录' })
    const found = await subagentFor(located.path, toolId)
    if (!found) return sendJson(response, 404, { error: '该工具调用没有子代理记录' })
    return sendJson(response, 200, found)
  }

  if (path === '/_ccpanel/chat/stream' && method === 'GET') {
    const id = url.searchParams.get('id') ?? ''
    if (!id) return sendJson(response, 400, { error: '缺少 id' })
    const runtime = RUNTIMES.get(id)
    if (!runtime || !runtime.started) {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      })
      response.write('data: {"live":false}\n\n')
      response.end()
      return
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    response.write('retry: 1000\n\n')
    let closed = false
    let last = ''
    let ticks = 0
    request.on('close', () => {
      closed = true
    })
    const tick = () => {
      if (closed) return
      try {
        const snap = runtime.snapshot()
        const payload = {
          live: true,
          status: snap.status,
          partial: snap.partial,
          pending: snap.pending,
          itemsTotal: snap.itemsTotal,
          updatedAt: snap.updatedAt,
          mode: snap.mode,
          effort: snap.effort,
          thinking: snap.thinking,
        }
        const key = JSON.stringify(payload)
        if (key !== last) {
          last = key
          response.write(`data: ${key}\n\n`)
        } else if (++ticks % 100 === 0) {
          response.write(': ping\n\n')
        }
      } catch {
        /* a dead runtime ends the stream on the next client retry */
      }
      if (!closed) setTimeout(tick, 120)
    }
    tick()
    return
  }

  if (path === '/_ccpanel/chat/options' && method === 'POST') {
    const body = await readBody(request)
    const id = String(body.id ?? '')
    if (!id) return sendJson(response, 400, { error: '缺少 id' })
    // Validate everything before creating a runtime: a rejected request must not
    // leave a half-built runtime occupying a MAX_LIVE slot.
    const modeValue = body.mode === undefined ? null : String(body.mode)
    if (modeValue !== null && !['default', 'acceptEdits', 'plan', 'auto', 'dontAsk'].includes(modeValue)) {
      return sendJson(response, 400, { error: `不支持的权限模式：${modeValue}` })
    }
    const effortValue =
      body.effort === undefined ? undefined : body.effort === 'inherit' || body.effort === null ? null : String(body.effort)
    if (effortValue !== undefined && effortValue !== null && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effortValue)) {
      return sendJson(response, 400, { error: `不支持的 effort：${effortValue}` })
    }
    if (body.cwd) {
      const cwd = expandHome(String(body.cwd))
      try {
        if (!statSync(cwd).isDirectory()) throw new Error('not a directory')
      } catch {
        return sendJson(response, 400, { error: `工作目录不存在：${cwd}` })
      }
    }
    let runtime = RUNTIMES.get(id)
    if (!runtime) {
      const located = await locateTranscript(id)
      if (located) {
        const live = await liveSessionIds(true)
        if (live.has(id)) {
          return sendJson(response, 409, { error: '终端会话只能只读，不能改设置', code: 'live_session' })
        }
        const [meta, history] = await Promise.all([
          headMeta(located.path),
          historyFor(located.path, await stat(located.path)),
        ])
        runtime = runtimeFor(id, { id, cwd: body.cwd || meta.cwd || homedir(), sourceId: id })
        // Creating the runtime must not hide the history it was opened on.
        runtime.items = history.slice(-250)
        runtime.totalPushed = history.length
      } else {
        if (!body.cwd) return sendJson(response, 400, { error: '新会话需要工作目录' })
        runtime = runtimeFor(id, { id, cwd: body.cwd })
      }
    } else if (runtime.items.length === 0 && runtime.totalPushed === 0) {
      // A runtime created earlier by a failed send may still lack its history.
      const located = await locateTranscript(id)
      if (located) {
        const history = await historyFor(located.path, await stat(located.path))
        runtime.items = history.slice(-250)
        runtime.totalPushed = history.length
      }
    }
    if (modeValue !== null) await runtime.setMode(modeValue)
    if (effortValue !== undefined) await runtime.setEffort(effortValue)
    if (body.thinking !== undefined) runtime.setThinking(Boolean(body.thinking))
    return sendJson(response, 200, runtime.snapshot())
  }

  if (path === '/_ccpanel/chat/send' && method === 'POST') {
    const body = await readBody(request)
    const id = String(body.id ?? '')
    if (!id) return sendJson(response, 400, { error: '缺少 id' })
    const text = String(body.text ?? '')
    const images = Array.isArray(body.images) ? body.images : []
    if (images.length > 4) return sendJson(response, 400, { error: '一次最多 4 张图片' })
    for (const image of images) {
      const media = String(image?.media_type ?? '')
      const data = String(image?.data ?? '')
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(media)) {
        return sendJson(response, 400, { error: `不支持的图片类型：${media}` })
      }
      if (!data || data.length > 7_000_000) {
        return sendJson(response, 400, { error: '图片过大或为空（单张上限约 5MB）' })
      }
    }
    if (!text.trim() && images.length === 0) return sendJson(response, 400, { error: '消息为空' })

    let runtime = RUNTIMES.get(id)
    if (runtime && !runtime.started && body.cwd) {
      // A draft whose first send failed must accept a corrected cwd.
      runtime.cwd = expandHome(body.cwd) || runtime.cwd
    }
    if (runtime && !runtime.started && runtime.sourceId) {
      // The options route may have created a runtime for a terminal session;
      // never let that turn into a silent second writer.
      const live = await liveSessionIds(true)
      if (live.has(id) && body.force !== true) {
        return sendJson(response, 409, {
          error: '该会话正在终端运行，面板只能只读。先 fork 到面板，或先在终端结束它。',
          code: 'live_session',
        })
      }
    }
    if (!runtime) {
      const located = await locateTranscript(id)
      if (located) {
        const live = await liveSessionIds(true)
        if (live.has(id) && body.force !== true) {
          return sendJson(response, 409, {
            error: '该会话正在终端运行，面板只能只读。先 fork 到面板，或先在终端结束它。',
            code: 'live_session',
          })
        }
        const [meta, history] = await Promise.all([
          headMeta(located.path),
          historyFor(located.path, await stat(located.path)),
        ])
        const cwd = body.cwd || meta.cwd || homedir()
        if (body.fork === true) {
          // A fork writes a new session id; the caller must have supplied one.
          const newId = String(body.newId ?? '')
          if (!newId) return sendJson(response, 400, { error: 'fork 需要 newId' })
          runtime = runtimeFor(newId, { id: newId, cwd, sourceId: id, fork: true })
          runtime.items = history.slice(-250)
          runtime.totalPushed = history.length
        } else {
          runtime = runtimeFor(id, { id, cwd, sourceId: id })
          // Seed the in-memory transcript so the panel keeps the history it showed.
          runtime.items = history.slice(-250)
          runtime.totalPushed = history.length
        }
      } else {
        if (!body.cwd) return sendJson(response, 400, { error: '新会话需要工作目录' })
        const cwd = expandHome(body.cwd) || homedir()
        try {
          if (!statSync(cwd).isDirectory()) throw new Error('not a directory')
        } catch {
          return sendJson(response, 400, { error: `工作目录不存在：${cwd}` })
        }
        runtime = runtimeFor(id, { id, cwd })
      }
    }

    await runtime.send(text, images)
    return sendJson(response, 200, runtime.snapshot())
  }

  if (path === '/_ccpanel/chat/fork' && method === 'POST') {
    const body = await readBody(request)
    const source = String(body.id ?? '')
    if (!source) return sendJson(response, 400, { error: '缺少 id' })
    const located = await locateTranscript(source)
    if (!located) return sendJson(response, 404, { error: '找不到该会话的转录' })
    const [meta, history] = await Promise.all([
      headMeta(located.path),
      historyFor(located.path, await stat(located.path)),
    ])
    const newId = randomUUID()
    const runtime = runtimeFor(newId, {
      id: newId,
      cwd: body.cwd || meta.cwd || homedir(),
      sourceId: source,
      fork: true,
    })
    // The fork continues the same context; show that context in the panel.
    runtime.items = history.slice(-250)
          runtime.totalPushed = history.length
    return sendJson(response, 200, runtime.snapshot())
  }

  if (path === '/_ccpanel/chat/stop' && method === 'POST') {
    const body = await readBody(request)
    const runtime = RUNTIMES.get(String(body.id ?? ''))
    if (!runtime) return sendJson(response, 404, { error: '没有正在运行的会话' })
    await runtime.interrupt()
    return sendJson(response, 200, runtime.snapshot())
  }

  if (path === '/_ccpanel/chat/permission' && method === 'POST') {
    const body = await readBody(request)
    const runtime = RUNTIMES.get(String(body.id ?? ''))
    if (!runtime) return sendJson(response, 404, { error: '没有正在运行的会话' })
    const requestId = String(body.requestId ?? '')
    if (!requestId) {
      return sendJson(response, 409, { error: '缺少 requestId：审批必须指定具体请求，不能默认放行' })
    }
    const decision = String(body.decision ?? 'deny')
    const ok = runtime.resolvePermission(requestId, decision, String(body.message ?? ''), body.answers)
    return sendJson(response, ok ? 200 : 409, ok ? runtime.snapshot() : { error: '没有待审批的请求' })
  }

  if (path === '/_ccpanel/chat/dispose' && method === 'POST') {
    const body = await readBody(request)
    const runtime = RUNTIMES.get(String(body.id ?? ''))
    if (runtime) await runtime.dispose()
    return sendJson(response, 200, { ok: true })
  }

  if (path === '/_ccpanel/chat/maintenance' && method === 'POST') {
    tickMaintenance()
    return sendJson(response, 200, { ok: true, live: RUNTIMES.size })
  }

  return sendJson(response, 404, { error: `未知路由 ${method} ${path}` })
}

async function handlePickDir(request, response, ctx) {
  if (request.method !== 'POST') return sendJson(response, 405, { error: '只支持 POST' })
  const picker = ctx.get('directoryPicker') ?? ctx.directoryPicker
  const capability = picker?.capability?.()
  if (!capability) return sendJson(response, 501, { error: '目录选择器不可用（DSH 未挂载 directoryPicker）' })
  if (capability.kind !== 'native') {
    return sendJson(response, 501, {
      error: `当前目录选择器是 ${capability.kind} 型，面板只接了系统目录对话框；请手动输入路径`,
      kind: capability.kind,
    })
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 180_000)
  try {
    const picked = await capability.pick(controller.signal)
    return sendJson(response, 200, { path: picked ?? null, kind: 'native' })
  } catch (error) {
    return sendJson(response, 500, { error: String(error?.message ?? error), kind: 'native' })
  } finally {
    clearTimeout(timer)
  }
}

async function handleFile(request, response) {
  if (request.method !== 'GET') return sendJson(response, 405, { error: '只支持 GET' })
  const url = new URL(request.url, 'http://placeholder.invalid')
  const target = url.searchParams.get('path') ?? ''
  if (!target) return sendJson(response, 400, { error: '缺少 path' })
  const suffix = url.pathname.replace(/\/+$/, '')
  try {
    if (suffix === '/_ccpanel/file/raw') {
      const { buffer, mime } = await readImage(target)
      response.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store', 'content-length': buffer.length })
      response.end(buffer)
      return
    }
    if (suffix === '/_ccpanel/file/pdf') {
      const { path: pdfPath, mime } = await pdfFile(target)
      const info = await stat(pdfPath)
      if (!info.isFile()) throw new Error('PDF 路径不是普通文件')
      response.writeHead(200, {
        'content-type': mime,
        'content-length': info.size,
        'content-disposition': 'inline',
        'cache-control': 'no-store',
      })
      const { createReadStream } = await import('node:fs')
      // pipeline owns stream errors; a bare pipe would let an EISDIR escape as an
      // uncaught exception and take the whole Desktop host process down.
      await pipeline(createReadStream(pdfPath), response)
      return
    }
    const preview = await previewFile(target)
    return sendJson(response, 200, preview)
  } catch (error) {
    if (response.headersSent) {
      response.destroy()
      return
    }
    const message = String(error?.message ?? error)
    // Client-side path mistakes are 4xx; only a real conversion failure is 5xx.
    const status = /ENOENT|no such file/i.test(message)
      ? 404
      : /LibreOffice|转换失败/i.test(message)
        ? 500
        : 400
    return sendJson(response, status, { error: message })
  }
}

async function handleOpen(request, response) {
  if (request.method !== 'POST') return sendJson(response, 405, { error: '只支持 POST' })
  const body = await readBody(request)
  const target = String(body.path ?? '')
  if (!target) return sendJson(response, 400, { error: '缺少 path' })
  let editor = false
  if (body.reveal === true) await revealInFinder(target)
  else editor = (await openWithDefaultApp(target))?.editor === true
  return sendJson(response, 200, { ok: true, editor })
}

/* ── registration ──────────────────────────────────────────────────── */

export function registerChatRoutes(ctx) {
  const disposers = []
  const add = (path, handler) => {
    disposers.push(
      ctx.webServer.register({
        kind: 'prefix',
        path,
        handler: async (request, response) => {
          const pathname = new URL(request.url, 'http://placeholder.invalid').pathname.replace(/\/+$/, '')
          const isTokenRoute = pathname === '/_ccpanel/chat/token'
          const isRawImage = pathname === '/_ccpanel/file/raw'
          if (!hostTrusted(request)) {
            sendJson(response, 403, { error: 'forbidden host/origin' })
            return
          }
          if (!isTokenRoute && !isRawImage && !tokenOk(request)) {
            sendJson(response, 401, { error: 'missing or invalid x-cc-hub-token' })
            return
          }
          try {
            await handler(request, response, ctx)
          } catch (error) {
            const status = Number(error?.status) || 500
            if (!response.headersSent) sendJson(response, status, { error: String(error?.message ?? error) })
            else response.destroy()
          }
        },
      }),
    )
  }

  add('/_ccpanel/chat', handleChat)
  add('/_ccpanel/file', handleFile)
  add('/_ccpanel/pick-dir', handlePickDir)
  add('/_ccpanel/open', handleOpen)

  const timer = setInterval(() => {
    try {
      tickMaintenance()
    } catch {
      /* maintenance never throws into the timer */
    }
  }, 60_000)
  timer.unref?.()

  return () => {
    clearInterval(timer)
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* already gone */
      }
    }
  }
}
