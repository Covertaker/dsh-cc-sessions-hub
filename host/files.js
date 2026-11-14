/**
 * File preview for the chat panel.
 *
 * Reads are bounded and read-only. The panel previews text and images itself
 * because DSH's right Sidebar is not mounted while a global main panel (this
 * one) replaces the Conversation.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, statSync } from 'node:fs'
import { mkdir, open, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'

const TEXT_MAX = 600 * 1024
const IMAGE_MAX = 12 * 1024 * 1024

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
}

/** Preview kinds that need more than a raw text pane. */
const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdown'])
const HTML_EXT = new Set(['.html', '.htm'])
const OFFICE_EXT = new Set(['.docx', '.doc', '.odt', '.rtf'])
const PDF_EXT = new Set(['.pdf'])

const PDF_CACHE = join(tmpdir(), 'cc-hub-pdf')
const WIN = process.platform === 'win32'

function firstExecutable(candidates) {
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      /* next */
    }
  }
  return null
}

function firstFile(candidates) {
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      /* next */
    }
  }
  return null
}

const SOFFICE = firstExecutable([
  process.env.SOFFICE_BIN,
  ...(WIN
    ? [
        join(process.env.ProgramFiles ?? 'C:\\Program Files', 'LibreOffice', 'program', 'soffice.exe'),
        join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'LibreOffice', 'program', 'soffice.exe'),
      ]
    : [
        '/opt/homebrew/bin/soffice',
        join(homedir(), '.local/bin/dsoffice'),
        '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      ]),
].filter(Boolean))

/**
 * Fallback converter: DSH desktop ships `@deepseek-ai/libreoffice-kit`, a
 * prebuilt LibreOffice that needs no system install (Windows included). Its CLI
 * converts one document per process, so no single-instance queue is involved.
 */
function kitCliCandidates() {
  const rel = ['node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js']
  const list = [process.env.CC_HUB_LO_KIT_CLI]
  // The desktop host is Electron: its own exe sits next to the bundled kit.
  if (process.versions.electron || WIN) {
    list.push(join(dirname(process.execPath), 'resources', 'app.asar.unpacked', 'dsh', ...rel))
  }
  if (process.env.LOCALAPPDATA) {
    list.push(
      join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar.unpacked', 'dsh', ...rel),
    )
  }
  for (const profile of ['desktop', 'web', 'headless']) {
    list.push(join(homedir(), '.dsh', 'profiles', profile, ...rel))
  }
  return list.filter(Boolean)
}

const LO_KIT_CLI = firstFile(kitCliCandidates())

/** Node used to run the kit CLI: inside Electron, the exe runs as Node with a flag. */
function nodeRuntime() {
  const env = { ...process.env }
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  return { command: process.execPath, env }
}

export function normalizePath(input) {
  let value = String(input ?? '').trim()
  if (!value) throw new Error('路径为空')
  if (value.startsWith('~')) value = join(homedir(), value.slice(1))
  if (!isAbsolute(value)) throw new Error('只支持绝对路径')
  return resolve(value)
}

export async function previewFile(input) {
  const path = normalizePath(input)
  const info = await stat(path)
  if (!info.isFile()) throw new Error('不是普通文件')
  const ext = extname(path).toLowerCase()
  const mime = IMAGE_MIME[ext]
  if (mime) {
    if (info.size > IMAGE_MAX) {
      return { path, kind: 'binary', size: info.size, mtime: info.mtimeMs, reason: '图片超过 12MB，未加载' }
    }
    return { path, kind: 'image', mime, size: info.size, mtime: info.mtimeMs }
  }
  if (PDF_EXT.has(ext)) {
    return { path, kind: 'pdf', size: info.size, mtime: info.mtimeMs }
  }
  if (OFFICE_EXT.has(ext)) {
    if (!SOFFICE && !LO_KIT_CLI) {
      return { path, kind: 'binary', size: info.size, mtime: info.mtimeMs, reason: '没找到 LibreOffice，Word/ODT 无法预览，可用「打开」交给系统应用' }
    }
    return { path, kind: 'office', size: info.size, mtime: info.mtimeMs }
  }
  const textKind = MARKDOWN_EXT.has(ext) ? 'markdown' : HTML_EXT.has(ext) ? 'html' : 'text'
  if (info.size > TEXT_MAX) {
    // Show a bounded head rather than refusing: a huge log is still readable.
    const fh = await open(path, 'r')
    try {
      const buf = Buffer.alloc(TEXT_MAX)
      const { bytesRead } = await fh.read(buf, 0, TEXT_MAX, 0)
      const text = buf.subarray(0, bytesRead).toString('utf8')
      return { path, kind: textKind, text, truncated: true, size: info.size, mtime: info.mtimeMs }
    } finally {
      await fh.close()
    }
  }
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(Math.max(1, info.size))
    const { bytesRead } = await fh.read(buf, 0, info.size, 0)
    if (buf.subarray(0, Math.min(bytesRead, 8192)).includes(0)) {
      return { path, kind: 'binary', size: info.size, mtime: info.mtimeMs, reason: '二进制文件，未预览' }
    }
    return {
      path,
      kind: textKind,
      text: buf.subarray(0, bytesRead).toString('utf8'),
      truncated: false,
      size: info.size,
      mtime: info.mtimeMs,
    }
  } finally {
    await fh.close()
  }
}

const PDF_JOBS = new Map()
// LibreOffice keeps a single-instance user profile; parallel conversions fail.
// (The kit CLI is one process per call, but serializing costs nothing here.)
let SOFFICE_QUEUE = Promise.resolve()
function queueConversion(task) {
  const run = SOFFICE_QUEUE.then(task, task)
  SOFFICE_QUEUE = run.catch(() => {})
  return run
}

/**
 * PDF bytes for a PDF or Office document. Office files are converted locally
 * with the installed LibreOffice and cached by (path, size, mtime).
 */
export async function pdfFile(input) {
  const path = normalizePath(input)
  const ext = extname(path).toLowerCase()
  if (PDF_EXT.has(ext)) {
    const info = await stat(path)
    if (!info.isFile()) throw new Error('不是普通文件')
    if (info.size > 50 * 1024 * 1024) throw new Error('PDF 超过 50MB，未预览')
    return { path, mime: 'application/pdf' }
  }
  if (!OFFICE_EXT.has(ext)) throw new Error('不是 PDF 或 Office 文档')
  if (!SOFFICE && !LO_KIT_CLI) throw new Error('没找到 LibreOffice，无法转换 Word/ODT')
  const info = await stat(path)
  if (!info.isFile()) throw new Error('不是普通文件')
  const key = createHash('sha1').update(`${path}:${info.size}:${Math.floor(info.mtimeMs)}`).digest('hex').slice(0, 20)
  const dir = join(PDF_CACHE, key)
  const target = join(dir, `${basename(path).replace(/\.[^.]+$/, '')}.pdf`)
  let cachedSize = null
  try {
    cachedSize = (await stat(target)).size
  } catch {
    cachedSize = null
  }
  if (cachedSize !== null) {
    if (cachedSize > 50 * 1024 * 1024) throw new Error('PDF 超过 50MB，未预览')
    return { path: target, mime: 'application/pdf' }
  }
  if (PDF_JOBS.has(key)) {
    await PDF_JOBS.get(key)
    const concurrent = await stat(target)
    if (concurrent.size > 50 * 1024 * 1024) throw new Error('PDF 超过 50MB，未预览')
    return { path: target, mime: 'application/pdf' }
  }
  const job = queueConversion(async () => {
    await mkdir(dir, { recursive: true })
    if (SOFFICE) {
      await new Promise((resolvePromise, reject) => {
        execFile(
          SOFFICE,
          ['--headless', '--convert-to', 'pdf', '--outdir', dir, path],
          { timeout: 180_000 },
          (error, _stdout, stderr) => {
            if (error) reject(new Error(`LibreOffice 转换失败：${String(stderr || error.message).slice(0, 400)}`))
            else resolvePromise(true)
          },
        )
      })
      return
    }
    await new Promise((resolvePromise, reject) => {
      const { command, env } = nodeRuntime()
      execFile(
        command,
        [LO_KIT_CLI, 'convert', '--input', path, '--output', target],
        { timeout: 180_000, env, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) reject(new Error(`LibreOffice 转换失败：${String(stderr || stdout || error.message).slice(0, 400)}`))
          else resolvePromise(true)
        },
      )
    })
  })
  PDF_JOBS.set(key, job)
  try {
    await job
    const info2 = await stat(target)
    if (!info2.isFile()) throw new Error('转换结果不是普通文件')
    if (info2.size > 50 * 1024 * 1024) throw new Error('PDF 超过 50MB，未预览')
  } finally {
    PDF_JOBS.delete(key)
  }
  return { path: target, mime: 'application/pdf' }
}

export async function readImage(input) {
  const path = normalizePath(input)
  const info = await stat(path)
  if (!info.isFile()) throw new Error('不是普通文件')
  if (info.size > IMAGE_MAX) throw new Error('图片超过 12MB')
  const mime = IMAGE_MIME[extname(path).toLowerCase()]
  if (!mime) throw new Error('不是支持的图片类型')
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(info.size)
    await fh.read(buf, 0, info.size, 0)
    return { buffer: buf, mime }
  } finally {
    await fh.close()
  }
}

/** Types with no default handler on a fresh install; fall back to a text editor. */
const NO_DEFAULT_APP_FALLBACK = new Set(['.jsonl'])

/** Run a Windows shell verb through cmd; `start` needs an empty title argument. */
function shellStart(command, path) {
  // `start "" <target>`: the empty first argument is the window title; without
  // it a quoted path is taken for the title and nothing opens.
  const args = command ? ['/d', '/s', '/c', 'start', '', command, path] : ['/d', '/s', '/c', 'start', '', path]
  return new Promise((resolvePromise, reject) => {
    execFile('cmd.exe', args, { timeout: 15_000, windowsHide: true }, (error) =>
      error ? reject(error) : resolvePromise(true),
    )
  })
}

export function openWithDefaultApp(input) {
  const path = normalizePath(input)
  if (WIN) {
    return new Promise((resolvePromise, reject) => {
      // cmd `start` honours the association; rundll32 covers the cases where
      // `start` refuses (no association but a registered handler).
      shellStart('', path).then(
        () => resolvePromise({ editor: false }),
        () => {
          execFile(
            'rundll32.exe',
            ['url.dll,FileProtocolHandler', path],
            { timeout: 15_000, windowsHide: true },
            (error) => {
              if (!error) return resolvePromise({ editor: false })
              if (!NO_DEFAULT_APP_FALLBACK.has(extname(path).toLowerCase())) return reject(error)
              openWithEditor(path).then(
                () => resolvePromise({ editor: true }),
                () => reject(error),
              )
            },
          )
        },
      )
    })
  }
  return new Promise((resolvePromise, reject) => {
    execFile('open', [path], { timeout: 15_000 }, (error) => {
      if (!error) return resolvePromise({ editor: false })
      if (!NO_DEFAULT_APP_FALLBACK.has(extname(path).toLowerCase())) return reject(error)
      openWithEditor(path).then(
        () => resolvePromise({ editor: true }),
        () => reject(error),
      )
    })
  })
}

/** Text-editor fallback for types with no default handler (e.g. .jsonl). */
export function openWithEditor(input) {
  const path = normalizePath(input)
  if (WIN) return shellStart('notepad.exe', path)
  return new Promise((resolvePromise, reject) => {
    execFile('open', ['-a', 'TextEdit', path], { timeout: 15_000 }, (error) => {
      if (error) reject(error)
      else resolvePromise(true)
    })
  })
}

export function revealInFinder(input) {
  const path = normalizePath(input)
  if (WIN) {
    return new Promise((resolvePromise, reject) => {
      // explorer returns 1 even on success, so only a spawn failure is an error.
      execFile('explorer.exe', [`/select,${path}`], { timeout: 15_000, windowsHide: true }, (error) => {
        if (error && error.code === 'ENOENT') reject(error)
        else resolvePromise(true)
      })
    })
  }
  return new Promise((resolvePromise, reject) => {
    execFile('open', ['-R', path], { timeout: 15_000 }, (error) => {
      if (error) reject(error)
      else resolvePromise(true)
    })
  })
}
