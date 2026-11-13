/**
 * Host half of the Claude Code sessions panel.
 *
 * Two surfaces:
 *  - HTTP routes under `/_ccpanel` used by the panel UI (read-only listing + digest)
 *  - Agent tools (`cc_*`) so the dsh agent itself can list, fork, spawn, read and
 *    stop Claude Code sessions instead of the human clicking a panel
 *
 * 边界（与只读档案类插件划清，别再互相长功能）：
 *   **本插件 = 接**（实时控制面）：会话列表／运行状态／摘要 digest／fork／后台任务／终端接管。
 *   **只读档案类插件 = 看**：按日期／项目聚合历史、台账与日志。
 *   判据：能在几秒内改变外部状态的动作放这里；只读聚合与判断放那边。
 * Read-only by default. The only writes are `claude --bg` / `claude stop|rm`,
 * and every operation refuses to touch a live interactive session's transcript:
 * cc has no file lock, so a second writer forks the conversation silently.
 */
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { OWNED } from './host/owned.js'
import { countSubagents } from './host/history.js'
import { TOKEN } from './host/token.js'

const CLAUDE_DIR = join(homedir(), '.claude')
const PROJECTS_DIR = join(CLAUDE_DIR, 'projects')
const SESSIONS_DIR = join(CLAUDE_DIR, 'sessions')
const JOBS_DIR = join(CLAUDE_DIR, 'jobs')

const TAIL_BYTES = 48 * 1024
const DIGEST_BYTES = 384 * 1024
const MAX_RECORDED = 200
const PREVIEW_CHARS = 140
const MAX_DIGEST_CHARS = 12000

/** Required services: the HTTP carrier for the routes, and the tool registry for `cc_*`. */
export const inject = ['webServer', 'tools']

/** Chat is opt-out: `CC_HUB_CHAT=0` restores the pre-chat list-only panel. */
const CHAT_ENABLED = process.env.CC_HUB_CHAT !== '0'
const CHAT_STATUS = { enabled: CHAT_ENABLED, error: '' }

/** Registration outcome kept for the `/_ccpanel/diag` route (no listing API on the registry). */
const REGISTRATION = { attempted: false, registered: [], errors: [] }

/* ── filesystem helpers ─────────────────────────────────────────────── */

async function readTail(file, bytes) {
  const fh = await open(file, 'r')
  try {
    const { size } = await fh.stat()
    const len = Math.min(size, bytes)
    if (len <= 0) return { text: '', size }
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, size - len)
    return { text: buf.toString('utf8'), size }
  } finally {
    await fh.close()
  }
}

function textOfRecord(record) {
  if (!record || typeof record !== 'object') return ''
  const message = record.message
  if (!message || typeof message !== 'object') return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join('\n')
  }
  return ''
}

function previewOf(record) {
  if (!record || record.type !== 'user') return ''
  const text = textOfRecord(record)
  if (!text || text.startsWith('<')) return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat
}

function lastPrompt(text) {
  const lines = String(text ?? '').split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (!line || line[0] !== '{') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const preview = previewOf(record)
    if (preview) return preview
  }
  return ''
}

async function headMeta(file) {
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(96 * 1024)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    let sessionId = ''
    let cwd = ''
    let firstPrompt = ''
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed[0] !== '{') continue
      let record
      try {
        record = JSON.parse(trimmed)
      } catch {
        continue
      }
      if (!sessionId && record.sessionId) sessionId = record.sessionId
      if (!cwd && typeof record.cwd === 'string') cwd = record.cwd
      if (!firstPrompt) {
        const preview = previewOf(record)
        if (preview && preview !== '[Request interrupted by user]') firstPrompt = preview
      }
      if (sessionId && cwd && firstPrompt) break
    }
    return { sessionId, cwd, firstPrompt }
  } finally {
    await fh.close()
  }
}

/** cc writes its own `ai-title` records; the last one in the tail is the freshest title. */
function lastAiTitle(text) {
  const lines = String(text ?? '').split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i].trim()
    if (!trimmed || trimmed[0] !== '{') continue
    if (!trimmed.includes('"ai-title"')) continue
    try {
      const record = JSON.parse(trimmed)
      const title = record?.aiTitle ?? record?.data?.title
      if (typeof title === 'string' && title.trim()) return title.trim()
    } catch {
      continue
    }
  }
  return ''
}

/* ── session discovery ──────────────────────────────────────────────── */

function claudeAgents() {
  return new Promise((resolve) => {
    execFile('claude', ['agents', '--json'], { timeout: 6000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(null)
      try {
        const parsed = JSON.parse(stdout)
        resolve(Array.isArray(parsed) ? parsed : null)
      } catch {
        resolve(null)
      }
    })
  })
}

async function registrySessions() {
  let entries = []
  try {
    entries = await readdir(SESSIONS_DIR)
  } catch {
    return []
  }
  const rows = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(await readFile(join(SESSIONS_DIR, entry), 'utf8'))
      if (!parsed || typeof parsed !== 'object' || !parsed.sessionId) continue
      rows.push({
        id: parsed.sessionId,
        sessionId: parsed.sessionId,
        pid: parsed.pid,
        cwd: parsed.cwd,
        kind: parsed.kind,
        entrypoint: parsed.entrypoint,
        name: parsed.name,
        startedAt: parsed.startedAt,
      })
    } catch {
      /* half-written registry file: ignore */
    }
  }
  return rows
}

/**
 * Metadata cache: a row's head/tail is re-read only when the file changes.
 * Without it, loading all transcripts on every refresh would re-read tens of
 * megabytes; with it, a 76-transcript install loads in one pass and refreshes
 * are stat-only.
 */
const META_CACHE = new Map()

async function candidateFiles() {
  let projects = []
  try {
    projects = await readdir(PROJECTS_DIR, { withFileTypes: true })
  } catch {
    return []
  }
  const candidates = []
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const dir = join(PROJECTS_DIR, project.name)
    let files = []
    try {
      files = await readdir(dir)
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const full = join(dir, file)
      try {
        const info = await stat(full)
        candidates.push({ file: full, project: project.name, id: file.slice(0, -'.jsonl'.length), size: info.size, mtimeMs: info.mtimeMs })
      } catch {
        continue
      }
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return candidates
}

async function rowFor(item) {
  const cached = META_CACHE.get(item.file)
  if (cached && cached.size === item.size && cached.mtimeMs === item.mtimeMs) return cached.row
  try {
    const [tail, head] = await Promise.all([readTail(item.file, TAIL_BYTES), headMeta(item.file)])
    const row = {
      id: head.sessionId || item.id,
      fileId: item.id,
      project: item.project,
      path: item.file,
      size: tail.size,
      mtime: item.mtimeMs,
      preview: lastPrompt(tail.text),
      firstPrompt: head.firstPrompt,
      title: lastAiTitle(tail.text),
      cwd: head.cwd,
    }
    META_CACHE.set(item.file, { size: item.size, mtimeMs: item.mtimeMs, row })
    if (META_CACHE.size > 5000) {
      const oldest = META_CACHE.keys().next().value
      META_CACHE.delete(oldest)
    }
    return row
  } catch {
    return null
  }
}

async function recordedSessions(limit = MAX_RECORDED, offset = 0) {
  const candidates = await candidateFiles()
  const slice = candidates.slice(offset, offset + limit)
  const rows = (await Promise.all(slice.map(rowFor))).filter(Boolean)
  rows.sort((a, b) => b.mtime - a.mtime)
  return { rows, total: candidates.length, shown: rows.length, offset }
}

async function collect(options = {}) {
  const [agents, recordedResult, registry] = await Promise.all([claudeAgents(), recordedSessions(options.limit, options.offset), registrySessions()])
  const recorded = recordedResult.rows
  const liveRows = agents ?? registry
  const byId = new Map()
  for (const row of recorded) byId.set(row.id, { ...row, live: false, kind: 'recorded' })
  for (const row of liveRows) {
    const id = row.sessionId ?? row.id
    if (!id) continue
    const base = byId.get(id) ?? { id }
    byId.set(id, {
      ...base,
      id,
      live: true,
      kind: row.kind ?? base.kind ?? 'interactive',
      status: row.status ?? row.state ?? null,
      name: row.name ?? base.name ?? '',
      cwd: row.cwd ?? base.cwd ?? '',
      pid: row.pid ?? null,
      entrypoint: row.entrypoint ?? null,
      startedAt: row.startedAt ?? null,
    })
  }
  const sessions = [...byId.values()].map((row) => ({ ...row, panelOwned: OWNED.has(row.id) })).sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1
    return (b.mtime ?? b.startedAt ?? 0) - (a.mtime ?? a.startedAt ?? 0)
  })
  // Only the panel asks for badges; the agent tools do not need one readdir per row.
  if (options.subagentCounts) {
    await Promise.all(
      sessions.map(async (row) => {
        row.subagents = await countSubagents(row.path)
      }),
    )
  }
  return {
    generatedAt: new Date().toISOString(),
    liveSource: agents ? 'claude agents --json' : 'session registry',
    counts: {
      total: sessions.length,
      live: sessions.filter((s) => s.live).length,
      // recordedTotal = 磁盘上真实转录数；total = 合并 live 后实际返回的行数（受 MAX_RECORDED 截断）
      recordedTotal: recordedResult.total,
      recordedShown: recordedResult.shown,
    },
    sessions,
  }
}

/** Resolve one session id to its transcript file, if one exists. */
async function transcriptOf(id) {
  const needle = String(id ?? '')
  if (!needle) return undefined
  // Exact id: look up the file directly, independent of the list window.
  const direct = (await candidateFiles()).find((item) => item.id === needle)
  if (direct) return rowFor(direct)
  // A short id is a convenience, never a guess: ambiguity (or no match) is "not found".
  const candidates = await candidateFiles()
  const matches = candidates.filter((item) => item.id.startsWith(needle))
  return matches.length === 1 ? rowFor(matches[0]) : undefined
}

/* ── digest (shared context) ────────────────────────────────────────── */

function digestOf(text, maxChars) {
  const lines = String(text ?? '').split('\n')
  const turns = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed[0] !== '{') continue
    let record
    try {
      record = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (record.isSidechain) continue
    const kind = record.type
    if (kind !== 'user' && kind !== 'assistant') continue
    const body = textOfRecord(record).replace(/\s+/g, ' ').trim()
    if (!body || body.startsWith('<')) continue
    turns.push({ role: kind === 'user' ? '用户' : '助手', body })
  }
  const picked = []
  let used = 0
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i]
    const line = `[${turn.role}] ${turn.body}`
    const remaining = maxChars - used
    if (remaining <= 1) break
    if (line.length > remaining) {
      // The newest turn alone can exceed the budget: keep its head with an
      // ellipsis rather than dropping the turn and returning an empty digest.
      picked.push(`${line.slice(0, Math.max(0, remaining - 1))}…`)
      used = maxChars
      break
    }
    picked.push(line)
    used += line.length + 1
  }
  picked.reverse()
  return { turns: turns.length, digest: picked.join('\n') }
}

/* ── process helpers ────────────────────────────────────────────────── */

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        timeout: options.timeout ?? 120_000,
        maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
        cwd: options.cwd ?? homedir(),
        env: process.env,
      },
      (error, stdout, stderr) => {
        resolve({
          ok: error === null,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          error: error === null ? null : String(error.message ?? error),
        })
      },
    )
  })
}

function isBackground(id) {
  const needle = String(id ?? '')
  return /^[0-9a-f]{6,16}$/i.test(needle)
}

/* ── agent tools ────────────────────────────────────────────────────── */


/** Human/agent-readable rendering: the model sees render()'s output, not the raw value. */
function renderSessionRows(value) {
  const lines = [`Claude Code sessions: ${value.total} total, ${value.live} live.`]
  if (value.sessions.length === 0) {
    lines.push('(no matching sessions)')
    return lines
  }
  for (const row of value.sessions) {
    const mark = row.live ? '*' : '-'
    const status = row.live ? (row.status || 'live') : 'archived'
    const what = row.title || row.name || '(untitled)'
    const parts = [`${mark} ${row.id.slice(0, 8)}`, status, row.kind, what]
    if (row.cwd) parts.push(row.cwd)
    if (!row.resumable) parts.push('NO-TRANSCRIPT')
    lines.push(parts.join(' | '))
  }
  return lines
}

const SESSION_ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    kind: { type: 'string' },
    status: { type: 'string' },
    live: { type: 'boolean' },
    resumable: { type: 'boolean' },
    cwd: { type: 'string' },
    name: { type: 'string' },
    title: { type: 'string' },
    preview: { type: 'string' },
  },
  required: ['id', 'live', 'resumable'],
}

function sessionRow(row) {
  return {
    id: String(row.id ?? ''),
    kind: String(row.kind ?? ''),
    status: String(row.status ?? ''),
    live: row.live === true,
    resumable: Boolean(row.path),
    cwd: String(row.cwd ?? ''),
    name: String(row.name ?? ''),
    title: String(row.title ?? row.firstPrompt ?? ''),
    preview: String(row.preview ?? ''),
  }
}

/** Register the cc_* tools; each failure is recorded for the diagnostic route. */
function registerTools(ctx) {
  REGISTRATION.attempted = true
  const tools = ctx.get('tools') ?? ctx.tools
  if (!tools || typeof tools.register !== 'function') {
    REGISTRATION.errors.push('tools service unavailable at apply time')
    ctx.logger?.info?.('cc-sessions-panel: tools service absent, agent tools not registered')
    return
  }

  const each = (definition) => {
    try {
      tools.register(definition)
      REGISTRATION.registered.push(definition.name)
    } catch (error) {
      const message = String(error?.message ?? error)
      REGISTRATION.errors.push(`${definition?.name}: ${message}`)
      ctx.logger?.warn?.(`cc-sessions-panel: tool ${definition?.name} not registered: ${message}`)
    }
  }

  each({
    name: 'cc_list_sessions',
    description:
      'List local Claude Code sessions (live plus recorded), with status, working directory and the latest human prompt. Use it before deciding which session to fork, read or stop. Read-only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        liveOnly: { type: 'boolean', description: 'Only return sessions that are running or registered right now.' },
        limit: { type: 'integer', description: 'Maximum rows to return (default 40).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer' },
          live: { type: 'integer' },
          sessions: { type: 'array', items: SESSION_ITEM },
        },
        required: ['total', 'live', 'sessions'],
      },
      render: (_args, value) => [{ type: 'text', text: renderSessionRows(value).join('\n') }],
    },
    async execute(args) {
      const data = await collect()
      const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(200, args.limit)) : 40
      const rows = data.sessions
        .filter((row) => (args?.liveOnly === true ? row.live : true))
        .slice(0, limit)
        .map(sessionRow)
      // total 报**磁盘上真实转录数**，sessions 是这次返回的行（受 MAX_RECORDED=40 截断）。
      // 2026-11-08 修：以前 total 就是 rows.length，调用方会把"最近 40"当成"共 40"。
      return { total: data.counts.recordedTotal ?? data.counts.total, live: data.counts.live, sessions: rows }
    },
  })

  each({
    name: 'cc_session_digest',
    description:
      'Read the tail of one Claude Code session as a role-tagged conversation digest, so its context can be reused inside this dsh conversation. Read-only; it never resumes or modifies the session.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Session id (full or unique prefix).' },
        maxChars: { type: 'integer', description: 'Digest budget in characters (default 12000).' },
      },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          turns: { type: 'integer' },
          digest: { type: 'string' },
        },
        required: ['id', 'turns', 'digest'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `Session ${value.id} · ${value.turns} turns · ${value.digest.length} chars\n\n${value.digest}`,
        },
      ],
    },
    async execute(args) {
      const row = await transcriptOf(args?.id)
      if (!row) throw new Error(`no transcript found for session ${args?.id}`)
      const tail = await readTail(row.path, DIGEST_BYTES)
      const limit = Number.isFinite(args?.maxChars)
        ? Math.max(500, Math.min(MAX_DIGEST_CHARS, args.maxChars))
        : MAX_DIGEST_CHARS
      const { turns, digest } = digestOf(tail.text, limit)
      return { id: row.id, turns, digest }
    },
  })

  each({
    name: 'cc_fork',
    description:
      'Fork a Claude Code session and run one prompt inside the fork. The original session is never written to (a new sessionId is created), so this is the safe way to continue someone else\'s session context. Returns the new session id and the answer. Costs a real API call: forking a very large session can cost several dollars, so prefer cc_session_digest when only the context is needed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Session id to fork from.' },
        prompt: { type: 'string', description: 'Prompt to run inside the forked session.' },
        cwd: { type: 'string', description: 'Working directory for the fork (default: the session\'s own cwd, else home).' },
      },
      required: ['id', 'prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sourceId: { type: 'string' },
          sessionId: { type: 'string' },
          answer: { type: 'string' },
          costUsd: { type: 'number' },
        },
        required: ['sourceId', 'sessionId', 'answer', 'costUsd'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `Forked ${value.sourceId} -> ${value.sessionId} (cost $${value.costUsd.toFixed(4)})\n\n${value.answer}`,
        },
      ],
    },
    async execute(args, exec) {
      const row = await transcriptOf(args?.id)
      if (!row) throw new Error(`no transcript found for session ${args?.id}`)
      const cwd = args?.cwd || row.cwd || homedir()
      const result = await run(
        'claude',
        ['-p', '--resume', row.id, '--fork-session', '--output-format', 'json', String(args.prompt)],
        { cwd, timeout: 600_000 },
      )
      if (!result.ok) throw new Error(`claude fork failed: ${result.stderr || result.error}`)
      let parsed
      try {
        parsed = JSON.parse(result.stdout)
      } catch {
        throw new Error(`unparseable claude output: ${result.stdout.slice(0, 400)}`)
      }
      return {
        sourceId: row.id,
        sessionId: String(parsed.session_id ?? ''),
        answer: String(parsed.result ?? ''),
        costUsd: Number(parsed.total_cost_usd ?? 0),
      }
    },
  })

  each({
    name: 'cc_spawn',
    description:
      'Start a new background Claude Code session with one prompt (`claude --bg`). Returns the short job id. Background sessions can later be read with cc_logs and stopped with cc_stop. Note: cc refuses background jobs in an untrusted directory.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: 'Prompt for the new session.' },
        cwd: { type: 'string', description: 'Working directory (default: current project directory).' },
        name: { type: 'string', description: 'Optional session name.' },
      },
      required: ['prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          jobId: { type: 'string' },
          output: { type: 'string' },
        },
        required: ['jobId', 'output'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.jobId
            ? `Started background session ${value.jobId}.\n\n${value.output}`
            : `cc --bg did not return a job id.\n\n${value.output}`,
        },
      ],
    },
    async execute(args, exec) {
      const cwd = args?.cwd || exec?.cwd || process.cwd()
      const argv = ['--bg']
      if (args?.name) argv.push('--name', String(args.name))
      argv.push(String(args.prompt))
      const result = await run('claude', argv, { cwd, timeout: 120_000 })
      const text = `${result.stdout}\n${result.stderr}`.trim()
      if (!result.ok) throw new Error(`claude --bg failed: ${text || result.error}`)
      const match = text.match(/\b([0-9a-f]{6,16})\b/i)
      return { jobId: match ? match[1] : '', output: text.slice(0, 2000) }
    },
  })

  each({
    name: 'cc_logs',
    description:
      'Read the recent output of a Claude Code session: `claude logs` for a background job, or the transcript tail for a recorded/interactive session.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Session or job id.' },
        lines: { type: 'integer', description: 'How many trailing lines to keep (default 80).' },
      },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          source: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['id', 'source', 'text'],
      },
      render: (_args, value) => [
        { type: 'text', text: `Logs of ${value.id} via ${value.source}\n\n${value.text}` },
      ],
    },
    async execute(args) {
      const id = String(args?.id ?? '')
      const keep = Number.isFinite(args?.lines) ? Math.max(1, Math.min(2000, args.lines)) : 80
      if (isBackground(id)) {
        const jobPath = join(JOBS_DIR, id)
        try {
          await stat(jobPath)
          const result = await run('claude', ['logs', id], { timeout: 30_000 })
          const text = `${result.stdout}\n${result.stderr}`.trim()
          if (result.ok && text) {
            return { id, source: 'claude logs', text: text.split('\n').slice(-keep).join('\n') }
          }
        } catch {
          /* not a background job; fall through to the transcript */
        }
      }
      const row = await transcriptOf(id)
      if (!row) throw new Error(`no transcript or background job for ${id}`)
      const tail = await readTail(row.path, TAIL_BYTES)
      return { id: row.id, source: 'transcript tail', text: tail.text.split('\n').slice(-keep).join('\n') }
    },
  })

  each({
    name: 'cc_stop',
    description:
      'Stop and remove a BACKGROUND Claude Code job (`claude stop` then `claude rm`). Interactive sessions started in a terminal cannot be stopped from outside; the tool explains that instead of failing silently.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Background job id (short id from cc_list_sessions).' },
      },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          stopped: { type: 'boolean' },
          detail: { type: 'string' },
        },
        required: ['id', 'stopped', 'detail'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.stopped
            ? `Stopped background job ${value.id}.\n\n${value.detail}`
            : `Could not stop ${value.id}.\n\n${value.detail}`,
        },
      ],
    },
    async execute(args) {
      const id = String(args?.id ?? '')
      if (!isBackground(id)) {
        return { id, stopped: false, detail: 'not a background job id; interactive sessions cannot be stopped from outside' }
      }
      const data = await collect()
      const row = data.sessions.find((item) => item.id === id || item.id?.startsWith(id))
      if (row && row.kind !== 'background') {
        return { id, stopped: false, detail: 'this session is interactive; stop it from its own terminal' }
      }
      const stop = await run('claude', ['stop', id], { timeout: 30_000 })
      const remove = await run('claude', ['rm', id], { timeout: 30_000 })
      const detail = `stop: ${(stop.stderr || stop.stdout).trim()} | rm: ${(remove.stderr || remove.stdout).trim()}`
      return { id, stopped: stop.ok || remove.ok, detail: detail.slice(0, 1000) }
    },
  })
}

/* ── plugin entry ───────────────────────────────────────────────────── */

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/_ccpanel',
        resource: async (request) => {
          const url = new URL(request.url, 'http://placeholder.invalid')
          const path = url.pathname.replace(/\/+$/, '')
          // A page can aim a no-cors request at loopback; only loopback Hosts
          // and, for the side-effecting fork, the process token are accepted.
          const host = String(request.headers.get('host') ?? '')
          if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
            return Response.json({ error: 'forbidden host' }, { status: 403 })
          }
          try {
            if (path === '/_ccpanel/sessions') {
              const limitRaw = Number(url.searchParams.get('limit'))
              const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(2000, Math.trunc(limitRaw))) : MAX_RECORDED
              const offsetRaw = Number(url.searchParams.get('offset'))
              const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.trunc(offsetRaw)) : 0
              return Response.json(await collect({ limit, offset, subagentCounts: true }))
            }
            if (path === '/_ccpanel/digest') {
              const id = url.searchParams.get('id') ?? ''
              const row = await transcriptOf(id)
              if (!row) return Response.json({ error: `no transcript for ${id}` }, { status: 404 })
              const tail = await readTail(row.path, DIGEST_BYTES)
              const budget = Number(url.searchParams.get('maxChars'))
              const { turns, digest } = digestOf(
                tail.text,
                Number.isFinite(budget) ? Math.max(500, Math.min(MAX_DIGEST_CHARS, budget)) : MAX_DIGEST_CHARS,
              )
              return Response.json({ id: row.id, turns, digest })
            }
            if (path === '/_ccpanel/merge') {
              const ids = (url.searchParams.get('ids') ?? '')
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean)
                .slice(0, 6)
              if (ids.length === 0) return Response.json({ error: 'ids is empty' }, { status: 400 })
              const per = Math.max(800, Math.min(6000, Math.floor(MAX_DIGEST_CHARS / ids.length)))
              const parts = []
              for (const id of ids) {
                const row = await transcriptOf(id)
                if (!row) {
                  parts.push({ id, title: '(no transcript)', turns: 0, digest: '' })
                  continue
                }
                const tail = await readTail(row.path, DIGEST_BYTES)
                const { turns, digest } = digestOf(tail.text, per)
                parts.push({ id: row.id, title: row.title || row.firstPrompt || '', turns, digest })
              }
              const text = parts
                .map((part, index) => `### ${index + 1}. ${part.title || part.id}\n${part.digest || '(no text)'}`)
                .join('\n\n')
              return Response.json({ parts, text })
            }
            if (path === '/_ccpanel/fork') {
              if (String(request.headers.get('x-cc-hub-token') ?? '') !== TOKEN) {
                return Response.json({ error: 'missing or invalid x-cc-hub-token' }, { status: 401 })
              }
              const id = url.searchParams.get('id') ?? ''
              const ask = url.searchParams.get('ask') ?? ''
              if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
                return Response.json({ error: 'id must be a full session UUID' }, { status: 400 })
              }
              if (!ask.trim()) return Response.json({ error: 'ask is required' }, { status: 400 })
              if (ask.trim().startsWith('-')) {
                return Response.json({ error: 'ask must not start with "-"' }, { status: 400 })
              }
              const row = await transcriptOf(id)
              if (!row) return Response.json({ error: `no transcript for ${id}` }, { status: 404 })
              const result = await run(
                'claude',
                ['-p', '--resume', row.id, '--fork-session', '--output-format', 'json', ask.trim()],
                { cwd: row.cwd || homedir(), timeout: 900_000 },
              )
              if (!result.ok) {
                return Response.json({ error: (result.stderr || result.error || 'fork failed').slice(0, 2000) }, { status: 502 })
              }
              let parsed
              try {
                parsed = JSON.parse(result.stdout)
              } catch {
                return Response.json({ error: `unparseable output: ${result.stdout.slice(0, 400)}` }, { status: 502 })
              }
              return Response.json({
                sourceId: row.id,
                sessionId: String(parsed.session_id ?? ''),
                answer: String(parsed.result ?? ''),
                costUsd: Number(parsed.total_cost_usd ?? 0),
              })
            }
            if (path === '/_ccpanel/diag') {
              const tools = ctx.get('tools') ?? ctx.tools
              const picker = ctx.get('directoryPicker') ?? ctx.directoryPicker
              return Response.json({
                toolsService: typeof tools?.register === 'function' ? 'present' : 'absent',
                directoryPicker: picker?.capability?.()?.kind ?? 'absent',
                chat: CHAT_ENABLED,
                chatError: CHAT_STATUS.error,
                injectDeclared: inject,
                attempted: REGISTRATION.attempted,
                registered: REGISTRATION.registered,
                errors: REGISTRATION.errors,
              })
            }
            return new Response(null, { status: 404 })
          } catch (error) {
            return Response.json({ error: String(error?.message ?? error) }, { status: 500 })
          }
        },
      }),
    'cc-sessions-panel: routes',
  )

  // The static `inject` above guarantees the tools service is mounted before
  // apply() runs, so registration is synchronous and its outcome is recorded.
  try {
    registerTools(ctx)
  } catch (error) {
    REGISTRATION.errors.push(String(error?.message ?? error))
    ctx.logger?.warn?.(`cc-sessions-panel: agent tools failed: ${error?.message ?? error}`)
  }

  if (CHAT_ENABLED) {
    // Loaded lazily and defensively: a missing SDK or a broken chat module must
    // never take the session list down with it.
    ctx.effect(() => {
      let disposed = false
      let disposeRoutes = null
      import('./host/routes.js')
        .then((module) => {
          if (disposed) return
          disposeRoutes = module.registerChatRoutes(ctx)
        })
        .catch((error) => {
          CHAT_STATUS.error = String(error?.message ?? error)
          ctx.logger?.warn?.(`cc-sessions-panel: chat routes failed to load: ${CHAT_STATUS.error}`)
        })
      return () => {
        disposed = true
        try {
          disposeRoutes?.()
        } catch {
          /* routes already gone */
        }
        import('./host/engine.js')
          .then((module) => module.disposeAll())
          .catch(() => {})
      }
    }, 'cc-sessions-panel: chat routes')
  }
}
