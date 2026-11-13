/**
 * Claude Code transcript (JSONL) → chat items.
 *
 * Read-only by design: this module opens the transcript, never writes it.
 * Claude Code has no file lock, so a second writer would silently fork the
 * conversation — the panel's only write path is a new process that owns the
 * session, never a direct append here.
 */
import { createReadStream } from 'node:fs'
import { open, readFile, readdir } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { basename, dirname, join } from 'node:path'

const MAX_BYTES = 6 * 1024 * 1024
const MAX_TEXT = 12_000
const MAX_RESULT = 2_500
const MAX_INPUT_STRING = 1_200

function clamp(text, max) {
  const value = String(text ?? '')
  if (value.length <= max) return { text: value, truncated: false, fullLength: value.length }
  return { text: `${value.slice(0, max)}\n…（截断 ${value.length - max} 字）`, truncated: true, fullLength: value.length }
}

/** Tool inputs are shown as JSON; keep a huge Write payload from dominating the poll. */
function clampInput(input, maxString = MAX_INPUT_STRING) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { value: input ?? {}, truncated: false }
  const out = {}
  let truncated = false
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') {
      const result = clamp(value, maxString)
      out[key] = result.text
      if (result.truncated) truncated = true
    } else {
      out[key] = value
    }
  }
  return { value: out, truncated }
}

/** Read the tail of a transcript without loading a multi-megabyte file whole. */
export async function readTranscriptTail(file, maxBytes = MAX_BYTES) {
  const fh = await open(file, 'r')
  try {
    const { size } = await fh.stat()
    const start = Math.max(0, size - maxBytes)
    const len = size - start
    if (len <= 0) return { text: '', size, truncated: false }
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, start)
    let text = buf.toString('utf8')
    if (start > 0) {
      const newline = text.indexOf('\n')
      text = newline >= 0 ? text.slice(newline + 1) : ''
    }
    return { text, size, truncated: start > 0 }
  } finally {
    await fh.close()
  }
}

/** Session metadata from the head of a transcript (id, cwd, first prompt). */
export async function headMeta(file) {
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
      if (!firstPrompt && record.type === 'user') {
        const content = record.message?.content
        let body = ''
        if (typeof content === 'string') {
          body = content
        } else if (Array.isArray(content)) {
          body = content
            .filter((block) => block && block.type === 'text')
            .map((block) => String(block.text ?? ''))
            .join('\n')
        }
        if (body && !body.startsWith('<')) firstPrompt = body.slice(0, 140)
      }
      if (sessionId && cwd) break
    }
    return { sessionId, cwd, firstPrompt }
  } finally {
    await fh.close()
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

/**
 * Turn transcript records into a flat, renderable item list.
 *
 * Items are deliberately transport-shaped (plain JSON) so the client can render
 * them without knowing anything about Claude Code's event schema.
 */
export function parseTranscript(text, options = {}) {
  const maxText = options.maxText ?? MAX_TEXT
  const maxResult = options.maxResult ?? MAX_RESULT
  const includeThinking = options.includeThinking === true
  const includeSidechain = options.includeSidechain === true
  const maxThinking = options.maxThinking ?? 2000
  const items = []
  const toolNames = new Map()
  let n = 0

  const push = (item) => {
    items.push({ key: `h${n++}`, ...item })
  }

  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed[0] !== '{') continue
    let record
    try {
      record = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!record || typeof record !== 'object') continue
    // Subagent traffic is parsed only when explicitly requested (its own file).
    if (record.isSidechain && !includeSidechain) continue

    if (record.type === 'user') {
      const message = record.message
      const content = message?.content
      if (typeof content === 'string') {
        const body = content.trim()
        if (body && !body.startsWith('<')) {
          const value = clamp(body, maxText)
          push({ role: 'user', kind: 'text', text: value.text, ts: record.timestamp })
        }
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue
          if (block.type === 'text') {
            const body = String(block.text ?? '').trim()
            if (body && !body.startsWith('<')) {
              const value = clamp(body, maxText)
              push({ role: 'user', kind: 'text', text: value.text, ts: record.timestamp })
            }
          } else if (block.type === 'image') {
            push({
              role: 'user',
              kind: 'image',
              mediaType: String(block.source?.media_type ?? ''),
              count: 1,
              ts: record.timestamp,
            })
          } else if (block.type === 'tool_result') {
            const value = clamp(resultText(block.content), maxResult)
            push({
              role: 'tool',
              kind: 'result',
              toolId: block.tool_use_id ?? '',
              name: toolNames.get(block.tool_use_id) ?? '',
              text: value.text,
              truncated: value.truncated,
              fullLength: value.fullLength,
              isError: block.is_error === true,
              ts: record.timestamp,
            })
          }
        }
      }
      continue
    }

    if (record.type === 'assistant') {
      const blocks = record.message?.content
      if (!Array.isArray(blocks)) continue
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue
        if (block.type === 'text') {
          const body = String(block.text ?? '')
          if (body.trim()) {
            const value = clamp(body, maxText)
            push({ role: 'assistant', kind: 'text', text: value.text, ts: record.timestamp })
          }
        } else if (block.type === 'thinking') {
          if (includeThinking) {
            const body = String(block.thinking ?? '').trim()
            if (body) {
              const value = clamp(body, maxThinking)
              push({ role: 'assistant', kind: 'thinking', text: value.text, ts: record.timestamp })
            }
          }
        } else if (block.type === 'tool_use') {
          toolNames.set(block.id, block.name)
          const clipped = clampInput(block.input)
          push({
            role: 'assistant',
            kind: 'tool',
            toolId: block.id ?? '',
            name: String(block.name ?? 'tool'),
            input: clipped.value,
            inputTruncated: clipped.truncated,
            ts: record.timestamp,
          })
        }
      }
    }
  }

  return items
}

/** Cache parsed transcripts by file identity so polling stays cheap. */
const CACHE = new Map()

export async function historyFor(file, stat, includeThinking = false) {
  const key = `${file}:${stat.size}:${Math.floor(stat.mtimeMs)}:${includeThinking ? 't' : 'n'}`
  const cached = CACHE.get(file)
  if (cached && cached.key === key) return cached.items
  const { text } = await readTranscriptTail(file)
  const items = parseTranscript(text, { includeThinking })
  CACHE.set(file, { key, items })
  if (CACHE.size > 20) {
    const oldest = CACHE.keys().next().value
    CACHE.delete(oldest)
  }
  return items
}


/** Unclamped tool result + input, for the "full output" view. Streams the whole
 * transcript (the 6MB tail used for the list may not reach an older call). */
export async function fullTool(file, toolId, max = 200_000) {
  let result = null
  let input = null
  let name = ''
  const stream = createReadStream(file)
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed[0] !== '{') continue
      if (!trimmed.includes(toolId)) continue
      let record
      try {
        record = JSON.parse(trimmed)
      } catch {
        continue
      }
      if (record.type === 'assistant') {
        for (const block of record.message?.content ?? []) {
          if (block?.type === 'tool_use' && block.id === toolId) {
            input = block.input ?? null
            name = String(block.name ?? '')
          }
        }
      } else if (record.type === 'user') {
        for (const block of record.message?.content ?? []) {
          if (block?.type === 'tool_result' && block.tool_use_id === toolId) {
            result = resultText(block.content)
          }
        }
      }
      if (input !== null && result !== null) break
    }
  } finally {
    lines.close()
    stream.destroy()
  }
  const truncated = typeof result === 'string' && result.length > max
  return {
    toolId,
    name,
    input,
    result: truncated ? result.slice(0, max) : result,
    truncated,
  }
}


/**
 * One subagent's transcript, linked to the Task tool call that spawned it.
 * CC stores it under `<project>/<sessionId>/subagents/agent-*.jsonl`; the
 * sibling `.meta.json` carries `toolUseId` (and description/agentType/finished).
 */
export async function subagentFor(sessionFile, toolUseId) {
  if (!sessionFile || !toolUseId) return null
  const dir = join(dirname(sessionFile), basename(sessionFile, '.jsonl'), 'subagents')
  let entries = []
  try {
    entries = await readdir(dir)
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.endsWith('.meta.json')) continue
    try {
      const meta = JSON.parse(await readFile(join(dir, entry), 'utf8'))
      if (String(meta?.toolUseId ?? '') !== String(toolUseId)) continue
      const jsonl = join(dir, entry.replace(/\.meta\.json$/, '.jsonl'))
      const { text } = await readTranscriptTail(jsonl, 4 * 1024 * 1024)
      const items = parseTranscript(text, { includeSidechain: true, maxResult: 4_000 })
      return {
        id: String(meta.agentId ?? entry),
        description: String(meta.description ?? ''),
        agentType: String(meta.agentType ?? ''),
        finished: meta.finished === true,
        items,
      }
    } catch {
      continue
    }
  }
  return null
}


/** All subagents recorded for one session (metadata only; items load on demand). */
export async function listSubagents(sessionFile) {
  if (!sessionFile) return []
  const dir = join(dirname(sessionFile), basename(sessionFile, '.jsonl'), 'subagents')
  let entries = []
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const list = []
  for (const entry of entries) {
    if (!entry.endsWith('.meta.json')) continue
    try {
      const meta = JSON.parse(await readFile(join(dir, entry), 'utf8'))
      list.push({
        id: String(meta.agentId ?? entry),
        toolUseId: String(meta.toolUseId ?? ''),
        description: String(meta.description ?? ''),
        agentType: String(meta.agentType ?? ''),
        finished: meta.finished === true,
      })
    } catch {
      continue
    }
  }
  return list
}
