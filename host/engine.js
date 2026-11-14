/**
 * Claude Code chat runtime.
 *
 * One Runtime = one long-lived `claude` process driven through the Agent SDK.
 * The process is started on the first send (never on open) and kept alive so
 * later turns reuse the prompt cache and the session's in-process state.
 *
 * Boundary (same as the rest of this plugin): the panel is the only writer of a
 * session it owns. A session that is live in a terminal stays read-only — cc
 * has no file lock, and a second writer forks the conversation silently.
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { historyFor } from './history.js'
import { OWNED } from './owned.js'

const MAX_ITEMS = (() => {
  const value = Number(process.env.CC_HUB_WINDOW)
  return Number.isFinite(value) && value >= 20 && value <= 2000 ? Math.trunc(value) : 250
})()
const MAX_LIVE = 4
const IDLE_DISPOSE_MS = 30 * 60 * 1000
const MAX_INPUT_CHARS = 4_000

/** CLI version this plugin was tested against (SDK 0.3.323; CLI verified on macOS and Windows). */
export const TESTED_CC_VERSION = '2.1.325'

export function ccVersionWarning(version) {
  const value = String(version ?? '').trim().replace(/^v/i, '').split(/\s+/)[0]
  if (!value || value === TESTED_CC_VERSION) return ''
  return `Claude Code CLI ${value} 未在本插件验证（测试版 ${TESTED_CC_VERSION}，SDK 0.3.323）；如遇异常先回退 CLI`
}

/** @type {Map<string, Runtime>} */
export const RUNTIMES = new Map()

const WIN = process.platform === 'win32'

function looksExecutable(path) {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Windows PATH entries point at npm shims (`claude.cmd`), which
 * child_process.spawn refuses to launch without a shell (Node throws EINVAL for
 * .cmd/.bat). The shim only forwards to the native binary, so read it and hand
 * back that binary; a bare .cmd is unusable as `pathToClaudeCodeExecutable`.
 */
function spawnable(path) {
  if (!looksExecutable(path)) return undefined
  if (!WIN || !/\.(?:cmd|bat)$/i.test(path)) return path
  try {
    const shim = readFileSync(path, 'utf8').replace(/%dp0%/gi, `${dirname(path)}\\`)
    const match = shim.match(/"([^"\r\n]+\.exe)"/i) ?? shim.match(/([A-Za-z]:\\[^\s"\r\n]+\.exe)/i)
    if (match && looksExecutable(match[1])) return match[1]
  } catch {
    /* unreadable shim: try the next candidate */
  }
  return undefined
}

const CLAUDE_NAMES = WIN ? ['claude.exe', 'claude.cmd', 'claude.bat', 'claude'] : ['claude']

/** Resolve the installed CLI once; the SDK only speaks the protocol. */
function resolveClaude() {
  // Windows splits PATH on ';' — splitting on ':' would cut "C:\...".
  const pathDirs = String(process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
  const candidates = [
    process.env.CLAUDE_CODE_BIN,
    ...(WIN
      ? [
          process.env.APPDATA
            ? join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
            : '',
          join(homedir(), '.local', 'bin', 'claude.exe'),
          join(homedir(), '.claude', 'local', 'claude.exe'),
        ]
      : [
          '/opt/homebrew/bin/claude',
          '/usr/local/bin/claude',
          join(homedir(), '.claude', 'local', 'claude'),
        ]),
    ...pathDirs.flatMap((dir) => CLAUDE_NAMES.map((name) => join(dir, name))),
  ].filter(Boolean)
  for (const candidate of candidates) {
    const resolved = spawnable(candidate)
    if (resolved) return resolved
  }
  return undefined
}

export const CLAUDE_BIN = resolveClaude()

export function expandHome(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (text === '~') return homedir()
  // Windows users type `~\dir` as often as `~/dir`.
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return text
}

function clampString(value, max = MAX_INPUT_CHARS) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  if (typeof text !== 'string') return ''
  return text.length > max ? `${text.slice(0, max)}…（截断）` : text
}

function clampInput(input, max = 1200) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input ?? {}
  const out = {}
  for (const [key, value] of Object.entries(input)) {
    out[key] = typeof value === 'string' ? clampString(value, max) : value
  }
  return out
}

/** Pending approvals are a list: one assistant message can ask for several tools at once. */
function permissionView(pendingMap) {
  if (!pendingMap || pendingMap.size === 0) return []
  const list = []
  for (const entry of pendingMap.values()) {
    const input = entry.input && typeof entry.input === 'object' ? entry.input : {}
    const view = {}
    for (const [key, value] of Object.entries(input)) {
      view[key] = typeof value === 'string' ? clampString(value) : value
    }
    const suggestions = Array.isArray(entry.suggestions) ? entry.suggestions : []
    list.push({
      requestId: entry.requestId,
      toolName: entry.toolName,
      kind: entry.toolName === 'AskUserQuestion' ? 'question' : 'tool',
      questions: Array.isArray(entry.questions) ? entry.questions : undefined,
      input: view,
      at: entry.at,
      suggestions: suggestions.length,
      allowAlways: entry.allowAlways !== false,
      defaultToNo: entry.defaultToNo === true,
      destinations: [...new Set(suggestions.map((suggestion) => suggestion?.destination).filter(Boolean))],
    })
  }
  return list
}

export class Runtime {
  constructor({ id, cwd, sourceId = null, fork = false }) {
    this.id = id
    /** Session this runtime continues; null for a brand-new session. */
    this.sourceId = sourceId
    this.cwd = expandHome(cwd) || homedir()
    this.fork = Boolean(fork)
    this.items = []
    this.totalPushed = 0
    this.partial = null
    this.status = 'idle'
    this.error = ''
    /** requestId → { toolName, input, suggestions, at, resolve, defaultToNo, allowAlways } */
    this.pending = new Map()
    this.init = null
    this.result = null
    this.model = null
    // Panel defaults; a user pick or the CLI's init can override them.
    this.mode = 'auto'
    this.effort = 'xhigh'
    this.hooksSeen = 0
    this.inFlight = false
    this.interrupted = false
    this.partialDoneAt = 0
    this.includeThinking = false
    this.createdAt = Date.now()
    this.updatedAt = Date.now()
    this.lastActivity = Date.now()
    this.queue = []
    this.waiters = new Set()
    this.epoch = 0
    this.stopped = false
    this.query = null
    this.loop = null
    this.seen = new Set()
    this.stderr = ''
    this.permSeq = 0
    this.itemSeq = 0
    /** True once the process has been started at least once. */
    this.started = false
  }

  /**
   * One queue, one iterator per process generation. An iterator from an older
   * generation must never consume a message meant for the new process, and a
   * consumer stopping (return()) must not mark the whole runtime stopped.
   */
  promptStream() {
    const rt = this
    const epoch = ++this.epoch
    let currentWaiter = null
    return {
      [Symbol.asyncIterator]() {
        return this
      },
      async next() {
        while (true) {
          if (rt.stopped || rt.epoch !== epoch) return { value: undefined, done: true }
          if (rt.queue.length > 0) return { value: rt.queue.shift(), done: false }
          await new Promise((resolve) => {
            currentWaiter = resolve
            rt.waiters.add(resolve)
          })
          rt.waiters.delete(currentWaiter)
          currentWaiter = null
        }
      },
      async return() {
        if (currentWaiter) rt.waiters.delete(currentWaiter)
        return { value: undefined, done: true }
      },
    }
  }

  notifyWaiters() {
    const waiters = [...this.waiters]
    this.waiters.clear()
    for (const resolve of waiters) {
      try {
        resolve()
      } catch {
        /* already gone */
      }
    }
  }

  options() {
    const options = {
      cwd: this.cwd,
      settingSources: ['user', 'project', 'local'],
      permissionMode: this.mode || 'default',
      includePartialMessages: true,
      includeHookEvents: true,
      pathToClaudeCodeExecutable: CLAUDE_BIN,
      env: { ...process.env },
      canUseTool: (toolName, input, extra) => this.askPermission(toolName, input, extra),
      stderr: (line) => {
        this.stderr = `${this.stderr}${String(line)}\n`.slice(-4000)
      },
    }
    if (!CLAUDE_BIN) delete options.pathToClaudeCodeExecutable
    if (this.effort) options.effort = this.effort
    if (this.sourceId && this.fork) {
      // Fork: read the source, write a brand-new session under this.id.
      options.resume = this.sourceId
      options.forkSession = true
      options.sessionId = this.id
    } else if (this.sourceId) {
      // Resume: continue the same session id in place.
      options.resume = this.sourceId
    } else {
      options.sessionId = this.id
    }
    return options
  }

  ensureStarted() {
    if (this.query) return
    this.started = true
    OWNED.add(this.id)
    this.query = query({ prompt: this.promptStream(), options: this.options() })
    this.loop = this.consume().catch((error) => {
      this.error = String(error?.message ?? error)
      this.status = 'error'
      this.updatedAt = Date.now()
    })
  }

  async consume() {
    try {
      for await (const message of this.query) {
        this.handle(message)
      }
    } finally {
      // The process is gone. A later send must create a new one, and it must
      // resume the session rather than try to reuse this id as a new session.
      this.query = null
    }
    if (!this.stopped) {
      this.sourceId = this.sourceId || this.id
      // Exiting while a turn was in flight and before any result is a failure,
      // not a clean close: say so instead of showing a silent "closed".
      if (this.inFlight && this.status !== 'idle' && this.status !== 'error') {
        this.error = '进程已退出但没有返回结果（可能是 CLI 崩溃或配置问题）'
        this.status = 'error'
        this.result = null
      } else {
        this.status = this.status === 'error' ? 'error' : 'closed'
      }
      this.updatedAt = Date.now()
    }
  }

  handle(message) {
    const type = message?.type
    if (type === 'system') {
      if (message.subtype === 'init') {
        this.versionWarning = ccVersionWarning(message.claude_code_version)
        this.init = {
          model: message.model,
          cwd: message.cwd,
          claudeCodeVersion: message.claude_code_version,
          permissionMode: message.permissionMode,
          outputStyle: message.output_style,
          tools: Array.isArray(message.tools) ? message.tools : [],
          skills: Array.isArray(message.skills) ? message.skills : [],
          slashCommands: Array.isArray(message.slash_commands) ? message.slash_commands : [],
          terminalSlashCommands: Array.isArray(message.terminal_slash_commands) ? message.terminal_slash_commands : [],
          mcpServers: Array.isArray(message.mcp_servers)
            ? message.mcp_servers.map((server) => ({ name: String(server?.name ?? ''), status: String(server?.status ?? '') }))
            : [],
          plugins: Array.isArray(message.plugins)
            ? message.plugins.map((plugin) =>
                typeof plugin === 'string'
                  ? { name: plugin, version: '' }
                  : { name: String(plugin?.name ?? ''), version: String(plugin?.version ?? '') },
              )
            : [],
          agents: Array.isArray(message.agents) ? message.agents : [],
        }
        this.model = message.model ?? this.model
        if (message.cwd) this.cwd = message.cwd
        if (message.permissionMode) this.mode = message.permissionMode
        if (this.fork) {
          // The fork now owns its own session: a restart must resume the fork
          // (this.id), never re-fork from the source and drop its turns.
          this.fork = false
          this.sourceId = this.id
        }
        this.updatedAt = Date.now()
        return
      }
      this.handleSystemNotice(message)
      return
    }

    if (type === 'stream_event') {
      this.handleStream(message.event)
      return
    }

    if (type === 'assistant') {
      const uuid = message.uuid
      if (uuid && this.seen.has(uuid)) return
      if (uuid) this.seen.add(uuid)
      const blocks = message.message?.content
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (!block || typeof block !== 'object') continue
          if (block.type === 'text' && String(block.text ?? '').trim()) {
            this.push({ role: 'assistant', kind: 'text', text: block.text, ts: Date.now() })
          } else if (block.type === 'thinking') {
            if (this.includeThinking && String(block.thinking ?? '').trim()) {
              this.push({ role: 'assistant', kind: 'thinking', text: clampString(block.thinking, 4000), ts: Date.now() })
            }
          } else if (block.type === 'tool_use') {
            this.push({
              role: 'assistant',
              kind: 'tool',
              toolId: block.id ?? '',
              name: String(block.name ?? 'tool'),
              input: clampInput(block.input),
              ts: Date.now(),
            })
          }
        }
      }
      // Keep the last partial for a short window so a 120ms SSE tick can still
      // deliver it; the client suppresses it once the final text is in.
      if (this.partial && this.partial.text) {
        this.partialDoneAt = Date.now()
      } else {
        this.partial = null
      }
      this.lastActivity = Date.now()
      this.updatedAt = Date.now()
      return
    }

    if (type === 'user') {
      const blocks = message.message?.content
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block && block.type === 'tool_result') {
            this.push({
              role: 'tool',
              kind: 'result',
              toolId: block.tool_use_id ?? '',
              text: clampString(resultText(block.content), 2_500),
              isError: block.is_error === true,
              ts: Date.now(),
            })
          }
        }
      }
      this.updatedAt = Date.now()
      return
    }

    if (type === 'result') {
      const interrupted = this.interrupted
      this.result = {
        subtype: message.subtype,
        isError: Boolean(message.is_error) && !interrupted,
        turns: message.num_turns ?? null,
        durationMs: message.duration_ms ?? null,
        costUsd: message.total_cost_usd ?? null,
        at: Date.now(),
      }
      // The CLI reports an interrupted turn as error_during_execution; that is
      // a user stop, not a failure, and must not paint the session red.
      this.status = message.is_error && !interrupted ? 'error' : 'idle'
      this.error = message.is_error && !interrupted ? String(message.result ?? message.subtype ?? 'error').slice(0, 2000) : ''
      this.inFlight = false
      this.interrupted = false
      if (this.partial && this.partial.text) {
        this.partialDoneAt = this.partialDoneAt || Date.now()
      } else {
        this.partial = null
      }
      this.lastActivity = Date.now()
      this.updatedAt = Date.now()
      return
    }

    if (type === 'system' && message.subtype === 'error') {
      this.error = String(message.error ?? '').slice(0, 2000)
      this.updatedAt = Date.now()
    }
  }

  /** System banners worth showing: slash-command output, hook failures, denials. */
  handleSystemNotice(message) {
    const subtype = message.subtype
    if (subtype === 'local_command_output') {
      const content = String(message.content ?? '').trim()
      if (content) this.push({ role: 'system', kind: 'notice', text: content })
      return
    }
    if (subtype === 'informational') {
      const content = String(message.content ?? '').trim()
      if (content) this.push({ role: 'system', kind: 'notice', level: message.level ?? 'notice', text: content })
      return
    }
    if (subtype === 'permission_denied') {
      this.push({
        role: 'system',
        kind: 'notice',
        level: 'warning',
        text: `工具 ${message.tool_name} 被拒绝${message.decision_reason_type ? `（${message.decision_reason_type}）` : ''}`,
      })
      return
    }
    if (subtype === 'hook_started') {
      this.hooksSeen += 1
      this.updatedAt = Date.now()
      return
    }
    if (subtype === 'hook_response') {
      if (message.outcome && message.outcome !== 'success') {
        const detail = String(message.stderr || message.output || '').trim().slice(0, 800)
        this.push({
          role: 'system',
          kind: 'notice',
          level: 'warning',
          text: `hook ${message.hook_name} 失败${message.exit_code ? ` (exit ${message.exit_code})` : ''}${detail ? `：${detail}` : ''}`,
        })
      }
      return
    }
    if (subtype === 'status' && message.permissionMode && message.permissionMode !== this.mode) {
      // The CLI can change mode itself (plan exit, permission prompt answers).
      this.mode = message.permissionMode
      this.updatedAt = Date.now()
    }
  }

  handleStream(event) {
    if (!event || typeof event !== 'object') return
    if (event.type === 'content_block_start') {
      const type = event.content_block?.type
      if (type === 'text') this.partial = { text: '', thinking: '' }
      if (type === 'thinking') this.partial = this.partial ?? { text: '', thinking: '' }
      return
    }
    if (event.type === 'content_block_delta') {
      const delta = event.delta
      if (!delta) return
      if (delta.type === 'text_delta') {
        this.partial = this.partial ?? { text: '', thinking: '' }
        this.partial.text += String(delta.text ?? '')
        this.updatedAt = Date.now()
      } else if (delta.type === 'thinking_delta') {
        this.partial = this.partial ?? { text: '', thinking: '' }
        this.partial.thinking += String(delta.thinking ?? '')
      }
      return
    }
    if (event.type === 'content_block_stop') {
      // The durable assistant message follows; nothing to do until it arrives.
    }
  }

  push(item) {
    this.totalPushed += 1
    this.items.push({ key: `i${++this.itemSeq}-${Date.now().toString(36)}`, ...item })
    if (this.items.length > MAX_ITEMS) this.items = this.items.slice(-MAX_ITEMS)
    this.lastActivity = Date.now()
    this.updatedAt = Date.now()
  }

  askPermission(toolName, input, extra) {
    if (this.stopped) return Promise.resolve({ behavior: 'deny', message: '会话已关闭' })
    this.status = 'waiting'
    this.updatedAt = Date.now()
    const requestId = `p${++this.permSeq}`
    const signal = extra?.signal
    return new Promise((resolve) => {
      let settled = false
      const deliver = (value) => {
        if (settled) return
        settled = true
        this.pending.delete(requestId)
        if (this.pending.size === 0) this.status = 'running'
        this.updatedAt = Date.now()
        resolve(value)
      }
      this.pending.set(requestId, {
        requestId,
        toolName,
        questions: toolName === 'AskUserQuestion' && Array.isArray(input?.questions) ? input.questions : undefined,
        input: input ?? {},
        suggestions: extra?.suggestions,
        defaultToNo: extra?.defaultToNo === true,
        allowAlways: extra?.suppressAlwaysAllowRule !== true,
        at: Date.now(),
        deliver,
      })
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', () => deliver({ behavior: 'deny', message: '操作已取消' }), { once: true })
      }
    })
  }

  /** Deny every pending ask; used by dispose/interrupt so no Promise is left hanging. */
  denyAllPending(message) {
    for (const entry of [...this.pending.values()]) {
      entry.deliver({ behavior: 'deny', message })
    }
    this.pending.clear()
  }

  resolvePermission(requestId, decision, message, answers) {
    const entry = requestId ? this.pending.get(requestId) : this.pending.values().next().value
    if (!entry) return false
    // Whitelist: any unknown value is a deny, never an accidental allow.
    const allow = decision === 'allow' || decision === 'allow_always'
    let result
    if (!allow) {
      result = { behavior: 'deny', message: message || '用户拒绝执行' }
    } else {
      const updatedInput =
        entry.toolName === 'AskUserQuestion' && answers && typeof answers === 'object'
          ? { ...entry.input, answers }
          : entry.input
      result = { behavior: 'allow', updatedInput }
      if (decision === 'allow_always' && entry.allowAlways && Array.isArray(entry.suggestions) && entry.suggestions.length > 0) {
        result.updatedPermissions = entry.suggestions
      }
    }
    entry.deliver(result)
    return true
  }

  async send(text, images = []) {
    const body = String(text ?? '').trim()
    const pictures = Array.isArray(images) ? images.filter((image) => image?.data && image?.media_type) : []
    if (!body && pictures.length === 0) throw new Error('消息为空')
    if (this.stopped) throw new Error('会话已关闭')
    if (!CLAUDE_BIN) throw new Error('找不到 claude 可执行文件（CLAUDE_CODE_BIN 或 PATH）')
    try {
      if (!statSync(this.cwd).isDirectory()) throw new Error('not a directory')
    } catch {
      throw new Error(`工作目录不存在：${this.cwd}`)
    }
    this.ensureStarted()
    const blocks = []
    if (body) blocks.push({ type: 'text', text: body })
    for (const image of pictures) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: image.media_type, data: image.data } })
    }
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: blocks },
      parent_tool_use_id: null,
    })
    this.notifyWaiters()
    if (body) this.push({ role: 'user', kind: 'text', text: body, ts: Date.now() })
    if (pictures.length > 0) this.push({ role: 'user', kind: 'image', count: pictures.length, ts: Date.now() })
    this.result = null
    this.partial = null
    this.partialDoneAt = 0
    this.inFlight = true
    this.interrupted = false
    this.status = 'running'
    this.error = ''
    this.lastActivity = Date.now()
    this.updatedAt = Date.now()
    return true
  }

  /** Permission mode, live when the process is running, otherwise applied at next start. */
  async setMode(mode) {
    const allowed = new Set(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk'])
    if (!allowed.has(mode)) throw new Error(`不支持的权限模式：${mode}`)
    if (this.query) await this.query.setPermissionMode(mode)
    this.mode = mode
    this.updatedAt = Date.now()
    return this.snapshot()
  }

  setThinking(value) {
    this.includeThinking = Boolean(value)
    this.updatedAt = Date.now()
    return this.snapshot()
  }

  /** Effort level, live via the flag-settings layer; null follows settings. */
  async setEffort(level) {
    const allowed = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
    const value = level === 'inherit' || level === null || level === '' ? null : String(level)
    if (value !== null && !allowed.has(value)) throw new Error(`不支持的 effort：${level}`)
    if (this.query) await this.query.applyFlagSettings({ effortLevel: value })
    this.effort = value
    this.updatedAt = Date.now()
    return this.snapshot()
  }

  async interrupt() {
    this.interrupted = true
    try {
      // No protocol round-trip may hang the panel forever.
      await Promise.race([
        this.query?.interrupt(),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ])
    } catch (error) {
      this.error = String(error?.message ?? error)
    }
    // A stopped turn must not leave approval cards behind: approving one after
    // the stop would flip the status back to running with nothing running.
    this.denyAllPending('已停止，审批作废')
    this.status = 'idle'
    this.updatedAt = Date.now()
  }

  async dispose() {
    this.stopped = true
    this.denyAllPending('会话已关闭')
    this.notifyWaiters()
    try {
      if (typeof this.query?.close === 'function') {
        await Promise.race([this.query.close(), new Promise((resolve) => setTimeout(resolve, 10_000))])
      } else {
        await Promise.race([
          this.query?.return?.(),
          new Promise((resolve) => setTimeout(resolve, 10_000)),
        ])
      }
    } catch {
      /* process already gone */
    }
    // close() only signals the child; wait for the read loop to end so the id is
    // not released while the old process could still write the transcript.
    try {
      await Promise.race([this.loop, new Promise((resolve) => setTimeout(resolve, 3000))])
    } catch {
      /* loop already failed */
    }
    this.query = null
    OWNED.delete(this.id)
    RUNTIMES.delete(this.id)
  }

  snapshot() {
    if (this.partialDoneAt && Date.now() - this.partialDoneAt > 400) {
      this.partial = null
      this.partialDoneAt = 0
    }
    return {
      id: this.id,
      cwd: this.cwd,
      status: this.status,
      model: this.init?.model ?? this.model ?? null,
      ccVersion: this.init?.claudeCodeVersion ?? null,
      versionWarning: this.versionWarning ?? '',
      permissionMode: this.init?.permissionMode ?? null,
      mode: this.mode,
      effort: this.effort,
      slashCommands: this.init ? this.init.slashCommands.filter((name) => !this.init.terminalSlashCommands.includes(name)) : [],
      hookEvents: this.hooksSeen,
      settings: this.init
        ? {
            model: this.init.model,
            ccVersion: this.init.claudeCodeVersion,
            outputStyle: this.init.outputStyle,
            permissionMode: this.init.permissionMode,
            tools: this.init.tools.length,
            skills: this.init.skills,
            commands: this.init.slashCommands.filter((name) => !this.init.terminalSlashCommands.includes(name)),
            mcpServers: this.init.mcpServers,
            plugins: this.init.plugins,
            agents: this.init.agents.length,
            cwd: this.init.cwd,
          }
        : null,
      pending: permissionView(this.pending),
      items: this.items.slice(-MAX_ITEMS),
      itemsTotal: this.totalPushed,
      itemsFrom: Math.max(0, this.totalPushed - Math.min(this.items.length, MAX_ITEMS)),
      itemsRev: this.totalPushed,
      thinking: this.includeThinking,
      partial: this.partial && (this.partial.text || this.partial.thinking) ? { ...this.partial } : null,
      result: this.result,
      error: this.error,
      stderr: this.status === 'error' ? this.stderr.slice(-1200) : '',
      source: 'panel',
      started: this.started,
      updatedAt: this.updatedAt,
      createdAt: this.createdAt,
    }
  }
}

function resultText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && block.type === 'text' ? String(block.text ?? '') : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

export function runtimeFor(id, options = {}) {
  let runtime = RUNTIMES.get(id)
  if (runtime) return runtime
  if (RUNTIMES.size >= MAX_LIVE) {
    // Reclaim the least recently used idle runtime; never kill a running one.
    const idle = [...RUNTIMES.values()]
      .filter((item) => item.status === 'idle' || item.status === 'closed')
      .sort((a, b) => a.lastActivity - b.lastActivity)[0]
    if (idle) idle.dispose().catch(() => {})
  }
  runtime = new Runtime({ id, ...options })
  RUNTIMES.set(id, runtime)
  return runtime
}

/** Read-only snapshot for sessions the panel does not own. */
export async function archivedSnapshot(row, { live = false, includeThinking = false } = {}) {
  const all = row.path ? await historyFor(row.path, await stat(row.path), includeThinking) : []
  return {
    id: row.id,
    cwd: row.cwd || '',
    status: live ? 'live-readonly' : 'archived',
    model: null,
    ccVersion: null,
    mode: null,
    effort: null,
    settings: null,
    pending: null,
    items: all.slice(-MAX_ITEMS),
    itemsTotal: all.length,
    itemsFrom: Math.max(0, all.length - MAX_ITEMS),
    itemsRev: `${Math.floor(row.mtime ?? 0)}:${all.length}:${includeThinking ? 't' : 'n'}`,
    thinking: includeThinking,
    partial: null,
    result: null,
    error: '',
    source: live ? 'terminal' : 'archive',
    started: false,
    updatedAt: row.mtime ?? Date.now(),
    createdAt: row.mtime ?? null,
  }
}

export function tickMaintenance() {
  const now = Date.now()
  for (const runtime of [...RUNTIMES.values()]) {
    const busy = runtime.status === 'running' || runtime.status === 'waiting'
    const idle = now - runtime.lastActivity
    if (busy) continue
    if (idle > IDLE_DISPOSE_MS) runtime.dispose().catch(() => {})
  }
}

export async function disposeAll() {
  await Promise.all([...RUNTIMES.values()].map((runtime) => runtime.dispose().catch(() => {})))
}
