/**
 * Per-session user marks (favorite / tags / note) and the soft-delete trash.
 *
 * Lives outside the plugin directory on purpose: `dsh plugin` upgrades and
 * `npm install` rewrite node_modules, and months of hand-written notes must not
 * disappear with them. Everything is plain JSON on disk so it can be inspected,
 * backed up and diffed without this plugin:
 *
 *   ~/.claude/cc-sessions-hub/meta.json
 *   ~/.claude/cc-sessions-hub/trash/<stamp>-<id>-<rand>/entry.json
 *
 * Two rules the rest of the code relies on:
 *  - The client never supplies a filesystem path. Ids arrive from the list,
 *    resolve through locateTranscript(), and restore paths come from our own
 *    manifest and are re-checked against ~/.claude before anything moves.
 *  - Deleting is a move, never an unlink. A transcript is real work; the trash
 *    can restore it byte for byte.
 */
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

const ID_OK = /^[A-Za-z0-9._-]{1,64}$/
const MAX_TAGS = 12
const MAX_TAG_LEN = 24
const MAX_NOTE = 500
const MAX_NAME = 80
const EMPTY = { favorite: false, tags: [], note: '', name: '' }

function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}

/** The CC data tree whose transcripts this store may touch. Overridable for tests. */
function claudeRoot() {
  return process.env.CC_HUB_CLAUDE_DIR ? resolve(process.env.CC_HUB_CLAUDE_DIR) : join(homedir(), '.claude')
}

/** Overridable for tests; production always lands next to the CC data. */
export function dataRoot() {
  return process.env.CC_HUB_DATA ? resolve(process.env.CC_HUB_DATA) : join(claudeRoot(), 'cc-sessions-hub')
}

function storePath() {
  return join(dataRoot(), 'meta.json')
}

function trashRoot() {
  return join(dataRoot(), 'trash')
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** True when `target` is `root` itself or lives under it. */
function inside(root, target) {
  const base = resolve(root)
  const full = resolve(target)
  if (samePath(base, full)) return true
  return full.startsWith(base + sep) || (process.platform === 'win32' && full.toLowerCase().startsWith(base.toLowerCase() + sep))
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/* ── meta store ─────────────────────────────────────────────────────── */

function emptyStore() {
  return { version: 1, sessions: {} }
}

function normalizeTags(list) {
  const out = []
  for (const raw of Array.isArray(list) ? list : []) {
    const tag = String(raw ?? '').trim().replace(/\s+/g, ' ')
    if (!tag || tag.length > MAX_TAG_LEN) continue
    if (!out.includes(tag)) out.push(tag)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

function normalizeNote(value) {
  return String(value ?? '').trim().slice(0, MAX_NOTE)
}

/** Display name; empty means "fall back to the transcript's own title". */
function normalizeName(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_NAME)
}

function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null
  const record = {
    favorite: raw.favorite === true,
    tags: normalizeTags(raw.tags),
    note: normalizeNote(raw.note),
    name: normalizeName(raw.name),
  }
  if (raw.updatedAt) record.updatedAt = String(raw.updatedAt)
  return isEmpty(record) ? null : record
}

function isEmpty(record) {
  return !record || (record.favorite !== true && record.tags.length === 0 && record.note === '' && record.name === '')
}

function normalizeStore(raw) {
  const store = emptyStore()
  const sessions = raw && typeof raw === 'object' && raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {}
  for (const [id, value] of Object.entries(sessions)) {
    if (!ID_OK.test(id)) continue
    const record = normalizeRecord(value)
    if (record) store.sessions[id] = record
  }
  return store
}

async function readStore() {
  let text
  try {
    text = await readFile(storePath(), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyStore()
    throw error
  }
  try {
    return normalizeStore(JSON.parse(text))
  } catch {
    // Hand-edited file broke JSON: keep the original next to it instead of
    // overwriting someone's notes on the next write.
    try {
      await rename(storePath(), `${storePath()}.corrupt-${Date.now()}`)
    } catch {
      /* keep going with an empty store */
    }
    return emptyStore()
  }
}

async function writeStore(store) {
  const root = dataRoot()
  await mkdir(root, { recursive: true, mode: 0o700 })
  const target = storePath()
  const tmp = join(root, `.meta.${process.pid}.${randomUUID()}.tmp`)
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, target)
}

/**
 * Serialize writes: panel clicks can arrive faster than a read-modify-write
 * round trip, and two interleaved writes would drop one of them.
 */
let chain = Promise.resolve()
function enqueue(task) {
  const run = chain.then(task, task)
  chain = run.catch(() => {})
  return run
}

function vocabulary(store) {
  const counts = new Map()
  for (const record of Object.values(store.sessions)) {
    for (const tag of record.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
    .map(([tag]) => tag)
}

/**
 * Attach marks to list rows; the list must never fail because meta.json did.
 * Returns the tag vocabulary for autocomplete.
 */
export async function attachMeta(rows) {
  let store
  try {
    store = await readStore()
  } catch {
    store = emptyStore()
  }
  for (const row of rows) {
    const record = store.sessions[row.id]
    row.meta = record ? { ...record, tags: [...record.tags] } : { ...EMPTY, tags: [] }
  }
  return vocabulary(store)
}

/**
 * Mutate marks. Actions:
 *   { action: 'favorite', ids, value }
 *   { action: 'tags', ids, add?, remove?, set? }
 *   { action: 'note', ids, note }
 *   { action: 'edit', ids, tags?, note?, favorite? }   (row editor: one POST)
 */
export async function applyMeta(input = {}) {
  const action = String(input.action ?? '')
  const ids = [...new Set((Array.isArray(input.ids) ? input.ids : [input.id]).filter(Boolean).map(String))]
  if (ids.length === 0) throw httpError(400, '缺少会话 id')
  if (ids.length > 200) throw httpError(400, '一次最多 200 条 id')
  if (!ids.every((id) => ID_OK.test(id))) throw httpError(400, '会话 id 不合法')
  const known = new Set(['favorite', 'tags', 'note', 'rename', 'edit'])
  if (!known.has(action)) throw httpError(400, `未知操作 ${action}`)

  return enqueue(async () => {
    const store = await readStore()
    const stamp = new Date().toISOString()
    const updated = {}
    for (const id of ids) {
      const previous = store.sessions[id] ?? EMPTY
      const record = {
        favorite: previous.favorite === true,
        tags: [...(previous.tags ?? [])],
        note: previous.note ?? '',
        name: previous.name ?? '',
      }
      if (action === 'favorite') {
        record.favorite = input.value === true
      } else if (action === 'tags') {
        if (Array.isArray(input.set)) {
          record.tags = normalizeTags(input.set)
        } else {
          const add = normalizeTags(input.add)
          const remove = new Set(normalizeTags(input.remove))
          record.tags = [...record.tags.filter((tag) => !remove.has(tag)), ...add.filter((tag) => !record.tags.includes(tag))]
        }
      } else if (action === 'note') {
        record.note = normalizeNote(input.note)
      } else if (action === 'rename') {
        record.name = normalizeName(input.name)
      } else {
        if (Array.isArray(input.tags)) record.tags = normalizeTags(input.tags)
        if (Object.prototype.hasOwnProperty.call(input, 'note')) record.note = normalizeNote(input.note)
        if (Object.prototype.hasOwnProperty.call(input, 'name')) record.name = normalizeName(input.name)
        if (Object.prototype.hasOwnProperty.call(input, 'favorite')) record.favorite = input.favorite === true
      }
      record.tags = record.tags.slice(0, MAX_TAGS)
      record.updatedAt = stamp
      if (isEmpty(record)) delete store.sessions[id]
      else store.sessions[id] = record
      updated[id] = isEmpty(record) ? { ...EMPTY, tags: [], updatedAt: stamp } : record
    }
    await writeStore(store)
    return { updated, tags: vocabulary(store) }
  })
}

/* ── trash ──────────────────────────────────────────────────────────── */

function stamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

async function movePath(from, to) {
  await mkdir(dirname(to), { recursive: true, mode: 0o700 })
  try {
    await rename(from, to)
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    // Trash lives under ~/.claude like the transcripts; EXDEV only happens when
    // someone points CC_HUB_DATA at another volume. Copy then drop the original.
    await cp(from, to, { recursive: true, force: false, errorOnExist: true })
    await rm(from, { recursive: true, force: true })
  }
}

function entryDir(name) {
  const safe = String(name ?? '')
  if (!ID_OK.test(safe) || safe.startsWith('.')) throw httpError(400, '回收站条目名不合法')
  const dir = join(trashRoot(), safe)
  if (!inside(trashRoot(), dir) || samePath(resolve(trashRoot()), resolve(dir))) throw httpError(400, '回收站条目名不合法')
  return dir
}

/**
 * Move one session's files into the trash. Returns the entry name so the UI can
 * point at it; the transcript path is resolved by the caller, never the client.
 */
export async function trashSession({ id, transcript, project = '', title = '', cwd = '', kind = '' } = {}) {
  if (!ID_OK.test(String(id ?? ''))) throw httpError(400, '会话 id 不合法')
  if (!transcript) throw httpError(400, '缺少转录路径')
  const projectsRoot = join(claudeRoot(), 'projects')
  if (!inside(projectsRoot, transcript)) throw httpError(400, '转录不在 ~/.claude/projects 下')

  const stem = basename(transcript).replace(/\.jsonl$/, '')
  const dir = dirname(transcript)
  const historyRoot = join(claudeRoot(), 'file-history')
  const candidates = [
    { kind: 'transcript', from: transcript },
    { kind: 'session-dir', from: join(dir, stem) },
    { kind: 'file-history', from: join(historyRoot, stem) },
    { kind: 'file-history', from: join(historyRoot, id) },
  ].filter((item, index, list) => list.findIndex((other) => samePath(resolve(other.from), resolve(item.from))) === index)

  let size = 0
  try {
    size = (await stat(transcript)).size
  } catch {
    /* size is cosmetic */
  }

  const entry = `${stamp()}-${String(id).slice(0, 8)}-${randomUUID().slice(0, 4)}`
  const target = join(trashRoot(), entry)
  const moves = []
  try {
    await mkdir(target, { recursive: true, mode: 0o700 })
    for (const item of candidates) {
      if (!(await exists(item.from))) continue
      const name = item.kind === 'transcript' ? 'transcript.jsonl' : item.kind
      let to = join(target, name)
      for (let n = 2; await exists(to); n += 1) to = join(target, `${name}-${n}`)
      await movePath(item.from, to)
      moves.push({ kind: item.kind, from: item.from, to })
    }
    if (moves.length === 0) throw httpError(404, '找不到可移动的会话文件')

    // Snapshot the marks first; the manifest must exist before the marks leave
    // meta.json, or a failed write would leave files that cannot be restored.
    let meta = null
    try {
      const store = await readStore()
      meta = store.sessions[id] ?? null
    } catch {
      /* marks are best-effort; the transcript is what matters */
    }

    const manifest = {
      id,
      deletedAt: new Date().toISOString(),
      title: String(title ?? '').slice(0, 300),
      cwd: String(cwd ?? ''),
      project: String(project ?? ''),
      kind: String(kind ?? ''),
      size,
      meta,
      moves,
    }
    await writeFile(join(target, 'entry.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })

    if (meta) {
      try {
        const store = await readStore()
        delete store.sessions[id]
        await writeStore(store)
      } catch {
        /* marks stay in meta.json; an orphaned record is harmless */
      }
    }
    return { entry, id, size }
  } catch (error) {
    for (const move of moves.reverse()) {
      try {
        await movePath(move.to, move.from)
      } catch {
        /* best-effort rollback */
      }
    }
    try {
      await rm(target, { recursive: true, force: true })
    } catch {
      /* nothing to clean */
    }
    throw error
  }
}

export async function listTrash() {
  let names = []
  try {
    names = await readdir(trashRoot())
  } catch {
    return []
  }
  const entries = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    try {
      const raw = JSON.parse(await readFile(join(trashRoot(), name, 'entry.json'), 'utf8'))
      if (!raw?.id) continue
      entries.push({
        entry: name,
        id: String(raw.id),
        deletedAt: String(raw.deletedAt ?? ''),
        title: String(raw.title ?? ''),
        cwd: String(raw.cwd ?? ''),
        project: String(raw.project ?? ''),
        kind: String(raw.kind ?? ''),
        size: Number(raw.size) || 0,
      })
    } catch {
      /* half-written or foreign directory: leave it alone */
    }
  }
  entries.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
  return entries
}

export async function restoreTrash(name) {
  const dir = entryDir(name)
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(dir, 'entry.json'), 'utf8'))
  } catch {
    throw httpError(404, '回收站条目不存在或已损坏')
  }
  const moves = Array.isArray(manifest.moves) ? manifest.moves : []
  if (!manifest.id || moves.length === 0) throw httpError(410, '回收站条目损坏，无法恢复')

  const projectsRoot = join(claudeRoot(), 'projects')
  const historyRoot = join(claudeRoot(), 'file-history')
  for (const move of moves) {
    if (!inside(projectsRoot, move.from) && !inside(historyRoot, move.from)) throw httpError(400, '恢复路径越界')
    if (!inside(dir, move.to)) throw httpError(400, '回收站条目损坏')
    if (!(await exists(move.to))) throw httpError(410, '回收站文件缺失，无法恢复')
    if (await exists(move.from)) {
      throw Object.assign(new Error(`原位置已有同名文件：${basename(move.from)}`), { status: 409 })
    }
  }

  const done = []
  try {
    for (const move of moves) {
      await movePath(move.to, move.from)
      done.push(move)
    }
  } catch (error) {
    for (const move of done.reverse()) {
      try {
        await movePath(move.from, move.to)
      } catch {
        /* best-effort rollback */
      }
    }
    throw error
  }

  if (manifest.meta) {
    try {
      await enqueue(async () => {
        const store = await readStore()
        const previous = store.sessions[manifest.id] ?? null
        const snapshot = normalizeRecord(manifest.meta) ?? EMPTY
        const merged = {
          favorite: previous?.favorite === true || snapshot.favorite === true,
          tags: normalizeTags([...(previous?.tags ?? []), ...(snapshot.tags ?? [])]),
          note: previous?.note || snapshot.note || '',
          name: previous?.name || snapshot.name || '',
          updatedAt: new Date().toISOString(),
        }
        if (!isEmpty(merged)) store.sessions[manifest.id] = merged
        await writeStore(store)
      })
    } catch {
      /* the transcript is back; marks are best-effort */
    }
  }

  await rm(dir, { recursive: true, force: true })
  return { id: manifest.id, entry: name }
}

export async function purgeTrash(name) {
  const dir = entryDir(name)
  if (!(await exists(dir))) throw httpError(404, '回收站条目不存在')
  await rm(dir, { recursive: true, force: true })
  return { entry: name }
}
