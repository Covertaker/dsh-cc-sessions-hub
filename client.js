window.__ModuleLoader__.load({
  id: 'dsh-cc-sessions-hub',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'cc-sessions'
    const ENDPOINT = '/_ccpanel/sessions'
    const WAIT_STEP_MS = 60

    // All colours come from the host theme tokens (authoritative names from
    // @deepseek-ai/dsh-client-ui-theme). Fallbacks only cover a renamed token.
    const T = {
      text: 'var(--dsw-alias-label-primary, currentColor)',
      sub: 'var(--dsw-alias-label-secondary, rgba(128,128,128,0.95))',
      faint: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,0.75))',
      caption: 'var(--dsw-alias-label-caption, rgba(128,128,128,0.62))',
      line: 'var(--dsw-alias-border-l3, rgba(128,128,128,0.20))',
      lineStrong: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.32))',
      base: 'var(--dsw-alias-bg-base, transparent)',
      layer1: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.05))',
      layer2: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.09))',
      card: 'var(--dsw-alias-settings-card-fill, rgba(128,128,128,0.05))',
      cardStroke: 'var(--dsw-alias-settings-card-stroke, rgba(128,128,128,0.20))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.10))',
      active: 'var(--dsw-alias-interactive-bg-active, rgba(128,128,128,0.16))',
      accent: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      accentText: 'var(--dsw-alias-brand-text, #4d6bfe)',
      ghostFill: 'var(--dsw-alias-button-ghost-active-fill, rgba(128,128,128,0.14))',
      ghostBorder: 'var(--dsw-alias-button-ghost-active-border, rgba(128,128,128,0.32))',
      ok: 'var(--dsw-alias-state-success-primary, #23a55a)',
      warn: 'var(--dsw-alias-state-warn-primary, #e5a11a)',
      err: 'var(--dsw-alias-state-error-primary, #e5544b)',
      idle: 'var(--dsw-alias-state-idle-primary, rgba(128,128,128,0.9))',
    }
    const FONT = 'var(--dsh-font-family-text, inherit)'
    const MONO = 'var(--dsh-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)'
    const FS = 'var(--dsh-content-font-size, 13px)'
    const FS2 = 'var(--dsh-content-font-size-secondary, 12px)'
    const HAIRLINE = 'var(--dsh-hairline-width, 0.5px)'
    // Calm workstation: soft surfaces, one accent, quiet motion.
    const R = { ctl: 8, card: 12, pill: 999 }
    const SHADOW = {
      card: '0 1px 2px rgba(15,23,42,0.04), 0 8px 24px rgba(15,23,42,0.05)',
      hover: '0 2px 6px rgba(15,23,42,0.06), 0 14px 34px rgba(15,23,42,0.09)',
      pop: '0 4px 12px rgba(15,23,42,0.08), 0 24px 56px rgba(15,23,42,0.12)',
    }
    const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)'
    const TRANS = `background 140ms ${EASE}, border-color 140ms ${EASE}, box-shadow 180ms ${EASE}, transform 160ms ${EASE}, color 140ms ${EASE}`
    const ACCENT_SOFT = 'color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 10%, transparent)'
    const ACCENT_LINE = 'color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 30%, transparent)'
    const FS_TITLE = 'var(--dsh-content-font-size, 13px)'
    const NUM = { fontVariantNumeric: 'tabular-nums' }

    // Client services resolve lazily at call time: capturing them during apply()
    // freezes whatever the loader had mounted at that instant.
    let ROOT = null
    function svc(name) {
      try {
        const found = ROOT?.get?.(name)
        if (found) return found
      } catch {
        /* not mounted yet */
      }
      return null
    }

    /** Sessions this page opened a terminal for — the only honest concurrency source. */
    const OPENED = new Map()

    /* ── helpers ─────────────────────────────────────────────────────── */

    const PANEL_CSS = `
@keyframes ccs-shimmer { 0% { opacity: .55 } 50% { opacity: 1 } 100% { opacity: .55 } }
.ccs-skel { animation: ccs-shimmer 1.4s ease-in-out infinite; }
.ccs-btn { transition: ${TRANS}; }
.ccs-btn:hover:not(:disabled) { box-shadow: 0 6px 18px rgba(15,23,42,0.08) !important; transform: translateY(-1px); }
.ccs-btn:active:not(:disabled) { transform: translateY(0); box-shadow: none; }
.ccs-ctl:focus-visible { outline: 2px solid ${T.accent}; outline-offset: 2px; }
.ccs-row { transition: ${TRANS}; }
.ccs-row:hover { box-shadow: ${SHADOW.hover} !important; }
.ccs-card { transition: ${TRANS}; }
.ccs-card:hover { box-shadow: ${SHADOW.hover} !important; }
.ccs-focus:focus-within { box-shadow: 0 0 0 3px ${ACCENT_SOFT}, ${SHADOW.card}; border-color: ${ACCENT_LINE}; }
.ccs-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.ccs-scroll::-webkit-scrollbar-thumb { background: ${T.lineStrong}; border-radius: 999px; }
.ccs-scroll::-webkit-scrollbar-track { background: transparent; }
@media (prefers-reduced-motion: reduce) {
  .ccs-skel { animation: none; }
  .ccs-btn, .ccs-row, .ccs-card { transition: none; }
  .ccs-btn:hover:not(:disabled) { transform: none; }
}
`

    function PanelStyle() {
      return h('style', { dangerouslySetInnerHTML: { __html: PANEL_CSS } })
    }

    function waitFor(probe, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      return new Promise((resolve) => {
        const tick = () => {
          let value
          try {
            value = probe()
          } catch {
            value = undefined
          }
          if (value !== undefined && value !== null && value !== false) {
            resolve(value)
            return
          }
          if (Date.now() >= deadline) {
            resolve(undefined)
            return
          }
          setTimeout(tick, WAIT_STEP_MS)
        }
        tick()
      })
    }

    const shortId = (id) => {
      const value = String(id ?? '')
      return value.length > 10 ? `${value.slice(0, 8)}…` : value
    }

    function relativeTime(ms) {
      const when = Number(ms)
      if (!Number.isFinite(when) || when <= 0) return '—'
      const diff = Date.now() - when
      if (diff < 0) return '刚刚'
      const minute = 60_000
      const hour = 60 * minute
      const day = 24 * hour
      if (diff < minute) return '刚刚'
      if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
      if (diff < day) return `${Math.floor(diff / hour)} 小时前`
      const days = Math.floor(diff / day)
      if (days < 30) return `${days} 天前`
      return new Date(when).toLocaleDateString()
    }

    function absoluteTime(ms) {
      const when = Number(ms)
      if (!Number.isFinite(when) || when <= 0) return '—'
      return new Date(when).toLocaleString()
    }

    const shortDir = (cwd) => String(cwd ?? '').replace(/^\/Users\/[^/]+/, '~') || '—'

    function sizeText(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value <= 0) return '—'
      if (value < 1024) return `${value} B`
      if (value < 1024 ** 2) return `${(value / 1024).toFixed(0)} KB`
      return `${(value / 1024 ** 2).toFixed(1)} MB`
    }

    function statusOf(row) {
      if (!row.live) return { label: '归档', color: T.faint, kind: 'idle' }
      if (row.status === 'busy') return { label: '运行中', color: T.ok, kind: 'busy' }
      if (row.status === 'blocked') return { label: '阻塞', color: T.err, kind: 'blocked' }
      if (row.status === 'idle') return { label: '空闲', color: T.idle, kind: 'idle' }
      if (row.kind === 'background') return { label: '后台', color: T.warn, kind: 'warn' }
      return { label: String(row.status ?? '在线'), color: T.ok, kind: 'busy' }
    }

    /** A ready-made sentence the user can paste into the dsh conversation. */
    const dshInstruction = (row) =>
      `用 cc_session_digest 读取 cc 会话 ${row.id}（${row.title || row.firstPrompt || '该会话'}）的上下文摘要，然后基于它继续工作。`

    const resumeCommand = (row) => `claude --resume ${row.id}`

    /** dsh terminal backend hardcodes TERM=dumb, which degrades cc's TUI; re-enable 256 colours. */
    const withTerm = (command) => `TERM=xterm-256color ${command}`
    const forkCommand = (row) => `claude --resume ${row.id} --fork-session`

    function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(String(text)).then(
            () => true,
            () => false,
          )
        }
      } catch {
        /* reported as failure */
      }
      return Promise.resolve(false)
    }

    /**
     * Fetch + parse with a clear failure mode: an empty 404 body means the Host
     * half has not been restarted since the route was added, not that the data
     * is missing.
     */
    async function fetchJson(url) {
      const response = await fetch(url)
      const text = await response.text()
      if (!response.ok) {
        if (response.status === 404 && text.trim() === '') {
          throw new Error('后端路由未加载 —— 面板已是新代码，但 host 半部还没随重启生效，请重启 dsh')
        }
        let detail = text
        try {
          const parsed = JSON.parse(text)
          detail = parsed?.error || text
        } catch {
          /* keep the raw text */
        }
        throw new Error(detail ? String(detail).slice(0, 200) : `HTTP ${response.status}`)
      }
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(`返回不是 JSON：${text.slice(0, 120) || '(空响应)'}`)
      }
    }

    /** Current dsh session id, from the client session adapter. */
    function currentSessionId() {
      try {
        const current = svc('uiSession')?.adapter?.current?.getSnapshot?.()
        return current?.key ?? current?.id
      } catch {
        return undefined
      }
    }

    /** Create a fresh dsh conversation and send one seed message into it. */
    async function sendToNewConversation(text) {
      const layout = svc('layout')
      try {
        if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(null)
      } catch {
        /* already on the conversation */
      }
      await waitFor(() => (svc('uiWorkspace') ? true : undefined), 2000)
      const uiWorkspace = svc('uiWorkspace')
      const sessions = svc('sessions')
      const conversation = svc('conversation')
      if (!uiWorkspace || !conversation) {
        return { ok: false, message: `会话接口不可用（uiWorkspace=${Boolean(uiWorkspace)} conversation=${Boolean(conversation)}）` }
      }
      const before = currentSessionId()
      try {
        uiWorkspace.startSession(undefined, {})
      } catch (error) {
        return { ok: false, message: `新对话创建失败：${String(error?.message ?? error)}` }
      }
      const newId = await waitFor(() => {
        const id = currentSessionId()
        return id && id !== before ? id : undefined
      }, 8000)
      if (!newId) return { ok: false, message: '新对话创建超时（8 秒未切换）' }
      const binding = await waitFor(() => {
        try {
          return sessions?.binding?.(newId)
        } catch {
          return undefined
        }
      }, 5000)
      if (!binding?.session) return { ok: false, message: '解析不到新对话的会话实体' }
      try {
        await conversation.sendSession(binding.session, text, [], 'queue')
        return { ok: true, message: '已开新对话' }
      } catch (error) {
        return { ok: false, message: `发送失败：${String(error?.message ?? error)}` }
      }
    }

    /**
     * Open a NEW dsh conversation seeded with the selected cc sessions.
     *
     * This is the "team briefing" tier: the panel gathers each session's context
     * locally (free), then hands one briefing to a fresh conversation where dsh
     * is the main agent. No batch dispatch, no state, no automatic rounds — the
     * user drives from there.
     */
    async function startTeamConversation(rows) {
      const layout = svc('layout')
      try {
        if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(null)
      } catch {
        /* already on the conversation */
      }
      await waitFor(() => (svc('uiWorkspace') ? true : undefined), 2000)

      const uiWorkspace = svc('uiWorkspace')
      const sessions = svc('sessions')
      const conversation = svc('conversation')
      if (!uiWorkspace || !conversation) {
        return { ok: false, message: `会话接口不可用（uiWorkspace=${Boolean(uiWorkspace)} conversation=${Boolean(conversation)}）` }
      }

      // ① gather context locally — no cc call, no cost
      const ids = rows.map((row) => row.id).join(',')
      let merged = ''
      try {
        const payload = await fetchJson(`${ENDPOINT.replace('/sessions', '')}/merge?ids=${encodeURIComponent(ids)}`)
        if (payload?.error) throw new Error(payload.error)
        merged = String(payload.text ?? '')
      } catch (error) {
        return { ok: false, message: `汇总上下文失败：${String(error?.message ?? error)}` }
      }

      // ② create a fresh conversation
      const before = currentSessionId()
      try {
        uiWorkspace.startSession(undefined, {})
      } catch (error) {
        return { ok: false, message: `新对话创建失败：${String(error?.message ?? error)}` }
      }
      const newId = await waitFor(() => {
        const id = currentSessionId()
        return id && id !== before ? id : undefined
      }, 8000)
      if (!newId) return { ok: false, message: '新对话创建超时（8 秒未切换）' }

      const binding = await waitFor(() => {
        try {
          return sessions?.binding?.(newId)
        } catch {
          return undefined
        }
      }, 5000)
      const hostSession = binding?.session
      if (!hostSession) return { ok: false, message: '解析不到新对话的会话实体' }

      // ③ seed it with the roster + digests
      const roster = rows
        .map((row, index) => `${index + 1}. \`${row.id}\` — ${row.title || row.firstPrompt || '（无标题）'}`)
        .join('\n')
      const text = [
        `我在 CC sessions 面板里选了 ${rows.length} 个 Claude Code 会话，作为这次工作的编队：`,
        '',
        roster,
        '',
        '它们的上下文摘要（面板本地读取，未调用 cc、未产生费用）：',
        '',
        merged,
        '',
        '---',
        '请先做三件事：',
        `1. 逐个用一句话说明这 ${rows.length} 个会话各自在做什么，`,
        '2. 指出它们之间重复的工作、口径冲突、以及缺口',
        '3. 然后停下等我下一步指令',
        '',
        '提示：需要更新某个会话的细节时，用 cc_session_digest 现取；不要凭摘要猜数字。',
      ].join('\n')

      try {
        await conversation.sendSession(hostSession, text, [], 'queue')
        return { ok: true, message: `已建队并开新对话（${rows.length} 个会话）` }
      } catch (error) {
        return { ok: false, message: `发送编队简报失败：${String(error?.message ?? error)}` }
      }
    }

    function GhostButton({ children, onClick, tone, disabled, title }) {
      const [hover, setHover] = React.useState(false)
      const [down, setDown] = React.useState(false)
      const color = tone ?? (hover ? T.text : T.sub)
      return h(
        'button',
        {
          type: 'button',
          className: 'ccs-ctl ccs-btn',
          title,
          disabled,
          onClick: (event) => {
            event.stopPropagation()
            if (!disabled) onClick?.()
          },
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => { setHover(false); setDown(false) },
          onMouseDown: () => setDown(true),
          onMouseUp: () => setDown(false),
          style: {
            appearance: 'none',
            fontFamily: 'inherit',
            fontSize: FS2,
            height: 28,
            padding: '0 11px',
            borderRadius: R.ctl,
            cursor: disabled ? 'default' : 'pointer',
            color: disabled ? T.faint : color,
            background: hover && !disabled ? T.hover : 'transparent',
            border: `1px solid ${hover && !disabled ? T.lineStrong : T.line}`,
            whiteSpace: 'nowrap',
            boxShadow: down && !disabled ? 'none' : undefined,
          },
        },
        children,
      )
    }

    function PrimaryButton({ children, onClick, disabled }) {
      const [hover, setHover] = React.useState(false)
      const [down, setDown] = React.useState(false)
      return h(
        'button',
        {
          type: 'button',
          className: 'ccs-ctl ccs-btn',
          disabled,
          onClick: (event) => {
            event.stopPropagation()
            if (!disabled) onClick?.()
          },
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => { setHover(false); setDown(false) },
          onMouseDown: () => setDown(true),
          onMouseUp: () => setDown(false),
          style: {
            appearance: 'none',
            fontFamily: 'inherit',
            fontSize: FS2,
            height: 28,
            padding: '0 13px',
            borderRadius: R.ctl,
            cursor: disabled ? 'default' : 'pointer',
            color: disabled ? T.faint : '#fff',
            background: disabled ? T.layer2 : T.accent,
            filter: hover && !disabled ? 'brightness(1.04)' : 'none',
            border: `1px solid ${disabled ? T.line : 'transparent'}`,
            boxShadow: disabled ? 'none' : '0 6px 16px color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 28%, transparent)',
            whiteSpace: 'nowrap',
          },
        },
        children,
      )
    }

    function CopyButton({ label, value }) {
      const [state, setState] = React.useState('idle')
      const timer = React.useRef(null)
      React.useEffect(
        () => () => {
          if (timer.current) clearTimeout(timer.current)
        },
        [],
      )
      const flash = (next) => {
        setState(next)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setState('idle'), 1500)
      }
      const text =
        state === 'done' ? '已复制' : state === 'fail' ? '复制失败' : label
      return h(
        GhostButton,
        {
          tone: state === 'done' ? T.ok : state === 'fail' ? T.err : undefined,
          onClick: () => copyText(value).then((ok) => flash(ok ? 'done' : 'fail')),
        },
        text,
      )
    }

    /** Shimmer placeholders that match the list row geometry. */
    function SkeletonRows() {
      return h(
        'div',
        null,
        ...[0, 1, 2, 3, 4, 5].map((index) =>
          h(
            'div',
            {
              key: index,
              style: {
                display: 'grid',
                gridTemplateColumns: GRID,
                gap: 10,
                alignItems: 'center',
                padding: '9px 16px 9px 12px',
                borderBottom: `${HAIRLINE} solid ${T.line}`,
              },
            },
            h('span', null),
            h('span', {
              className: 'ccs-skel',
              style: { height: 10, width: 46, borderRadius: 4, background: T.layer2 },
            }),
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
              h('span', {
                className: 'ccs-skel',
                style: { height: 10, width: `${68 - index * 6}%`, borderRadius: 4, background: T.layer2 },
              }),
              h('span', {
                className: 'ccs-skel',
                style: { height: 8, width: '42%', borderRadius: 4, background: T.layer1 },
              }),
            ),
            h('span', {
              className: 'ccs-skel',
              style: { height: 9, width: '70%', borderRadius: 4, background: T.layer1 },
            }),
            h('span', {
              className: 'ccs-skel',
              style: { height: 9, width: 52, borderRadius: 4, background: T.layer1, justifySelf: 'end' },
            }),
            h('span', {
              className: 'ccs-skel',
              style: { height: 20, width: 64, borderRadius: R.ctl, background: T.layer1, justifySelf: 'end' },
            }),
          ),
        ),
      )
    }

    function Stat({ label, value, tone, onClick, active }) {
      const [hover, setHover] = React.useState(false)
      const clickable = typeof onClick === 'function'
      return h(
        'div',
        {
          onClick: clickable ? onClick : undefined,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          title: clickable ? '点开看明细' : undefined,
          className: clickable ? 'ccs-card' : undefined,
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
            minWidth: 72,
            cursor: clickable ? 'pointer' : 'default',
            padding: '8px 12px',
            borderRadius: 10,
            border: `1px solid ${active ? ACCENT_LINE : T.line}`,
            background: active ? ACCENT_SOFT : T.layer1,
            boxShadow: active ? SHADOW.card : 'none',
          },
        },
        h(
          'span',
          { style: { fontSize: 19, fontWeight: 600, color: tone ?? T.text, lineHeight: '24px', ...NUM } },
          String(value),
        ),
        h(
          'span',
          {
            style: {
              fontSize: 10,
              letterSpacing: '0.06em',
              color: active ? T.text : T.caption,
              textDecoration: clickable && hover ? 'underline' : 'none',
            },
          },
          label,
        ),
      )
    }

    function StatusPill({ row }) {
      const status = statusOf(row)
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
        h('span', {
          style: {
            width: 7,
            height: 7,
            borderRadius: 999,
            background: status.color,
            flex: '0 0 auto',
          },
        }),
        h(
          'span',
          { style: { fontSize: FS2, color: row.live ? T.sub : T.faint, whiteSpace: 'nowrap' } },
          status.label,
        ),
      )
    }

    function Segmented({ value, onChange, options }) {
      return h(
        'div',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 2,
            padding: 2,
            borderRadius: 8,
            background: T.layer1,
            border: `${HAIRLINE} solid ${T.line}`,
          },
        },
        ...options.map((option) => {
          const selected = option.key === value
          return h(
            'button',
            {
              key: option.key,
              type: 'button',
              onClick: () => onChange(option.key),
              style: {
                appearance: 'none',
                fontFamily: 'inherit',
                fontSize: FS2,
                lineHeight: '20px',
                padding: '2px 10px',
                borderRadius: 6,
                cursor: 'pointer',
                border: 'none',
                color: selected ? T.text : T.sub,
                background: selected ? T.base : 'transparent',
                boxShadow: selected ? `0 0 0 ${HAIRLINE} ${T.line}` : 'none',
                whiteSpace: 'nowrap',
              },
            },
            `${option.label}${option.count === undefined ? '' : ` ${option.count}`}`,
          )
        }),
      )
    }

    /* ── terminal takeover ───────────────────────────────────────────── */

    async function takeOver(row, fork) {
      const layout = svc('layout')
      const sidebarRight = svc('sidebarRight')
      const webTerminals = svc('webTerminals')
      if (!sidebarRight || !webTerminals) {
        return {
          ok: false,
          message: `终端服务不可用（sidebarRight=${Boolean(sidebarRight)} webTerminals=${Boolean(webTerminals)}）`,
        }
      }
      const command = fork ? forkCommand(row) : resumeCommand(row)

      try {
        if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(null)
      } catch {
        /* keeping the panel open only means the terminal cannot open */
      }

      const sessionId = await waitFor(() => {
        const id = sidebarRight.mounted?.getSnapshot?.()
        return typeof id === 'string' && id.length > 0 ? id : undefined
      }, 3000)
      if (!sessionId) {
        await copyText(command)
        return { ok: false, message: '没有选中的对话，命令已复制到剪贴板' }
      }

      try {
        sidebarRight.openTab('terminal')
      } catch {
        await copyText(command)
        return { ok: false, message: '终端标签打开失败，命令已复制到剪贴板' }
      }

      const tab = await waitFor(() => {
        const active = typeof sidebarRight.active === 'function' ? sidebarRight.active() : undefined
        return active && active.kind === 'terminal' && active.id ? active : undefined
      }, 3000)
      if (!tab) {
        await copyText(command)
        return { ok: false, message: '终端标签未就绪，命令已复制到剪贴板' }
      }

      let view
      try {
        view = webTerminals.view(sessionId, tab.id, tab.contentId)
      } catch {
        view = undefined
      }
      if (!view) {
        await copyText(command)
        return { ok: false, message: '终端会话创建失败，命令已复制到剪贴板' }
      }

      const writable = await waitFor(() => {
        try {
          return view.state?.getSnapshot?.()?.writable === true ? true : undefined
        } catch {
          return undefined
        }
      }, 5000)
      if (!writable) {
        await copyText(command)
        return { ok: false, message: '终端输入未就绪，命令已复制到剪贴板' }
      }

      try {
        view.write(`${withTerm(command)}\n`)
      } catch {
        await copyText(command)
        return { ok: false, message: '写入终端失败，命令已复制到剪贴板' }
      }
      return {
        ok: true,
        message: fork ? '已在终端打开 fork 会话' : '已在终端接管该会话',
        record: { view, tabId: tab.id, at: Date.now(), fork },
      }
    }

    /* ── primitives ──────────────────────────────────────────────────── */

    /* ── running band (concurrency) ──────────────────────────────────── */

    /**
     * 本页面开过的终端，靠 `sidebarRight.openTabs` 对账。
     *
     * 2026-11-09 修：`OPENED` 以前只在点 band 的「关闭」时删，终端自己退出、标签被关、
     * 进程结束都不清理——实测 ps 里一个 cc 都没有，面板仍报「运行中 2 个」，是假状态。
     * 判据取真实源：openTabs 快照里没有这个 tabId，就当它已不在。
     * （标签还在 ≠ 进程还在，所以文案也改成「本页打开的终端标签」，不写"运行中"。）
     */
    function reconcileOpened() {
      let tabs = null
      try {
        tabs = svc('sidebarRight')?.openTabs?.getSnapshot?.() ?? null
      } catch {
        tabs = null
      }
      if (!Array.isArray(tabs)) return false
      const alive = new Set(tabs.map((tab) => tab?.tabId).filter(Boolean))
      let changed = false
      for (const [sessionId, entry] of [...OPENED.entries()]) {
        if (!entry?.tabId || !alive.has(entry.tabId)) {
          OPENED.delete(sessionId)
          changed = true
        }
      }
      return changed
    }

    function ManagedBand({ onChange }) {
      const entries = [...OPENED.entries()]
      if (entries.length === 0) return null
      const crowded = entries.length >= 4
      const stop = (entry) => {
        try {
          entry.view.write('\u0003')
        } catch {
          /* already exited */
        }
      }
      const close = (sessionId, entry) => {
        try {
          svc('sidebarRight')?.close?.(entry.tabId)
        } catch {
          /* tab already gone */
        }
        OPENED.delete(sessionId)
        onChange()
      }
      return h(
        'div',
        {
          style: {
            margin: '12px 16px 0',
            border: `${HAIRLINE} solid ${crowded ? T.warn : T.cardStroke}`,
            borderRadius: R.card,
            background: T.card,
            overflow: 'hidden',
          },
        },
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 12px',
              borderBottom: `${HAIRLINE} solid ${T.line}`,
            },
          },
          h('span', {
            style: { width: 6, height: 6, borderRadius: 99, background: crowded ? T.warn : T.ok },
          }),
          h(
            'span',
            { style: { fontSize: FS2, color: T.text, fontWeight: 500 } },
            '本页打开的终端标签',
          ),
          h(
            'span',
            { style: { fontSize: 11, color: T.caption } },
            crowded
              ? `${entries.length} 个 —— 每个占一个 PTY 与一路 API，注意成本`
              : `${entries.length} 个`,
          ),
        ),
        ...entries.map(([sessionId, entry]) =>
          h(
            'div',
            {
              key: sessionId,
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '6px 12px',
                borderBottom: `${HAIRLINE} solid ${T.line}`,
              },
            },
            h('span', { style: { fontFamily: MONO, fontSize: FS2, color: T.text } }, shortId(sessionId)),
            h(
              'span',
              { style: { fontSize: 11, color: T.caption } },
              `${entry.fork ? 'fork' : '接管'} · ${relativeTime(entry.at)}`,
            ),
            h('span', { style: { flex: '1 1 auto' } }),
            h(GhostButton, { onClick: () => stop(entry) }, '停止'),
            h(GhostButton, { onClick: () => close(sessionId, entry) }, '关闭标签'),
          ),
        ),
      )
    }

    /* ── rows ────────────────────────────────────────────────────────── */

    const GRID = '26px 86px minmax(150px,1.5fr) minmax(110px,1fr) 92px auto'
    function Row({ row, selected, onToggleSelect, onTakeOver, onOpen, onRelease, onSubagents }) {
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [hover, setHover] = React.useState(false)
      const [showDigest, setShowDigest] = React.useState(false)
      const [menu, setMenu] = React.useState(false)
      const [ask, setAsk] = React.useState('')
      const resumable = Boolean(row.path)
      const topic = row.title || row.firstPrompt || row.preview || ''
      const title = topic || row.name || shortId(row.id)

      const run = (fork) => {
        if (busy) return
        setBusy(true)
        Promise.resolve(onTakeOver(row, fork))
          .catch(() => {})
          .finally(() => setBusy(false))
      }

      return h(
        'div',
        {
          className: 'ccs-row',
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            margin: '5px 10px',
            border: `1px solid ${selected ? ACCENT_LINE : T.line}`,
            borderRadius: R.card,
            background: selected ? ACCENT_SOFT : T.base,
            boxShadow: SHADOW.card,
          },
        },
        h(
          'div',
          {
            onClick: () => setOpen((value) => !value),
            style: {
              display: 'grid',
              gridTemplateColumns: GRID,
              alignItems: 'center',
              gap: 10,
              padding: '9px 12px',
              cursor: 'pointer',
              background: open ? T.layer1 : hover ? T.hover : 'transparent',
              borderRadius: open ? '11px 11px 0 0' : 11,
            },
          },
          h('input', {
            type: 'checkbox',
            checked: selected,
            onClick: (event) => event.stopPropagation(),
            onChange: () => onToggleSelect(row.id),
            style: { margin: 0, cursor: 'pointer', accentColor: T.accent },
          }),
          h(StatusPill, { row }),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 } },
            h(
              'span',
              {
                title: resumable && onOpen ? `${title} — 点击进入对话` : title,
                onClick:
                  resumable && onOpen
                    ? (event) => {
                        event.stopPropagation()
                        onOpen(row)
                      }
                    : undefined,
                style: {
                  fontSize: FS,
                  color: T.text,
                  fontWeight: row.live ? 500 : 400,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  cursor: resumable && onOpen ? 'pointer' : 'default',
                  textDecoration: resumable && onOpen ? 'underline dotted transparent' : 'none',
                },
                onMouseEnter: (event) => {
                  if (resumable && onOpen) event.currentTarget.style.textDecorationColor = T.lineStrong
                },
                onMouseLeave: (event) => {
                  if (resumable && onOpen) event.currentTarget.style.textDecorationColor = 'transparent'
                },
              },
              title,
            ),
            h(
              'span',
              { style: { display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0 } },
              h(
                'span',
                { style: { fontSize: 10.5, color: T.caption, fontFamily: MONO, flex: '0 0 auto' } },
                shortId(row.id),
              ),
              h(
                'span',
                {
                  style: {
                    fontSize: 10.5,
                    color: T.faint,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                },
                [row.kind, row.preview].filter(Boolean).join(' · '),
              ),
            ),
          ),
          h(
            'span',
            {
              title: row.cwd || '',
              style: {
                fontSize: FS2,
                color: T.faint,
                fontFamily: MONO,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            shortDir(row.cwd),
          ),
          h(
            'span',
            { style: { fontSize: 11, color: T.caption, whiteSpace: 'nowrap', textAlign: 'right', ...NUM } },
            relativeTime(row.mtime ?? row.startedAt),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 6, justifyContent: 'flex-end', position: 'relative' } },
            resumable && onOpen
              ? h(
                  PrimaryButton,
                  {
                    // PrimaryButton also stops propagation and calls onClick() with no event.
                    onClick: () => onOpen(row),
                    title: '在面板里看完整对话并继续',
                  },
                  '对话',
                )
              : null,
            row.subagents > 0 && onSubagents
              ? h(
                  GhostButton,
                  {
                    onClick: () => onSubagents(row),
                    title: `查看这个会话的 ${row.subagents} 个子代理过程`,
                  },
                  `子代理（${row.subagents}）`,
                )
              : null,
            resumable
              ? h(
                  GhostButton,
                  {
                    onClick: () => run(!row.live),
                    disabled: busy || row.panelOwned === true,
                    title:
                      row.panelOwned === true
                        ? '面板正在使用该会话：先回面板结束（或 fork），避免两个进程写同一份转录'
                        : row.live
                          ? '该会话还开着，fork 一份新的最安全'
                          : '在新终端里接着这个会话干',
                  },
                  row.panelOwned === true
                    ? '面板占用'
                    : busy
                      ? '启动中'
                      : row.live
                        ? 'fork 打开'
                        : '接管终端',
                )
              : h('span', { style: { fontSize: 11, color: T.faint, whiteSpace: 'nowrap' } }, '无记录'),
            resumable
              ? h(GhostButton, { onClick: () => setMenu((value) => !value), title: '更多操作' }, '⋯')
              : null,
            menu && resumable
              ? h(
                  'div',
                  {
                    onClick: (event) => event.stopPropagation(),
                    style: {
                      position: 'absolute',
                      top: '100%',
                      right: 0,
                      marginTop: 4,
                      zIndex: 20,
                      minWidth: 158,
                      display: 'flex',
                      flexDirection: 'column',
                      background: T.base,
                      border: `1px solid ${T.lineStrong}`,
                      boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
                    },
                  },
                  ...[
                    {
                      label: showDigest ? '收起摘要' : '查看摘要',
                      run: () => { setShowDigest((value) => !value); setMenu(false) },
                    },
                    { label: '复制 resume 命令', run: () => { copyText(resumeCommand(row)); setMenu(false) } },
                    { label: '复制 fork 命令', run: () => { copyText(forkCommand(row)); setMenu(false) } },
                    { label: open ? '收起详情' : '展开详情', run: () => { setOpen((value) => !value); setMenu(false) } },
                  ].map((item) =>
                    h(
                      'button',
                      {
                        key: item.label,
                        type: 'button',
                        className: 'ccs-ctl',
                        onClick: (event) => { event.stopPropagation(); item.run() },
                        onMouseEnter: (event) => { event.currentTarget.style.background = T.hover },
                        onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
                        style: {
                          appearance: 'none',
                          border: 'none',
                          background: 'transparent',
                          color: T.sub,
                          fontFamily: 'inherit',
                          fontSize: FS2,
                          textAlign: 'left',
                          padding: '6px 10px',
                          cursor: 'pointer',
                          borderBottom: `${HAIRLINE} solid ${T.line}`,
                        },
                      },
                      item.label,
                    ),
                  ),
                )
              : null,
          ),
        ),
        open
          ? h(
              'div',
              {
                style: {
                  padding: '10px 16px 14px 40px',
                  background: T.layer1,
                  borderRadius: '0 0 11px 11px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                },
              },
              h(
                'div',
                { style: { display: 'grid', gridTemplateColumns: '84px 1fr', rowGap: 6, columnGap: 12 } },
                h('span', { style: { fontSize: 11, color: T.caption } }, 'session'),
                h(
                  'span',
                  { style: { fontSize: FS2, fontFamily: MONO, color: T.text, wordBreak: 'break-all' } },
                  row.id,
                ),
                h('span', { style: { fontSize: 11, color: T.caption } }, '工作目录'),
                h(
                  'span',
                  { style: { fontSize: FS2, fontFamily: MONO, color: T.sub, wordBreak: 'break-all' } },
                  row.cwd || '—',
                ),
                h('span', { style: { fontSize: 11, color: T.caption } }, '最后活动'),
                h(
                  'span',
                  { style: { fontSize: FS2, color: T.sub } },
                  `${absoluteTime(row.mtime ?? row.startedAt)} · ${sizeText(row.size)}`,
                ),
                h('span', { style: { fontSize: 11, color: T.caption } }, '最后一问'),
                h('span', { style: { fontSize: FS2, color: T.sub, lineHeight: 1.55 } }, row.preview || '—'),
              ),
              row.live && row.kind === 'background'
                ? h(
                    'div',
                    { style: { fontSize: 11, color: T.warn } },
                    '这是一条后台 job 的残留记录（对话记录已清理），只能看不能接管。',
                  )
                : row.live
                  ? h(
                      'div',
                      { style: { fontSize: 11, color: T.caption } },
                      '该会话仍开着：直接接管会在原 sessionId 上续写（cc 无文件锁，可能双写），所以这里默认 fork。',
                    )
                  : null,
              h(
                'div',
                { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
                resumable
                  ? h(
                      GhostButton,
                      {
                        onClick: () => setShowDigest((value) => !value),
                      },
                      showDigest ? '收起预览' : '预览摘要',
                    )
                  : null,
                resumable ? h(CopyButton, { label: '复制 resume 命令', value: resumeCommand(row) }) : null,
                resumable ? h(CopyButton, { label: '复制 fork 命令', value: forkCommand(row) }) : null,
              ),
            )
          : null,
        // 摘要独立挂载：以前它在 `open` 分支内，菜单点「查看摘要」只改了状态、
        // 详情没展开就什么都不显示（2026-11-09 修）。
        showDigest ? h('div', { style: { padding: '2px 16px 12px 40px' } }, h(DigestView, { row })) : null,
      )
    }

    /** Per-row digest state, isolated so a failure never blanks the list. */
    function DigestView({ row }) {
      const [state, setState] = React.useState({ status: 'loading' })
      React.useEffect(() => {
        let alive = true
        fetch(`${ENDPOINT.replace('/sessions', '')}/digest?id=${encodeURIComponent(row.id)}&maxChars=3000`)
          .then((response) => {
            if (response.status === 404) {
              throw new Error('后端路由未加载 —— 面板已是新代码，但 host 半部还没随重启生效')
            }
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            return response.json()
          })
          .then((payload) => {
            if (!alive) return
            if (payload && payload.error) throw new Error(payload.error)
            setState({ status: 'ready', payload })
          })
          .catch((cause) => {
            if (alive) setState({ status: 'error', message: String(cause?.message ?? cause) })
          })
        return () => {
          alive = false
        }
      }, [row.id])
      if (state.status === 'loading') {
        return h('div', { style: { fontSize: 11, color: T.caption } }, '读取摘要…')
      }
      if (state.status === 'error') {
        return h('div', { style: { fontSize: 11, color: T.err } }, `摘要读取失败：${state.message}`)
      }
      const payload = state.payload
      return h(
        'div',
        {
          style: {
            border: `${HAIRLINE} solid ${T.line}`,
            borderRadius: 8,
            background: T.base,
            maxHeight: 220,
            overflowY: 'auto',
            padding: '8px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h(
            'span',
            { style: { fontSize: 11, color: T.caption } },
            `预览 · ${payload.turns} 轮 · ${payload.digest.length} 字`,
          ),
          h('span', { style: { flex: '1 1 auto' } }),
          h(CopyButton, { label: '复制', value: payload.digest }),
        ),
        h(
          'pre',
          {
            style: {
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: FONT,
              fontSize: FS2,
              color: T.sub,
              lineHeight: 1.6,
            },
          },
          payload.digest || '（该会话尾部没有可提取的对话文本）',
        ),
      )
    }

    /* ── chat ────────────────────────────────────────────────────────── */

    const CHAT = '/_ccpanel/chat'
    const CHAT_FILE = '/_ccpanel/file'

    async function readJson(response) {
      const text = await response.text()
      let payload = null
      try {
        payload = text ? JSON.parse(text) : null
      } catch {
        payload = null
      }
      if (!response.ok) {
        const error = new Error(payload?.error || `HTTP ${response.status}`)
        error.status = response.status
        error.payload = payload
        throw error
      }
      return payload
    }

    /**
     * Per-process token. A web page cannot read this cross-origin response and
     * cannot set the header on a no-cors request, so writes from other pages fail.
     */
    let CHAT_TOKEN = ''

    async function ensureToken() {
      if (CHAT_TOKEN) return CHAT_TOKEN
      const response = await fetch(`${CHAT}/token`, { headers: { accept: 'application/json' } })
      const payload = await readJson(response)
      CHAT_TOKEN = String(payload?.token ?? '')
      return CHAT_TOKEN
    }

    function authHeaders(extra) {
      return CHAT_TOKEN ? { ...extra, 'x-cc-hub-token': CHAT_TOKEN } : extra
    }

    async function getJson(url) {
      if (!CHAT_TOKEN) await ensureToken().catch(() => {})
      return fetch(url, { headers: authHeaders({ accept: 'application/json' }) }).then(readJson)
    }

    async function postJson(url, body) {
      if (!CHAT_TOKEN) await ensureToken().catch(() => {})
      return fetch(url, {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(body ?? {}),
      }).then(readJson)
    }

    function looksLikePath(value) {
      const text = String(value ?? '').trim()
      if (!text || /\s/.test(text) || text.includes('://')) return false
      if (text.startsWith('/') || text.startsWith('~/')) return true
      return /^[\w.@+-]+\/[\w.@+/-]+$/.test(text)
    }

    function resolvePath(value, cwd) {
      const text = String(value ?? '').trim()
      if (!text) return ''
      if (text.startsWith('/') || text.startsWith('~/')) return text
      if (!cwd) return ''
      return `${cwd.replace(/\/+$/, '')}/${text}`
    }

    const CODE_STYLE = {
      fontFamily: MONO,
      fontSize: '0.92em',
      padding: '1px 4px',
      background: T.layer2,
      border: `${HAIRLINE} solid ${T.line}`,
    }

    function inlineNodes(text, keyPrefix, onOpenPath, cwd) {
      const nodes = []
      const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^)\s]+\))/g
      const pathPattern = /(^|[\s(（])((?:\/Users|\/private|\/tmp|\/opt|\/Applications|\/Volumes)\/[^\s)）`,;，。；]+)/g
      const pushPlain = (plain, key) => {
        let cursor = 0
        let pIndex = 0
        let pMatch
        pathPattern.lastIndex = 0
        while ((pMatch = pathPattern.exec(plain)) !== null) {
          const start = pMatch.index + pMatch[1].length
          if (start > cursor) nodes.push(plain.slice(cursor, start))
          const target = pMatch[2]
          nodes.push(
            h(
              'span',
              {
                key: `${key}-p${pIndex++}`,
                title: onOpenPath ? `预览 ${target}` : undefined,
                onClick: onOpenPath ? () => onOpenPath(target) : undefined,
                style: onOpenPath
                  ? { color: T.accentText, textDecoration: 'underline dotted', cursor: 'pointer' }
                  : { color: T.text },
              },
              target,
            ),
          )
          cursor = start + target.length
        }
        if (cursor < plain.length) nodes.push(plain.slice(cursor))
      }
      let last = 0
      let index = 0
      let match
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) pushPlain(text.slice(last, match.index), `${keyPrefix}-t${index}`)
        const token = match[0]
        const key = `${keyPrefix}-i${index++}`
        if (token.startsWith('`')) {
          const code = token.slice(1, -1)
          const target = looksLikePath(code) ? resolvePath(code, cwd) : ''
          if (target) {
            nodes.push(
              h(
                'code',
                {
                  key,
                  title: onOpenPath ? `预览 ${target}` : undefined,
                  onClick: onOpenPath ? () => onOpenPath(target) : undefined,
                  className: 'ccs-path',
                  style: onOpenPath
                    ? { ...CODE_STYLE, cursor: 'pointer', color: T.accentText, textDecoration: 'underline dotted' }
                    : CODE_STYLE,
                },
                code,
              ),
            )
          } else {
            nodes.push(h('code', { key, style: CODE_STYLE }, code))
          }
        } else if (token.startsWith('**')) {
          nodes.push(h('strong', { key, style: { fontWeight: 650 } }, token.slice(2, -2)))
        } else if (token.startsWith('*')) {
          nodes.push(h('em', { key }, token.slice(1, -1)))
        } else {
          const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
          nodes.push(
            h(
              'a',
              { key, href: link ? link[2] : token, target: '_blank', rel: 'noreferrer', style: { color: T.accentText } },
              link ? link[1] : token,
            ),
          )
        }
        last = pattern.lastIndex
      }
      if (last < text.length) pushPlain(text.slice(last), `${keyPrefix}-end`)
      return nodes
    }

    /** Small Markdown subset; every node is React-built, no raw HTML. */
    function markdownBlocks(text, onOpenPath, cwd) {
      const lines = String(text ?? '').split('\n')
      const nodes = []
      let i = 0
      let key = 0
      const isList = (line) => /^\s*([-*+])\s+/.test(line)
      const isOrdered = (line) => /^\s*\d+\.\s+/.test(line)
      while (i < lines.length) {
        const line = lines[i]
        if (/^```/.test(line.trim())) {
          const lang = line.trim().slice(3).trim()
          const buf = []
          i += 1
          while (i < lines.length && !/^```/.test(lines[i].trim())) {
            buf.push(lines[i])
            i += 1
          }
          i += 1
          nodes.push(
            h(
              'div',
              { key: `b${key++}`, style: { position: 'relative', margin: '6px 0' } },
              lang ? h('span', { style: { fontSize: 10, color: T.caption, fontFamily: MONO } }, lang) : null,
              h(
                'pre',
                {
                  style: {
                    margin: '2px 0 0',
                    padding: '8px 10px',
                    overflowX: 'auto',
                    background: T.layer1,
                    border: `${HAIRLINE} solid ${T.line}`,
                    fontFamily: MONO,
                    fontSize: 11.5,
                    lineHeight: 1.55,
                    whiteSpace: 'pre',
                  },
                },
                h('code', null, buf.join('\n')),
              ),
            ),
          )
          continue
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading) {
          nodes.push(
            h(
              'div',
              { key: `b${key++}`, style: { fontWeight: 650, fontSize: heading[1].length <= 2 ? 14.5 : 13, margin: '8px 0 3px' } },
              inlineNodes(heading[2], `h${key}`, onOpenPath, cwd),
            ),
          )
          i += 1
          continue
        }
        const isTableRow = (value) => /^\s*\|.*\|\s*$/.test(value)
        if (isTableRow(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1])) {
          const splitRow = (value) =>
            value
              .trim()
              .replace(/^\|/, '')
              .replace(/\|$/, '')
              .split('|')
              .map((cell) => cell.trim())
          const head = splitRow(line)
          i += 2
          const body = []
          while (i < lines.length && isTableRow(lines[i])) {
            body.push(splitRow(lines[i]))
            i += 1
          }
          nodes.push(
            h(
              'table',
              { key: `b${key++}`, style: { borderCollapse: 'collapse', margin: '6px 0', fontSize: 11.5, width: '100%' } },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  head.map((cell, idx) =>
                    h(
                      'th',
                      {
                        key: idx,
                        style: { border: `${HAIRLINE} solid ${T.line}`, padding: '3px 7px', textAlign: 'left', background: T.layer1 },
                      },
                      inlineNodes(cell, `th${key}-${idx}`, onOpenPath, cwd),
                    ),
                  ),
                ),
              ),
              h(
                'tbody',
                null,
                body.map((row, rowIdx) =>
                  h(
                    'tr',
                    { key: rowIdx },
                    row.map((cell, idx) =>
                      h(
                        'td',
                        { key: idx, style: { border: `${HAIRLINE} solid ${T.line}`, padding: '3px 7px', verticalAlign: 'top' } },
                        inlineNodes(cell, `td${key}-${rowIdx}-${idx}`, onOpenPath, cwd),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          )
          continue
        }
        if (isList(line) || isOrdered(line)) {
          const ordered = isOrdered(line)
          const items = []
          while (i < lines.length && (ordered ? isOrdered(lines[i]) : isList(lines[i]))) {
            items.push(lines[i].replace(ordered ? /^\s*\d+\.\s+/ : /^\s*[-*+]\s+/, ''))
            i += 1
          }
          nodes.push(
            h(
              ordered ? 'ol' : 'ul',
              { key: `b${key++}`, style: { margin: '4px 0', paddingLeft: 20 } },
              items.map((item, idx) =>
                h('li', { key: idx, style: { margin: '2px 0' } }, inlineNodes(item, `l${key}-${idx}`, onOpenPath, cwd)),
              ),
            ),
          )
          continue
        }
        if (/^>\s?/.test(line)) {
          const buf = []
          while (i < lines.length && /^>\s?/.test(lines[i])) {
            buf.push(lines[i].replace(/^>\s?/, ''))
            i += 1
          }
          nodes.push(
            h(
              'div',
              {
                key: `b${key++}`,
                style: {
                  borderLeft: `3px solid ${T.lineStrong}`,
                  paddingLeft: 10,
                  color: T.sub,
                  margin: '4px 0',
                  whiteSpace: 'pre-wrap',
                },
              },
              inlineNodes(buf.join('\n'), `q${key}`, onOpenPath, cwd),
            ),
          )
          continue
        }
        if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
          nodes.push(h('hr', { key: `b${key++}`, style: { border: 'none', borderTop: `${HAIRLINE} solid ${T.line}`, margin: '8px 0' } }))
          i += 1
          continue
        }
        if (!line.trim()) {
          i += 1
          continue
        }
        const buf = []
        while (
          i < lines.length &&
          lines[i].trim() &&
          !/^(#{1,6})\s|^```|^\s*([-*+])\s+|^\s*\d+\.\s+|^>/.test(lines[i])
        ) {
          buf.push(lines[i])
          i += 1
        }
        nodes.push(
          h(
            'div',
            { key: `b${key++}`, style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '2px 0', lineHeight: 1.65 } },
            inlineNodes(buf.join('\n'), `p${key}`, onOpenPath, cwd),
          ),
        )
      }
      return nodes
    }

    function toolSummary(item) {
      const input = item?.input && typeof item.input === 'object' ? item.input : {}
      const text = (value) => (typeof value === 'string' ? value : '')
      if (input.command) return text(input.command)
      if (input.file_path) return text(input.file_path)
      if (input.notebook_path) return text(input.notebook_path)
      if (input.path) return text(input.path)
      if (input.pattern) return `${text(input.pattern)}${input.glob ? ` · ${text(input.glob)}` : ''}`
      if (input.description) return text(input.description)
      if (input.query) return text(input.query)
      if (input.url) return text(input.url)
      const first = Object.values(input).find((value) => typeof value === 'string')
      return first ? String(first).slice(0, 140) : ''
    }

    /** Compact renderer for one subagent transcript item. */
    function SubagentItem({ item, result, cwd, onOpenPath }) {
      if (item.kind === 'tool') {
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          h(
            'div',
            { style: { display: 'flex', gap: 7, alignItems: 'baseline', minWidth: 0 } },
            h(
              'span',
              { style: { fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.caption, background: T.layer2, borderRadius: 4, padding: '1px 5px' } },
              item.name,
            ),
            h(
              'span',
              { style: { fontFamily: MONO, fontSize: 10.5, color: T.sub, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              toolSummary(item),
            ),
          ),
          result
            ? h(
                'pre',
                { style: { margin: 0, maxHeight: 130, overflow: 'auto', padding: '5px 7px', background: T.layer1, border: `1px solid ${result.isError ? T.err : T.line}`, borderRadius: 6, fontFamily: MONO, fontSize: 10.5, color: result.isError ? T.err : T.sub, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
                result.text || '(无输出)',
              )
            : null,
        )
      }
      if (item.kind === 'result') return null
      if (item.kind === 'thinking') {
        return h('div', { style: { fontSize: 10.5, color: T.faint, whiteSpace: 'pre-wrap' } }, item.text)
      }
      if (item.kind === 'image') {
        return h('div', { style: { fontSize: 10.5, color: T.caption } }, `图片 ×${item.count ?? 1}`)
      }
      if (item.kind === 'notice') {
        return h('div', { style: { fontSize: 10.5, color: T.caption, fontFamily: MONO } }, item.text)
      }
      return h(
        'div',
        {
          style: {
            fontSize: FS2,
            lineHeight: 1.6,
            color: item.role === 'user' ? T.sub : T.text,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            borderLeft: item.role === 'user' ? `2px solid ${T.lineStrong}` : 'none',
            paddingLeft: item.role === 'user' ? 8 : 0,
          },
        },
        markdownBlocks(item.text, onOpenPath, cwd),
      )
    }

    function ToolCard({ item, result, onOpenPath, cwd, sid }) {
      const [open, setOpen] = React.useState(false)
      const [full, setFull] = React.useState(null)
      const [fullLoading, setFullLoading] = React.useState(false)
      const [fullError, setFullError] = React.useState('')
      const isAgentTool =
        item.name === 'Task' || item.name === 'Agent' || Boolean(item.input && typeof item.input.subagent_type === 'string')
      const [subOpen, setSubOpen] = React.useState(false)
      const [sub, setSub] = React.useState(null)
      const [subError, setSubError] = React.useState('')
      React.useEffect(() => {
        if (!subOpen) return undefined
        let alive = true
        let timer = null
        const tick = async () => {
          try {
            const payload = await getJson(
              `${CHAT}/subagent?session=${encodeURIComponent(sid)}&toolId=${encodeURIComponent(item.toolId)}`,
            )
            if (!alive) return
            setSub(payload)
            setSubError('')
            if (!payload?.finished) timer = setTimeout(tick, 1200)
          } catch (cause) {
            if (alive) setSubError(String(cause?.message ?? cause))
          }
        }
        tick()
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
        }
      }, [subOpen, item.toolId, sid])
      const subResults = React.useMemo(() => {
        const map = new Map()
        for (const entry of sub?.items ?? []) {
          if (entry.kind === 'result' && entry.toolId) map.set(entry.toolId, entry)
        }
        return map
      }, [sub])
      const loadFull = async () => {
        if (fullLoading) return
        setFullLoading(true)
        setFullError('')
        try {
          const payload = await getJson(
            `${CHAT}/tool?id=${encodeURIComponent(sid)}&toolId=${encodeURIComponent(item.toolId)}`,
          )
          setFull(payload)
          setOpen(true)
        } catch (cause) {
          setFullError(String(cause?.message ?? cause))
        } finally {
          setFullLoading(false)
        }
      }
      const input = item.input && typeof item.input === 'object' ? item.input : {}
      const filePath = input.file_path || input.notebook_path || input.path
      const summary = toolSummary(item)
      return h(
        'div',
        {
          className: 'ccs-card',
          style: {
            border: `1px solid ${T.line}`,
            background: T.base,
            borderRadius: 10,
            padding: '10px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 7,
            boxShadow: SHADOW.card,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 } },
          h('span', { style: { fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.caption, background: T.layer2, borderRadius: 4, padding: '2px 6px' } }, item.name),
          h(
            'span',
            {
              title: summary,
              style: {
                flex: '1 1 auto',
                minWidth: 0,
                fontFamily: MONO,
                fontSize: FS2,
                color: T.sub,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            summary,
          ),
          filePath ? h(GhostButton, { onClick: () => onOpenPath(resolvePath(filePath, cwd || '') || filePath) }, '预览') : null,
          result?.truncated || item.inputTruncated
            ? h(GhostButton, { onClick: loadFull, disabled: fullLoading }, fullLoading ? '读取…' : '完整内容')
            : null,
          isAgentTool
            ? h(GhostButton, { onClick: () => setSubOpen((value) => !value) }, subOpen ? '收起子代理' : '子代理过程')
            : null,
          h(GhostButton, { onClick: () => setOpen((value) => !value) }, open ? '收起' : '详情'),
        ),
        open
          ? h(
              'pre',
              {
                style: {
                  margin: 0,
                  maxHeight: 260,
                  overflow: 'auto',
                  fontFamily: MONO,
                  fontSize: 11,
                  color: T.sub,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                },
              },
              JSON.stringify(full?.input ?? input, null, 2),
              fullError ? `\n（完整内容读取失败：${fullError}）` : '',
            )
          : null,
        result
          ? h(
              'pre',
              {
                style: {
                  margin: 0,
                  maxHeight: open ? 360 : 120,
                  overflow: 'auto',
                  padding: '6px 8px',
                  background: T.base,
                  border: `${HAIRLINE} solid ${result.isError ? T.err : T.line}`,
                  fontFamily: MONO,
                  fontSize: 11,
                  lineHeight: 1.5,
                  color: result.isError ? T.err : T.sub,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                },
              },
              (full?.result ?? result?.text) || '(无输出)',
            )
          : null,
        subOpen
          ? h(
              'div',
              {
                style: {
                  borderTop: `1px solid ${T.line}`,
                  paddingTop: 8,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  maxHeight: 360,
                  overflow: 'auto',
                },
              },
              subError
                ? h('div', { style: { fontSize: 10.5, color: T.err } }, `子代理过程读取失败：${subError}`)
                : !sub
                  ? h('div', { style: { fontSize: 10.5, color: T.caption } }, '读取子代理过程…')
                  : [
                      h(
                        'div',
                        { key: 'subhead', style: { fontSize: 10.5, color: T.caption, position: 'sticky', top: 0, background: T.base, paddingBottom: 2 } },
                        `${sub.agentType || '子代理'}${sub.description ? ` · ${sub.description}` : ''} · ${sub.finished ? '已完成' : '运行中'}`,
                      ),
                      ...sub.items.slice(-150).map((subItem) =>
                        h(SubagentItem, {
                          key: subItem.key,
                          item: subItem,
                          result: subResults.get(subItem.toolId),
                          cwd,
                          onOpenPath,
                        }),
                      ),
                    ],
            )
          : null,
      )
    }

    function MessageList({ items, partial, cwd, onOpenPath, sid }) {
      const body = React.useMemo(() => {
        const toolIds = new Set(items.filter((item) => item.kind === 'tool' && item.toolId).map((item) => item.toolId))
        const results = new Map()
        for (const item of items) {
          if (item.kind === 'result' && item.toolId && toolIds.has(item.toolId)) results.set(item.toolId, item)
        }
        const nodes = []
        for (const item of items) {
          if (item.kind === 'result' && item.toolId && toolIds.has(item.toolId)) continue
          if (item.kind === 'notice') {
            nodes.push(
              h(
                'div',
                {
                  key: item.key,
                  style: {
                    fontSize: 11,
                    fontFamily: MONO,
                    color: item.level === 'warning' || item.level === 'suggestion' ? T.warn : T.caption,
                    background: T.layer1,
                    border: `${HAIRLINE} solid ${T.line}`,
                    padding: '5px 9px',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  },
                },
                item.text,
              ),
            )
            continue
          }
          if (item.kind === 'image') {
            nodes.push(
              h(
                'div',
                {
                  key: item.key,
                  style: {
                    alignSelf: 'flex-end',
                    fontSize: 11,
                    color: T.sub,
                    border: `${HAIRLINE} solid ${T.cardStroke}`,
                    background: T.card,
                    padding: '4px 9px',
                  },
                },
                `图片 ×${item.count ?? 1}`,
              ),
            )
            continue
          }
          if (item.kind === 'tool') {
            nodes.push(h(ToolCard, { key: item.key, item, result: results.get(item.toolId), onOpenPath, cwd, sid }))
            continue
          }
          if (item.kind === 'result') {
            // A tool_use outside the loaded window: show its output as output,
            // not as assistant prose.
            nodes.push(
              h(
                'div',
                {
                  key: item.key,
                  style: {
                    fontSize: 11,
                    fontFamily: MONO,
                    color: item.isError ? T.err : T.faint,
                    borderLeft: `3px solid ${T.line}`,
                    paddingLeft: 8,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  },
                },
                `工具输出${item.name ? ` · ${item.name}` : ''}\n${item.text || '(无输出)'}`,
              ),
            )
            continue
          }
          if (item.kind === 'thinking') {
            nodes.push(
              h(
                'details',
                {
                  key: item.key,
                  style: {
                    fontSize: FS2,
                    color: T.caption,
                    background: T.layer1,
                    border: `1px solid ${T.line}`,
                    borderRadius: 9,
                    padding: '7px 10px',
                  },
                },
                h('summary', { style: { cursor: 'pointer' } }, '思考过程'),
                h('div', { style: { whiteSpace: 'pre-wrap', marginTop: 4, color: T.faint } }, item.text),
              ),
            )
            continue
          }
          const inner = h('div', null, markdownBlocks(item.text, onOpenPath, cwd))
          if (item.role === 'user') {
            nodes.push(
              h(
                'div',
                {
                  key: item.key,
                  style: {
                    alignSelf: 'flex-end',
                    maxWidth: '86%',
                    padding: '9px 13px',
                    background: ACCENT_SOFT,
                    border: `1px solid ${ACCENT_LINE}`,
                    borderRadius: R.card,
                    boxShadow: SHADOW.card,
                  },
                },
                inner,
              ),
            )
          } else {
            nodes.push(h('div', { key: item.key, style: { maxWidth: '100%' } }, inner))
          }
        }
        return nodes
      }, [items, cwd, onOpenPath, sid])
      if (!partial) return body
      return [
        ...body,
        h(
          'div',
          { key: 'partial', style: { color: T.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
          partial.text,
          h('span', { style: { color: T.accent } }, '▍'),
        ),
      ]
    }

    const CHAT_STATUS = {
      draft: { label: '草稿', color: T.caption },
      archived: { label: '历史 · 可续聊', color: T.sub },
      'live-readonly': { label: '终端运行中 · 只读', color: T.warn },
      idle: { label: '就绪', color: T.ok },
      running: { label: '运行中', color: T.accent },
      waiting: { label: '等待审批', color: T.warn },
      error: { label: '出错', color: T.err },
      closed: { label: '已结束', color: T.caption },
    }

    function chatStatus(snap, draft) {
      if (draft && !snap) return CHAT_STATUS.draft
      const status = snap?.status ?? 'draft'
      return CHAT_STATUS[status] ?? { label: status, color: T.sub }
    }

    /** AskUserQuestion is a tool call: the answer rides back as updatedInput.answers. */
    function QuestionCard({ pending, busy, onDecide }) {
      const questions = Array.isArray(pending?.questions) ? pending.questions : []
      const [selected, setSelected] = React.useState({})
      const [free, setFree] = React.useState({})
      const choose = (index, label, multi) => {
        setSelected((prev) => {
          const current = prev[index]
          if (multi) {
            const list = Array.isArray(current) ? current : []
            return { ...prev, [index]: list.includes(label) ? list.filter((value) => value !== label) : [...list, label] }
          }
          return { ...prev, [index]: label }
        })
      }
      const submit = () => {
        const answers = {}
        questions.forEach((question, index) => {
          const typed = String(free[index] ?? '').trim()
          if (typed) {
            answers[question.question] = typed
            return
          }
          const value = selected[index]
          if (Array.isArray(value) && value.length > 0) answers[question.question] = value.join(', ')
          else if (typeof value === 'string' && value) answers[question.question] = value
        })
        if (Object.keys(answers).length === 0) return
        onDecide('allow', pending.requestId, answers)
      }
      return h(
        'div',
        {
          style: {
            margin: '0 16px 10px',
            padding: '12px 14px',
            border: `1px solid ${ACCENT_LINE}`,
            borderRadius: R.card,
            background: T.base,
            boxShadow: SHADOW.pop,
            display: 'flex',
            flexDirection: 'column',
            gap: 11,
          },
        },
        h('div', { style: { fontSize: FS2, fontWeight: 600 } }, '需要你选择'),
        questions.map((question, index) =>
          h(
            'div',
            { key: index, style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            h(
              'div',
              { style: { fontSize: FS2, color: T.text } },
              question.header
                ? h('span', { style: { color: T.caption, marginRight: 6 } }, question.header)
                : null,
              question.question,
            ),
            (Array.isArray(question.options) ? question.options : []).map((option) => {
              const current = selected[index]
              const active = Array.isArray(current) ? current.includes(option.label) : current === option.label
              return h(
                'button',
                {
                  key: option.label,
                  type: 'button',
                  onClick: () => choose(index, option.label, question.multiSelect === true),
                  style: {
                    appearance: 'none',
                    textAlign: 'left',
                    padding: '8px 10px',
                    background: active ? ACCENT_SOFT : T.layer1,
                    border: `1px solid ${active ? ACCENT_LINE : T.line}`,
                    borderRadius: 9,
                    color: T.text,
                    fontFamily: 'inherit',
                    fontSize: FS2,
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 3,
                    transition: TRANS,
                  },
                },
                h('span', { style: { fontWeight: 600 } }, option.label),
                option.description
                  ? h('span', { style: { color: T.caption, whiteSpace: 'pre-wrap' } }, option.description)
                  : null,
              )
            }),
            h('input', {
              value: free[index] ?? '',
              onChange: (event) => setFree((prev) => ({ ...prev, [index]: event.target.value })),
              placeholder: '其他（可直接输入答案）',
              style: {
                padding: '4px 8px',
                fontFamily: 'inherit',
                fontSize: FS2,
                color: T.text,
                background: T.layer1,
                border: `${HAIRLINE} solid ${T.line}`,
                outline: 'none',
              },
            }),
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 6 } },
          h(PrimaryButton, { onClick: submit, disabled: busy || questions.length === 0 }, '提交选择'),
          h(GhostButton, { onClick: () => onDecide('deny', pending.requestId), disabled: busy }, '跳过'),
        ),
      )
    }

    function PermissionCard({ pending, busy, onDecide }) {
      const input = pending?.input && typeof pending.input === 'object' ? pending.input : {}
      const detail = input.command || input.file_path || input.url || JSON.stringify(input, null, 2)
      const destinations = Array.isArray(pending?.destinations) ? pending.destinations : []
      return h(
        'div',
        {
          style: {
            margin: '0 16px 10px',
            padding: '12px 14px',
            border: `1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #e5a11a) 45%, transparent)`,
            borderRadius: R.card,
            background: T.base,
            boxShadow: SHADOW.pop,
            display: 'flex',
            flexDirection: 'column',
            gap: 9,
          },
        },
        h('div', { style: { fontSize: FS2, fontWeight: 600 } }, `需要你确认：${pending?.toolName || 'tool'}`),
        pending?.defaultToNo
          ? h('div', { style: { fontSize: 11, color: T.warn } }, '这一项建议默认拒绝——请先看清内容再决定。')
          : null,
        h(
          'pre',
          {
            style: {
              margin: 0,
              maxHeight: 160,
              overflow: 'auto',
              padding: '6px 8px',
              background: T.base,
              fontFamily: MONO,
              fontSize: 11,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            },
          },
          String(detail).slice(0, 1600),
        ),
        destinations.length > 0
          ? h(
              'div',
              { style: { fontSize: 10.5, color: T.caption } },
              `「始终允许」会写入：${destinations.join(' / ')}`,
            )
          : null,
        h(
          'div',
          { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
          h(PrimaryButton, { onClick: () => onDecide('allow', pending?.requestId), disabled: busy }, '允许'),
          pending?.allowAlways !== false && pending?.suggestions > 0
            ? h(
                GhostButton,
                { onClick: () => onDecide('allow_always', pending?.requestId), disabled: busy },
                '始终允许',
              )
            : null,
          h(GhostButton, { onClick: () => onDecide('deny', pending?.requestId), disabled: busy }, '拒绝'),
        ),
      )
    }

    /** PDF / Office preview through a Blob URL: the app's custom scheme is not
     * guaranteed to hand a PDF to Chromium's viewer, a blob URL is. */
    function PdfFrame({ path }) {
      const [url, setUrl] = React.useState('')
      const [error, setError] = React.useState('')
      React.useEffect(() => {
        let objectUrl = ''
        let alive = true
        setUrl('')
        setError('')
        ;(async () => {
          try {
            if (!CHAT_TOKEN) await ensureToken()
            const response = await fetch(`${CHAT_FILE}/pdf?path=${encodeURIComponent(path)}`, {
              headers: authHeaders({}),
            })
            if (!response.ok) {
              const text = await response.text()
              throw new Error(text.slice(0, 300) || `HTTP ${response.status}`)
            }
            const blob = await response.blob()
            objectUrl = URL.createObjectURL(blob)
            if (alive) setUrl(objectUrl)
          } catch (cause) {
            if (alive) setError(String(cause?.message ?? cause))
          }
        })()
        return () => {
          alive = false
          if (objectUrl) URL.revokeObjectURL(objectUrl)
        }
      }, [path])
      if (error) {
        return h('div', { style: { padding: 12, fontSize: FS2, color: T.err, whiteSpace: 'pre-wrap' } }, `PDF 预览失败：${error}`)
      }
      if (!url) {
        return h('div', { style: { padding: 12, fontSize: FS2, color: T.caption } }, '正在转换 / 加载 PDF…')
      }
      return h('iframe', {
        title: path,
        src: url,
        style: { width: '100%', minHeight: '60vh', border: 'none', background: '#fff' },
      })
    }

    function PreviewPane({ path, onClose, onOpenPath }) {
      const [state, setState] = React.useState({ status: 'loading' })
      React.useEffect(() => {
        let alive = true
        setState({ status: 'loading' })
        getJson(`${CHAT_FILE}?path=${encodeURIComponent(path)}`)
          .then((payload) => {
            if (alive) setState({ status: 'ready', value: payload })
          })
          .catch((error) => {
            if (alive) setState({ status: 'error', message: String(error?.message ?? error) })
          })
        return () => {
          alive = false
        }
      }, [path])

      const open = (reveal) => {
        postJson('/_ccpanel/open', { path, reveal }).catch((error) =>
          setState((prev) => ({ ...prev, actionError: String(error?.message ?? error) })),
        )
      }

      return h(
        'div',
        {
          style: {
            flex: '0 0 42%',
            minWidth: 300,
            maxWidth: 760,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            borderLeft: `1px solid ${T.line}`,
            background: T.base,
            boxShadow: '-12px 0 32px rgba(15,23,42,0.06)',
          },
        },
        h(
          'div',
          {
            style: {
              padding: '8px 10px',
              borderBottom: `${HAIRLINE} solid ${T.line}`,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            },
          },
          h(
            'span',
            { title: path, style: { flex: '1 1 auto', minWidth: 0, fontFamily: MONO, fontSize: 11, color: T.sub, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            path,
          ),
          h(GhostButton, { onClick: () => open(false) }, '打开'),
          h(GhostButton, { onClick: () => open(true) }, 'Finder'),
          h(GhostButton, { onClick: onClose }, '关闭'),
        ),
        h(
          'div',
          { style: { flex: '1 1 auto', minHeight: 0, overflow: 'auto' } },
          state.status === 'loading'
            ? h('div', { style: { padding: 12, fontSize: FS2, color: T.caption } }, '读取中…')
            : state.status === 'error'
              ? h('div', { style: { padding: 12, fontSize: FS2, color: T.err } }, `预览失败：${state.message}`)
              : state.value?.kind === 'image'
                ? h('img', {
                    src: `${CHAT_FILE}/raw?path=${encodeURIComponent(path)}`,
                    alt: path,
                    style: { maxWidth: '100%', display: 'block', margin: '10px auto', borderRadius: 8, boxShadow: SHADOW.card },
                  })
                : state.value?.kind === 'markdown'
                  ? h(
                      'div',
                      { style: { padding: '10px 14px', fontSize: FS, color: T.text, lineHeight: 1.65 } },
                      markdownBlocks(state.value.text, onOpenPath ?? (() => {}), path.replace(/\/[^/]*$/, '')),
                      state.value.truncated ? h('div', { style: { color: T.caption, fontSize: 11 } }, '…（文件过大，只显示前 600KB）') : null,
                    )
                  : state.value?.kind === 'html'
                    ? h('iframe', {
                        title: path,
                        sandbox: '',
                        srcDoc: state.value.text,
                        style: { width: '100%', minHeight: '60vh', border: 'none', background: '#fff' },
                      })
                    : state.value?.kind === 'pdf' || state.value?.kind === 'office'
                      ? h(
                          'div',
                          { style: { display: 'flex', flexDirection: 'column', minHeight: '60vh' } },
                          state.value?.kind === 'office'
                            ? h(
                                'div',
                                { style: { padding: '4px 10px', fontSize: 10.5, color: T.caption } },
                                'Word/ODT 已用本机 LibreOffice 转为 PDF 预览',
                              )
                            : null,
                          h(PdfFrame, { path }),
                        )
                      : state.value?.kind === 'text'
                        ? h(
                            'pre',
                            {
                              style: {
                                margin: 0,
                                padding: '10px 12px',
                                fontFamily: MONO,
                                fontSize: 11.5,
                                lineHeight: 1.55,
                                color: T.text,
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word',
                              },
                            },
                            state.value.text,
                            state.value.truncated ? '\n…（文件过大，只显示前 600KB）' : '',
                          )
                        : h(
                            'div',
                            { style: { padding: 12, fontSize: FS2, color: T.caption } },
                            state.value?.reason || '该文件不支持内置预览，可用「打开」交给系统应用。',
                          ),
        ),
        state.actionError
          ? h('div', { style: { padding: '6px 10px', fontSize: 11, color: T.err, borderTop: `${HAIRLINE} solid ${T.line}` } }, state.actionError)
          : null,
      )
    }

    const MODE_OPTIONS = [
      { value: 'default', label: '默认（逐次确认）' },
      { value: 'plan', label: '计划（只读）' },
      { value: 'auto', label: '自动（分类器）' },
      { value: 'acceptEdits', label: '接受编辑' },
      { value: 'dontAsk', label: '不询问（未授权即拒）' },
    ]

    const EFFORT_OPTIONS = [
      { value: 'inherit', label: 'effort：跟随设置' },
      { value: 'low', label: 'low' },
      { value: 'medium', label: 'medium' },
      { value: 'high', label: 'high' },
      { value: 'xhigh', label: 'xhigh' },
      { value: 'max', label: 'max' },
    ]

    function MiniSelect({ value, onChange, options, title, disabled }) {
      return h(
        'select',
        {
          value,
          title,
          disabled: Boolean(disabled),
          onChange: (event) => onChange(event.target.value),
          style: {
            appearance: 'none',
            height: 24,
            padding: '0 6px',
            fontFamily: 'inherit',
            fontSize: 11,
            color: T.sub,
            background: T.layer1,
            border: `${HAIRLINE} solid ${T.line}`,
            outline: 'none',
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.5 : 1,
          },
        },
        options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
      )
    }

    /** Session-level subagent explorer: independent of which Task cards are in the window. */
    function SubagentPane({ sessionId, list, selected, onSelect, onClose, cwd, onOpenPath, floating }) {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      React.useEffect(() => {
        if (!selected?.toolUseId) {
          setData(null)
          setError('')
          return undefined
        }
        let alive = true
        let timer = null
        const tick = async () => {
          try {
            const payload = await getJson(
              `${CHAT}/subagent?session=${encodeURIComponent(sessionId)}&toolId=${encodeURIComponent(selected.toolUseId)}`,
            )
            if (!alive) return
            setData(payload)
            setError('')
            if (!payload?.finished) timer = setTimeout(tick, 1200)
          } catch (cause) {
            if (alive) setError(String(cause?.message ?? cause))
          }
        }
        tick()
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
        }
      }, [sessionId, selected?.toolUseId])
      const results = React.useMemo(() => {
        const map = new Map()
        for (const entry of data?.items ?? []) {
          if (entry.kind === 'result' && entry.toolId) map.set(entry.toolId, entry)
        }
        return map
      }, [data])
      return h(
        'div',
        {
          style: floating
            ? {
                flex: '1 1 auto',
                minWidth: 0,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                background: T.base,
              }
            : {
                flex: '0 0 42%',
                minWidth: 300,
                maxWidth: 760,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                borderLeft: `1px solid ${T.line}`,
                background: T.base,
                boxShadow: '-12px 0 32px rgba(15,23,42,0.06)',
              },
        },
        h(
          'div',
          { style: { padding: '10px 12px', borderBottom: `1px solid ${T.line}`, display: 'flex', alignItems: 'center', gap: 6 } },
          selected
            ? h(GhostButton, { onClick: () => onSelect(null) }, '← 列表')
            : h('span', { style: { fontSize: FS2, fontWeight: 600, color: T.text } }, `子代理（${list.length}）`),
          selected
            ? h(
                'span',
                { title: selected.description, style: { flex: '1 1 auto', minWidth: 0, fontSize: 11, color: T.sub, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                selected.description || selected.id,
              )
            : h('span', { style: { flex: '1 1 auto' } }),
          h(GhostButton, { onClick: onClose }, '关闭'),
        ),
        h(
          'div',
          { style: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 } },
          !selected
            ? list.length === 0
              ? h('div', { style: { fontSize: FS2, color: T.caption } }, '这个会话没有子代理记录')
              : list.map((entry) =>
                  h(
                    'button',
                    {
                      key: entry.id,
                      type: 'button',
                      onClick: () => onSelect(entry),
                      style: {
                        appearance: 'none',
                        textAlign: 'left',
                        padding: '8px 10px',
                        background: T.layer1,
                        border: `1px solid ${T.line}`,
                        borderRadius: 9,
                        color: T.text,
                        fontFamily: 'inherit',
                        fontSize: FS2,
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 3,
                        transition: TRANS,
                      },
                    },
                    h('span', { style: { fontWeight: 600 } }, entry.description || entry.id),
                    h(
                      'span',
                      { style: { fontSize: 10.5, color: T.caption } },
                      `${entry.agentType || '子代理'} · ${entry.finished ? '已完成' : '运行中'}`,
                    ),
                  ),
                )
            : error
              ? h('div', { style: { fontSize: FS2, color: T.err } }, `读取失败：${error}`)
              : !data
                ? h('div', { style: { fontSize: FS2, color: T.caption } }, '读取子代理过程…')
                : [
                    h(
                      'div',
                      { key: 'head', style: { fontSize: 10.5, color: T.caption } },
                      `${data.agentType || '子代理'} · ${data.finished ? '已完成' : '运行中'}${data.description ? ` · ${data.description}` : ''}`,
                    ),
                    ...data.items.slice(-200).map((entry) =>
                      h(SubagentItem, {
                        key: entry.key,
                        item: entry,
                        result: results.get(entry.toolId),
                        cwd,
                        onOpenPath,
                      }),
                    ),
                  ],
        ),
      )
    }

    /** Floating shell so the list can open a session's subagents without entering it. */
    function SubagentDrawer({ view, onClose }) {
      const [selected, setSelected] = React.useState(null)
      return h(
        'div',
        { style: { position: 'absolute', inset: 0, zIndex: 80 } },
        h('div', {
          onClick: onClose,
          style: { position: 'absolute', inset: 0, background: 'rgba(15,23,42,0.18)' },
        }),
        h(
          'div',
          {
            style: {
              position: 'absolute',
              top: 0,
              right: 0,
              bottom: 0,
              width: 'min(680px, 100%)',
              minWidth: 320,
              display: 'flex',
              flexDirection: 'column',
              background: T.base,
              borderLeft: `1px solid ${T.line}`,
              boxShadow: '-18px 0 48px rgba(0,0,0,0.20)',
            },
          },
          h(SubagentPane, {
            floating: true,
            sessionId: view.sessionId,
            list: view.list,
            selected,
            onSelect: setSelected,
            onClose,
            cwd: view.cwd,
          }),
        ),
      )
    }

    function ChatView({ target, onBack }) {
      const [sid, setSid] = React.useState(target.id)
      const [snap, setSnap] = React.useState(null)
      const [draft, setDraft] = React.useState(target.draft === true)
      const [cwd, setCwd] = React.useState(target.cwd || '')
      const [text, setText] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [preview, setPreview] = React.useState(null)
      const [commands, setCommands] = React.useState([])
      const [showCommands, setShowCommands] = React.useState(false)
      const [showSettings, setShowSettings] = React.useState(false)
      const [showPreviewPicker, setShowPreviewPicker] = React.useState(false)
      const [previewPathInput, setPreviewPathInput] = React.useState('')
      const [subagents, setSubagents] = React.useState([])
      const [subPane, setSubPane] = React.useState(false)
      const [subSelected, setSubSelected] = React.useState(null)
      const [live, setLive] = React.useState(null)
      const [older, setOlder] = React.useState([])
      const [olderStart, setOlderStart] = React.useState(0)
      const [loadingOlder, setLoadingOlder] = React.useState(false)
      const [thinking, setThinking] = React.useState(false)
      const [images, setImages] = React.useState([])
      const [streamEpoch, setStreamEpoch] = React.useState(0)
      const listRef = React.useRef(null)
      const fileRef = React.useRef(null)
      const stickRef = React.useRef(true)
      const draftRef = React.useRef(draft)
      const lastItemsTotal = React.useRef(-1)
      draftRef.current = draft

      const fetchState = React.useCallback(
        async ({ quiet = false } = {}) => {
          try {
            const payload = await getJson(
              `${CHAT}/state?id=${encodeURIComponent(sid)}&thinking=${thinking ? 1 : 0}`,
            )
            setSnap((prev) => {
              if (prev && payload.itemsRev === prev.itemsRev && payload.itemsTotal === prev.itemsTotal) {
                return { ...payload, items: prev.items }
              }
              return payload
            })
            setError('')
            return payload
          } catch (cause) {
            if (cause.status === 404 && draftRef.current) return null
            if (!quiet) setError(String(cause?.message ?? cause))
            return null
          }
        },
        [sid, thinking],
      )

      React.useEffect(() => {
        let alive = true
        let timer = null
        const schedule = (ms) => {
          if (alive) timer = setTimeout(tick, ms)
        }
        const tick = async () => {
          const payload = await fetchState()
          if (!alive) return
          const status = payload?.status
          const running = status === 'running' || status === 'waiting'
          schedule(running ? 2500 : status === 'live-readonly' ? 3000 : 5000)
        }
        tick()
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
        }
      }, [fetchState])

      // Live text/status over SSE. The full item list still comes from `state`,
      // fetched only when the stream reports a new item count.
      React.useEffect(() => {
        let closed = false
        let controller = null
        let reconnect = null
        let retryMs = 1200
        const connect = async () => {
          if (closed) return
          controller = new AbortController()
          let sawLive = false
          let notLive = false
          try {
            if (!CHAT_TOKEN) await ensureToken()
            const response = await fetch(`${CHAT}/stream?id=${encodeURIComponent(sid)}`, {
              headers: authHeaders({ accept: 'text/event-stream' }),
              signal: controller.signal,
            })
            if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
            const reader = response.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            while (!closed) {
              const { value, done } = await reader.read()
              if (done) break
              buffer += decoder.decode(value, { stream: true })
              let index
              while ((index = buffer.indexOf('\n\n')) >= 0) {
                const chunk = buffer.slice(0, index)
                buffer = buffer.slice(index + 2)
                const line = chunk.split('\n').find((row) => row.startsWith('data: '))
                if (!line) continue
                let payload
                try {
                  payload = JSON.parse(line.slice(6))
                } catch {
                  continue
                }
                if (!payload.live) {
                  setLive(null)
                  notLive = true
                  break
                }
                sawLive = true
                retryMs = 1200
                setLive(payload)
                if (payload.itemsTotal !== lastItemsTotal.current) {
                  lastItemsTotal.current = payload.itemsTotal
                  fetchState({ quiet: true })
                }
              }
            }
          } catch (cause) {
            if (closed || controller?.signal?.aborted) return
          }
          if (notLive && !closed) {
            reconnect = setTimeout(connect, 2000)
            return
          }
          if (!closed) {
            if (!sawLive) retryMs = Math.min(5000, Math.round(retryMs * 1.5))
            reconnect = setTimeout(connect, retryMs)
          }
        }
        connect()
        return () => {
          closed = true
          if (reconnect) clearTimeout(reconnect)
          try {
            controller?.abort()
          } catch {
            /* already gone */
          }
        }
      }, [sid, fetchState, streamEpoch])

      React.useEffect(() => {
        const el = listRef.current
        if (el && stickRef.current) el.scrollTop = el.scrollHeight
      }, [snap, live])

      // Commands come from the runtime's init when available; the static scan
      // covers drafts and sessions that have not started yet.
      React.useEffect(() => {
        let alive = true
        getJson(`${CHAT}/commands?id=${encodeURIComponent(sid)}`)
          .then((payload) => {
            if (alive && Array.isArray(payload?.commands)) setCommands(payload.commands)
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [sid])

      React.useEffect(() => {
        let alive = true
        getJson(`${CHAT}/subagents?session=${encodeURIComponent(sid)}`)
          .then((payload) => {
            if (alive) setSubagents(Array.isArray(payload?.subagents) ? payload.subagents : [])
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [sid])

      const runtimeCommands = snap?.settings?.commands
      React.useEffect(() => {
        if (Array.isArray(runtimeCommands) && runtimeCommands.length > 0) setCommands(runtimeCommands)
      }, [runtimeCommands && runtimeCommands.length])

      const onScroll = () => {
        const el = listRef.current
        if (!el) return
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90
      }

      const send = async () => {
        const body = text.trim()
        const attachments = images
        if ((!body && attachments.length === 0) || busy) return
        if (!cwd && draft) {
          setError('先选一个工作目录')
          return
        }
        setBusy(true)
        setError('')
        setNotice('')
        const optimisticKey = `local-${Date.now()}`
        const optimistic = []
        if (body) optimistic.push({ key: optimisticKey, role: 'user', kind: 'text', text: body })
        if (attachments.length > 0) {
          optimistic.push({ key: `${optimisticKey}-img`, role: 'user', kind: 'image', count: attachments.length })
        }
        setSnap((prev) =>
          prev
            ? { ...prev, status: 'running', items: [...(prev.items || []), ...optimistic] }
            : { id: sid, cwd, status: 'running', items: optimistic, source: 'panel' },
        )
        setText('')
        setImages([])
        stickRef.current = true
        try {
          const payload = await postJson(`${CHAT}/send`, {
            id: sid,
            text: body,
            cwd: cwd || undefined,
            images: attachments.map((image) => ({ media_type: image.media_type, data: image.data })),
          })
          setSnap(payload)
          lastItemsTotal.current = payload.itemsTotal ?? -1
          setStreamEpoch((value) => value + 1)
          setDraft(false)
        } catch (cause) {
          setError(String(cause?.message ?? cause))
          setText(body)
          setImages(attachments)
          setSnap((prev) =>
            prev
              ? { ...prev, items: (prev.items || []).filter((item) => item.key !== optimisticKey && item.key !== `${optimisticKey}-img`) }
              : prev,
          )
        } finally {
          setBusy(false)
        }
      }

      const loadOlder = async () => {
        if (loadingOlder || boundary <= 0) return
        setLoadingOlder(true)
        try {
          const payload = await getJson(
            `${CHAT}/history?id=${encodeURIComponent(sid)}&before=${boundary}&limit=250&thinking=${thinking ? 1 : 0}`,
          )
          const el = listRef.current
          const beforeHeight = el ? el.scrollHeight : 0
          setOlder((prev) => [...(payload.items || []), ...prev])
          setOlderStart(payload.from ?? 0)
          requestAnimationFrame(() => {
            if (el) el.scrollTop += el.scrollHeight - beforeHeight
          })
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setLoadingOlder(false)
        }
      }

      const lastFilePath = React.useMemo(() => {
        const list = snap?.items ?? []
        for (let index = list.length - 1; index >= 0; index -= 1) {
          const input = list[index]?.input
          const candidate = input?.file_path || input?.path || input?.notebook_path
          if (typeof candidate === 'string' && candidate.startsWith('/')) return candidate
        }
        return ''
      }, [snap?.items])

      const openPreviewPath = () => {
        const raw = previewPathInput.trim().replace(/^[\"'`]+|[\"'`]+$/g, '')
        if (!raw) {
          setNotice('先输入绝对路径，或点消息里工具卡的「预览」')
          return
        }
        if (!raw.startsWith('/') && !raw.startsWith('~')) {
          setNotice('需要绝对路径（以 / 或 ~ 开头）')
          return
        }
        setPreview(raw)
      }

      const openPreviewPicker = () => {
        setPreviewPathInput((prev) => prev || lastFilePath)
        setShowPreviewPicker((value) => !value)
      }

      const closeSession = async () => {
        if (busy) return
        setBusy(true)
        try {
          await postJson(`${CHAT}/dispose`, { id: sid })
          setLive(null)
          setOlder([])
          setOlderStart(0)
          await fetchState({ quiet: true })
          setNotice('已结束面板会话进程；记录保留，再次发送会 resume')
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }

      const toggleThinking = async () => {
        const next = !thinking
        setThinking(next)
        // A terminal-held session cannot take options; its transcript can still
        // be re-read with thinking, which the state fetch does.
        if (readonly && snap?.status === 'live-readonly') return
        try {
          const payload = await postJson(`${CHAT}/options`, {
            id: sid,
            cwd: cwd || undefined,
            thinking: next,
          })
          setSnap((prev) =>
            prev ? { ...prev, thinking: next, mode: payload?.mode ?? prev.mode, effort: payload?.effort ?? prev.effort } : prev,
          )
        } catch (cause) {
          setError(String(cause?.message ?? cause))
          setThinking(!next)
        }
      }

      const addFiles = (fileList) => {
        const files = [...fileList].filter((file) => String(file.type).startsWith('image/'))
        for (const file of files.slice(0, 4 - images.length)) {
          if (file.size > 5 * 1024 * 1024) {
            setError('单张图片上限 5MB')
            continue
          }
          const reader = new FileReader()
          reader.onload = () => {
            const dataUrl = String(reader.result ?? '')
            const comma = dataUrl.indexOf(',')
            if (comma < 0) return
            setImages((prev) =>
              prev.length >= 4
                ? prev
                : [
                    ...prev,
                    {
                      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
                      media_type: file.type,
                      data: dataUrl.slice(comma + 1),
                      name: file.name,
                    },
                  ],
            )
          }
          reader.readAsDataURL(file)
        }
      }

      const stop = async () => {
        try {
          const payload = await postJson(`${CHAT}/stop`, { id: sid })
          setSnap(payload)
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        }
      }

      const decide = async (decision, requestId, answers) => {
        setBusy(true)
        try {
          const payload = await postJson(`${CHAT}/permission`, { id: sid, requestId, decision, answers })
          setSnap(payload)
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }

      const fork = async () => {
        setBusy(true)
        setError('')
        try {
          const payload = await postJson(`${CHAT}/fork`, { id: sid, cwd: cwd || undefined })
          setSid(payload.id)
          setSnap(payload)
          setDraft(false)
          setNotice('已 fork 到面板，可以继续对话；原会话不受影响')
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }

      const pickDir = async () => {
        setError('')
        try {
          const payload = await postJson('/_ccpanel/pick-dir', {})
          if (payload?.path) setCwd(payload.path)
          else setNotice('已取消选择')
        } catch (cause) {
          setError(`目录选择器不可用：${String(cause?.message ?? cause)}（可直接输入绝对路径）`)
        }
      }

      const setOption = async (patch) => {
        if (draft && !cwd) {
          setError('先选工作目录，再改会话设置')
          return
        }
        setBusy(true)
        setError('')
        try {
          const payload = await postJson(`${CHAT}/options`, { id: sid, cwd: cwd || undefined, ...patch })
          setSnap(payload)
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }

      const insertCommand = (name) => {
        setText(`/${name} `)
        setShowCommands(false)
        setError('')
      }

      const displayStatus = live?.status ?? snap?.status
      const readonly = displayStatus === 'live-readonly' || (snap === null && target.live === true)
      const slashQuery = /^\/(\S*)$/.exec(text)
      const commandList = commands
        .filter((name) => !slashQuery || slashQuery[1] === '' || String(name).toLowerCase().includes(slashQuery[1].toLowerCase()))
        .slice(0, 80)
      const showCommandList = !readonly && (showCommands || Boolean(slashQuery))

      const status = chatStatus({ ...(snap || {}), status: displayStatus }, draft)
      const baseItems = snap?.items ?? []
      const items = older.length > 0 ? [...older, ...baseItems] : baseItems
      const boundary = older.length > 0 ? olderStart : (snap?.itemsFrom ?? 0)
      const rawPartial = live ? live.partial : snap?.partial
      const lastAssistantText = [...items]
        .reverse()
        .find((item) => item.role === 'assistant' && item.kind === 'text')?.text
      const partial =
        rawPartial && rawPartial.text && !(lastAssistantText && lastAssistantText.includes(rawPartial.text.trim()))
          ? rawPartial
          : null
      const title = target.title || snap?.title || shortId(sid)
      const pending = Array.isArray(live?.pending)
        ? live.pending
        : Array.isArray(snap?.pending)
          ? snap.pending
          : []
      const runningStatus = displayStatus === 'running' || displayStatus === 'waiting'

      return h(
        'div',
        {
          style: {
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            color: T.text,
            fontSize: FS,
            fontFamily: FONT,
            background: T.base,
          },
        },
        h(PanelStyle, null),
        h(
          'div',
          {
            style: {
              padding: '14px 18px',
              borderBottom: `1px solid ${T.line}`,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
            },
          },
          h(GhostButton, { onClick: onBack }, '← 列表'),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '1 1 220px' } },
            h(
              'span',
              { title, style: { fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              title,
            ),
            h(
              'span',
              { style: { fontSize: 10.5, color: T.caption, fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              `${shortId(sid)}${snap?.model ? ` · ${snap.model}` : ''}${snap?.ccVersion ? ` · cc ${snap.ccVersion}` : ''}`,
            ),
          ),
          h(
            'span',
            {
              style: {
                fontSize: 10.5,
                color: status.color,
                border: `1px solid color-mix(in srgb, ${status.color} 35%, transparent)`,
                background: T.layer1,
                borderRadius: R.pill,
                padding: '3px 9px',
                whiteSpace: 'nowrap',
              },
            },
            status.label,
          ),
          subagents.length > 0
            ? h(
                GhostButton,
                {
                  onClick: () => {
                    setSubPane((value) => !value)
                    setSubSelected(null)
                  },
                },
                `子代理（${subagents.length}）`,
              )
            : null,
          h(GhostButton, { onClick: openPreviewPicker }, '预览文件'),
          h(GhostButton, { onClick: () => setShowSettings((value) => !value) }, showSettings ? '收起设置' : '设置'),
          snap?.source === 'panel'
            ? h(GhostButton, { onClick: closeSession, disabled: busy, title: '结束面板持有的进程；会话记录保留' }, '结束会话')
            : null,
          runningStatus ? h(GhostButton, { onClick: stop }, '停止') : null,
          readonly ? h(GhostButton, { onClick: fork, disabled: busy }, 'fork 到面板') : null,
        ),
        showSettings
          ? h(
              'div',
              {
                style: {
                  margin: '10px 16px',
                  padding: '12px 14px',
                  border: `1px solid ${T.line}`,
                  borderRadius: R.card,
                  background: T.layer1,
                  boxShadow: SHADOW.card,
                  display: 'grid',
                  gridTemplateColumns: 'auto 1fr',
                  gap: '5px 12px',
                  fontSize: 11,
                  color: T.sub,
                },
              },
              h(
                'div',
                { style: { gridColumn: '1 / -1', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', paddingBottom: 4 } },
                !readonly
                  ? h('span', { style: { color: T.caption } }, '权限模式')
                  : h('span', { style: { color: T.caption } }, '只读会话'),
                !readonly
                  ? h(MiniSelect, {
                      value: snap?.mode ?? 'auto',
                      options:
                        snap?.mode && !MODE_OPTIONS.some((option) => option.value === snap.mode)
                          ? [{ value: snap.mode, label: `${snap.mode}（实际生效）` }, ...MODE_OPTIONS]
                          : MODE_OPTIONS,
                      onChange: (value) => setOption({ mode: value }),
                      title: '权限模式（与终端 /permissions 等价）',
                      disabled: busy,
                    })
                  : null,
                !readonly ? h('span', { style: { color: T.caption } }, 'effort') : null,
                !readonly
                  ? h(MiniSelect, {
                      value: snap?.effort ?? 'xhigh',
                      options: EFFORT_OPTIONS,
                      onChange: (value) => setOption({ effort: value }),
                      title: 'DeepSeek 下 xhigh 会降为 high；要顶格选 max',
                      disabled: busy,
                    })
                  : null,
                h(
                  GhostButton,
                  { onClick: toggleThinking, title: '读取/显示转录里的 thinking 块' },
                  thinking
                    ? `思考：开（${items.filter((item) => item.kind === 'thinking').length}）`
                    : '思考：关',
                ),
              ),
              readonly
                ? h(
                    'div',
                    { style: { gridColumn: '1 / -1', fontSize: 10.5, color: T.caption } },
                    '该会话由终端持有：模式与 effort 以终端为准；这里只读转录。',
                  )
                : null,
              h(
                'div',
                { style: { gridColumn: '1 / -1', fontSize: 10.5, color: T.caption } },
                '思考开关只影响「是否显示」；模型是否思考由 effort 和模型决定。effort xhigh 在 DeepSeek 上会降为 high，要顶格选 max。',
              ),
              thinking && items.filter((item) => item.kind === 'thinking').length === 0
                ? h(
                    'div',
                    { style: { gridColumn: '1 / -1', fontSize: 10.5, color: T.caption } },
                    '本会话没有可显示的思考内容（DeepSeek 多数思考块为空）。',
                  )
                : null,
              ...(readonly
                ? []
                : [
                ['模型', snap?.settings?.model ?? snap?.model ?? '—'],
                ['cc 版本', snap?.settings?.ccVersion ?? snap?.ccVersion ?? '—'],
                ['权限模式（CLI 生效）', snap?.mode ?? snap?.settings?.permissionMode ?? '—'],
                ['effort', snap?.effort ?? (snap?.settings ? '跟随设置' : '—')],
                ['工具', snap?.settings ? `${snap.settings.tools} 个` : '—'],
                ['skills', snap?.settings ? `${snap.settings.skills.length} 个` : '—'],
                ['命令', snap?.settings ? `${snap.settings.commands.length} 个` : '—'],
                [
                  'MCP',
                  snap?.settings?.mcpServers?.length
                    ? snap.settings.mcpServers.map((server) => `${server.name}:${server.status}`).join(' · ')
                    : '无',
                ],
                [
                  '插件',
                  snap?.settings?.plugins?.length
                    ? snap.settings.plugins
                        .map((plugin) => `${plugin.name}${plugin.version ? `@${plugin.version}` : ''}`)
                        .join(' · ')
                    : '无',
                ],
                ['hooks 已执行', snap?.hookEvents ? `${snap.hookEvents} 次` : '—'],
                ['设置来源', 'user / project / local（与终端一致）'],
                ['工作目录', snap?.cwd || cwd || '—'],
                ...(snap?.settings ? [] : [['说明', '会话未启动：发送一条消息后这里显示 CLI 实际加载的设置']]),
              ]).flatMap(([label, value]) => [
                h('span', { key: label, style: { color: T.caption } }, label),
                h('span', { key: `${label}-v`, style: { wordBreak: 'break-all' } }, value),
              ]),
            )
          : null,
        showPreviewPicker
          ? h(
              'div',
              {
                style: {
                  padding: '6px 16px',
                  borderBottom: `${HAIRLINE} solid ${T.line}`,
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                },
              },
              h('input', {
                value: previewPathInput,
                onChange: (event) => setPreviewPathInput(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') openPreviewPath()
                },
                placeholder: '绝对路径，例如 /Users/you/Projects/x/README.md',
                style: {
                  flex: '1 1 auto',
                  minWidth: 200,
                  padding: '4px 8px',
                  fontFamily: MONO,
                  fontSize: 11,
                  color: T.text,
                  background: T.layer1,
                  border: `${HAIRLINE} solid ${T.line}`,
                  outline: 'none',
                },
              }),
              h(GhostButton, { onClick: openPreviewPath }, '打开预览'),
            )
          : null,
        h(
          'div',
          {
            style: {
              padding: '6px 16px',
              borderBottom: `${HAIRLINE} solid ${T.line}`,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 11,
              color: T.caption,
              flexWrap: 'wrap',
            },
          },
          h('span', { style: { fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' } }, cwd || (snap?.cwd ?? '未指定工作目录')),
          draft
            ? h(GhostButton, { onClick: pickDir }, '选择目录')
            : null,
          draft
            ? h('input', {
                value: cwd,
                onChange: (event) => setCwd(event.target.value),
                placeholder: '/Users/…',
                style: {
                  flex: '1 1 200px',
                  minWidth: 160,
                  boxSizing: 'border-box',
                  padding: '3px 8px',
                  fontSize: 11,
                  fontFamily: MONO,
                  color: T.text,
                  background: T.layer1,
                  border: `${HAIRLINE} solid ${T.line}`,
                  outline: 'none',
                },
              })
            : null,
        ),
        notice
          ? h('div', { style: { padding: '6px 16px', fontSize: 11, color: T.ok, borderBottom: `${HAIRLINE} solid ${T.line}` } }, notice)
          : null,
        error
          ? h('div', { style: { padding: '6px 16px', fontSize: 11, color: T.err, borderBottom: `${HAIRLINE} solid ${T.line}` } }, error)
          : null,
        h(
          'div',
          { style: { flex: '1 1 auto', minHeight: 0, display: 'flex' } },
          h(
            'div',
            { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column' } },
            h(
              'div',
              {
                ref: listRef,
                onScroll,
                style: {
                  flex: '1 1 auto',
                  minHeight: 0,
                  overflowY: 'auto',
                  padding: '16px 20px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 14,
                },
              },
              boundary > 0
                ? h(
                    'div',
                    { style: { textAlign: 'center', paddingBottom: 4 } },
                    h(
                      GhostButton,
                      { onClick: loadOlder, disabled: loadingOlder },
                      loadingOlder ? '加载中…' : `加载更早（还有 ${boundary} 条）`,
                    ),
                  )
                : null,
              boundary === 0 && snap?.itemsTotal > items.length
                ? h(
                    'div',
                    { style: { fontSize: 10.5, color: T.caption, textAlign: 'center', paddingBottom: 2 } },
                    `仅显示最近 ${items.length} 条，共 ${snap.itemsTotal} 条`,
                  )
                : null,
              items.length === 0 && !partial
                ? h(
                    'div',
                    { style: { padding: '40px 0', textAlign: 'center', color: T.caption, fontSize: FS2 } },
                    draft ? '新会话：选好工作目录，直接输入第一句话' : '这个会话还没有可显示的内容',
                  )
                : h(MessageList, { items, partial, cwd: snap?.cwd || cwd, onOpenPath: setPreview, sid }),
            ),
            pending.length > 0
              ? pending.map((entry) =>
                  entry.kind === 'question'
                    ? h(QuestionCard, { key: entry.requestId, pending: entry, busy, onDecide: decide })
                    : h(PermissionCard, { key: entry.requestId, pending: entry, busy, onDecide: decide }),
                )
              : null,
            h(
              'div',
              {
                style: {
                  borderTop: `1px solid ${T.line}`,
                  padding: '12px 16px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  background: T.base,
                },
              },
              showCommandList
                ? h(
                    'div',
                    {
                      style: {
                        border: `${HAIRLINE} solid ${T.line}`,
                        background: T.base,
                        maxHeight: 200,
                        overflowY: 'auto',
                        display: 'flex',
                        flexDirection: 'column',
                      },
                    },
                    commandList.length === 0
                      ? h('div', { style: { padding: '6px 10px', fontSize: 11, color: T.caption } }, '没有匹配的命令')
                      : commandList.map((name) =>
                          h(
                            'button',
                            {
                              key: name,
                              type: 'button',
                              onClick: () => insertCommand(name),
                              onMouseEnter: (event) => {
                                event.currentTarget.style.background = T.hover
                              },
                              onMouseLeave: (event) => {
                                event.currentTarget.style.background = 'transparent'
                              },
                              style: {
                                appearance: 'none',
                                border: 'none',
                                borderBottom: `${HAIRLINE} solid ${T.line}`,
                                background: 'transparent',
                                color: T.sub,
                                fontFamily: MONO,
                                fontSize: 11,
                                textAlign: 'left',
                                padding: '5px 10px',
                                cursor: 'pointer',
                              },
                            },
                            `/${name}`,
                          ),
                        ),
                  )
                : null,
              readonly
                ? h('div', { style: { fontSize: FS2, color: T.warn } }, '该会话正在终端运行：面板只读。点上方「fork 到面板」继续。')
                : h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                    images.length > 0
                      ? h(
                          'div',
                          { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                          images.map((image) =>
                            h(
                              'div',
                              { key: image.id, style: { position: 'relative', display: 'inline-flex' } },
                              h('img', {
                                src: `data:${image.media_type};base64,${image.data}`,
                                alt: image.name,
                                style: { height: 56, borderRadius: 8, border: `1px solid ${T.line}`, objectFit: 'cover', boxShadow: SHADOW.card },
                              }),
                              h(
                                'button',
                                {
                                  type: 'button',
                                  onClick: () => setImages((prev) => prev.filter((item) => item.id !== image.id)),
                                  title: '移除',
                                  style: {
                                    position: 'absolute',
                                    top: -6,
                                    right: -6,
                                    width: 16,
                                    height: 16,
                                    lineHeight: '14px',
                                    padding: 0,
                                    border: `${HAIRLINE} solid ${T.lineStrong}`,
                                    background: T.base,
                                    color: T.sub,
                                    cursor: 'pointer',
                                    fontSize: 11,
                                  },
                                },
                                '×',
                              ),
                            ),
                          ),
                        )
                      : null,
                    h(
                    'div',
                    { style: { display: 'flex', gap: 8, alignItems: 'flex-end' } },
                    h('textarea', {
                      value: text,
                      onChange: (event) => setText(event.target.value),
                      onPaste: (event) => {
                        const files = [...(event.clipboardData?.items ?? [])]
                          .map((item) => (item.kind === 'file' ? item.getAsFile() : null))
                          .filter(Boolean)
                        if (files.length > 0) {
                          event.preventDefault()
                          addFiles(files)
                        }
                      },
                      onKeyDown: (event) => {
                        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
                          event.preventDefault()
                          send()
                        }
                      },
                      rows: 3,
                      placeholder: '给 CC 发消息…（Enter 发送，Shift+Enter 换行）',
                      className: 'ccs-focus',
                      style: {
                        flex: '1 1 auto',
                        resize: 'vertical',
                        minHeight: 66,
                        maxHeight: 220,
                        padding: '10px 12px',
                        boxSizing: 'border-box',
                        fontFamily: FONT,
                        fontSize: FS,
                        lineHeight: 1.6,
                        color: T.text,
                        background: T.layer1,
                        border: `1px solid ${T.line}`,
                        borderRadius: R.card,
                        outline: 'none',
                        boxShadow: SHADOW.card,
                        transition: TRANS,
                      },
                    }),
                    h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                      h(PrimaryButton, { onClick: send, disabled: busy || (!text.trim() && images.length === 0) }, busy ? '…' : '发送'),
                      h(GhostButton, { onClick: () => fileRef.current?.click() }, '图片'),
                      h('input', {
                        ref: fileRef,
                        type: 'file',
                        accept: 'image/*',
                        multiple: true,
                        style: { display: 'none' },
                        onChange: (event) => {
                          addFiles(event.target.files ?? [])
                          event.target.value = ''
                        },
                      }),
                      h(GhostButton, { onClick: () => setShowCommands((value) => !value) }, '命令'),
                      h(GhostButton, { onClick: () => setText('') , disabled: !text }, '清空'),
                    ),
                    ),
                  ),
              h(
                'div',
                { style: { fontSize: 10.5, color: T.faint } },
                snap?.result?.turns ? `本轮 ${snap.result.turns} 轮 · ${Math.round((snap.result.durationMs ?? 0) / 100) / 10}s` : '',
              ),
            ),
          ),
          preview
            ? h(PreviewPane, { path: preview, onClose: () => setPreview(null), onOpenPath: setPreview })
            : subPane
              ? h(SubagentPane, {
                  sessionId: sid,
                  list: subagents,
                  selected: subSelected,
                  onSelect: setSubSelected,
                  onClose: () => {
                    setSubPane(false)
                    setSubSelected(null)
                  },
                  cwd: snap?.cwd || cwd,
                  onOpenPath: setPreview,
                })
              : null,
        ),
      )
    }

    /* ── panel ───────────────────────────────────────────────────────── */

    function SessionsPanel() {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [loading, setLoading] = React.useState(false)
      const [query, setQuery] = React.useState('')
      const [filter, setFilter] = React.useState('all')
      const [notice, setNotice] = React.useState(null)
      const [selected, setSelected] = React.useState([])
      const [tick, setTick] = React.useState(0)
      const [chat, setChat] = React.useState(null)
      const [subView, setSubView] = React.useState(null)
      const [chatEnabled, setChatEnabled] = React.useState(true)
      const [limit, setLimit] = React.useState(200)

      const load = React.useCallback(() => {
        setLoading(true)
        setError('')
        fetch(`${ENDPOINT}?limit=${limit}`, { headers: { accept: 'application/json' } })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            return response.json()
          })
          .then((payload) => {
            if (payload && payload.error) throw new Error(payload.error)
            setData(payload)
          })
          .catch((cause) => setError(String(cause?.message ?? cause)))
          .finally(() => setLoading(false))
      }, [limit])

      React.useEffect(() => {
        load()
      }, [load])

      // Chat is a host-side opt-out; the UI follows whatever the host reports.
      React.useEffect(() => {
        getJson('/_ccpanel/diag')
          .then((payload) => setChatEnabled(payload?.chat !== false))
          .catch(() => {})
      }, [])

      // OPENED 对账：真实源是 sidebarRight.openTabs，不是"我记得我开过"。
      React.useEffect(() => {
        const sync = () => {
          if (reconcileOpened()) setTick((value) => value + 1)
        }
        sync()
        let unsubscribe = null
        try {
          const store = svc('sidebarRight')?.openTabs
          if (store && typeof store.subscribe === 'function') unsubscribe = store.subscribe(sync)
        } catch {
          unsubscribe = null
        }
        const timer = unsubscribe ? null : setInterval(sync, 5000)
        return () => {
          if (timer) clearInterval(timer)
          if (typeof unsubscribe === 'function') {
            try {
              unsubscribe()
            } catch {
              /* listener already gone */
            }
          }
        }
      }, [])

      const onTakeOver = React.useCallback((row, fork) => {
        setNotice({ text: fork ? '正在打开 fork 终端…' : '正在打开终端…', tone: T.sub })
        return takeOver(row, fork).then((result) => {
          setNotice({ text: result.message, tone: result.ok ? T.ok : T.err })
          if (result.ok && result.record) {
            OPENED.set(row.id, { ...result.record, sessionId: row.id })
            setTick((value) => value + 1)
          }
        })
      }, [])

      const all = (data && data.sessions) || []
      // 2026-11-08：MAX_RECORDED=40 只截断列表，真实转录数在 counts.recordedTotal。
      const recordedTotal = data?.counts?.recordedTotal ?? null
      const liveRows = all.filter((row) => row.live)
      const archived = all.filter((row) => !row.live)

      const rows = React.useMemo(() => {
        const base = filter === 'live' ? liveRows : filter === 'archived' ? archived : all
        const needle = query.trim().toLowerCase()
        if (!needle) return base
        return base.filter((row) =>
          [row.name, row.id, row.cwd, row.title, row.firstPrompt, row.preview, row.status, row.kind]
            .filter(Boolean)
            .some((field) => String(field).toLowerCase().includes(needle)),
        )
      }, [all, filter, query])

      const [mergeState, setMergeState] = React.useState({ status: 'idle' })

      const runMerge = React.useCallback((rows) => {
        const ids = rows.map((row) => row.id).join(',')
        setMergeState({ status: 'running', count: rows.length })
        fetch(`${ENDPOINT.replace('/sessions', '')}/merge?ids=${encodeURIComponent(ids)}`)
          .then((response) =>
            response.json().then((payload) => {
              if (!response.ok || payload?.error) throw new Error(payload?.error || `HTTP ${response.status}`)
              return payload
            }),
          )
          .then((payload) => setMergeState({ status: 'ready', payload }))
          .catch((error) => setMergeState({ status: 'error', message: String(error?.message ?? error) }))
      }, [])

      const selectedRows = React.useMemo(
        () => all.filter((row) => selected.includes(row.id)),
        [all, selected],
      )
      const toggleSelect = (id) =>
        setSelected((list) => (list.includes(id) ? list.filter((item) => item !== id) : [...list, id]))
      const clearSelect = () => setSelected([])

      const releaseSession = React.useCallback(
        async (row) => {
          try {
            await postJson(`${CHAT}/dispose`, { id: row.id })
            setNotice({ text: '已结束面板会话进程；记录保留', tone: T.ok })
            load()
          } catch (cause) {
            setNotice({ text: String(cause?.message ?? cause), tone: T.err })
          }
        },
        [load],
      )

      const openChat = React.useCallback((row) => {
        setChat({
          id: row.id,
          cwd: row.cwd || '',
          title: row.title || row.firstPrompt || row.preview || '',
          live: row.live === true,
        })
      }, [])

      const openSubagents = React.useCallback((row) => {
        getJson(`${CHAT}/subagents?session=${encodeURIComponent(row.id)}`)
          .then((payload) => {
            setSubView({
              sessionId: row.id,
              cwd: row.cwd || '',
              list: Array.isArray(payload?.subagents) ? payload.subagents : [],
            })
          })
          .catch((cause) =>
            setNotice({ text: `读取子代理失败：${String(cause?.message ?? cause)}`, tone: T.err }),
          )
      }, [])

      const openDraft = React.useCallback(async () => {
        try {
          const picked = await postJson('/_ccpanel/pick-dir', {})
          if (picked?.path) {
            setChat({ id: crypto.randomUUID(), cwd: picked.path, title: '', draft: true })
          } else {
            setNotice({ text: '已取消目录选择', tone: T.caption })
          }
        } catch (cause) {
          setChat({ id: crypto.randomUUID(), cwd: '', title: '', draft: true })
          setNotice({
            text: `目录选择器不可用：${String(cause?.message ?? cause)}。可在对话页手动填路径。`,
            tone: T.err,
          })
        }
      }, [])

      if (chat) {
        return h(ChatView, { key: chat.id, target: chat, onBack: () => setChat(null) })
      }

      return h(
        'div',
        {
          style: {
            height: '100%',
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            color: T.text,
            fontSize: FS,
            fontFamily: FONT,
            background: T.base,
          },
        },
        h(PanelStyle, null),
        h(
          'div',
          {
            style: {
              padding: '18px 18px 14px',
              borderBottom: `1px solid ${T.line}`,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'flex-start', gap: 12 } },
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              h('span', { style: { fontSize: 17, fontWeight: 650, letterSpacing: '-0.02em' } }, 'CC sessions'),
              h(
                'span',
                { style: { fontSize: 11, color: T.caption } },
                data ? `数据源 ${data.liveSource} · 更新于 ${new Date(data.generatedAt).toLocaleTimeString()}` : '正在读取…',
              ),
            ),
            h('span', { style: { flex: '1 1 auto' } }),
            chatEnabled ? h(GhostButton, { onClick: openDraft }, '＋ 新会话') : null,
            recordedTotal && recordedTotal > all.length
              ? h(GhostButton, { onClick: () => setLimit((value) => value + 200), disabled: loading }, '加载更多')
              : null,
            h(GhostButton, { onClick: load, disabled: loading }, loading ? '刷新中…' : '刷新'),
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'flex-end', gap: 24 } },
            h(Stat, { label: '在线', value: liveRows.length, tone: liveRows.length ? T.ok : T.text }),
            h(Stat, { label: '可接管', value: all.filter((row) => row.path).length }),
            h(Stat, { label: '归档', value: recordedTotal ?? archived.length }),
            h(Stat, { label: '本页打开', value: OPENED.size }),
            recordedTotal
              ? h(
                  'span',
                  { style: { fontSize: 10.5, color: T.caption, alignSelf: 'flex-end', paddingBottom: 2 } },
                  recordedTotal > all.length
                    ? `已载 ${all.length} / 共 ${recordedTotal} 个转录`
                    : `共 ${recordedTotal} 个转录`,
                )
              : null,
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
            h(Segmented, {
              value: filter,
              onChange: setFilter,
              options: [
                { key: 'all', label: '全部', count: all.length },
                { key: 'live', label: '在线', count: liveRows.length },
                { key: 'archived', label: '历史', count: archived.length },
              ],
            }),
            h('input', {
              value: query,
              onChange: (event) => setQuery(event.target.value),
              placeholder: '搜索会话 / 路径 / 内容',
              style: {
                flex: '1 1 180px',
                minWidth: 140,
                boxSizing: 'border-box',
                padding: '4px 10px',
                fontSize: FS2,
                lineHeight: '20px',
                color: T.text,
                background: T.layer1,
                border: `${HAIRLINE} solid ${T.line}`,
                borderRadius: 8,
                outline: 'none',
                fontFamily: 'inherit',
              },
            }),
          ),
        ),
        selectedRows.length > 0
          ? h(
              'div',
              {
                style: {
                  margin: '12px 16px 0',
                  padding: '8px 12px',
                  borderRadius: R.card,
                  border: `${HAIRLINE} solid ${T.accent}`,
                  background: T.card,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  flexWrap: 'wrap',
                },
              },
              h(
                'span',
                { style: { fontSize: FS2, color: T.text, fontWeight: 500 } },
                `已选 ${selectedRows.length} 个会话`,
              ),
              h('span', { style: { flex: '1 1 auto' } }),
              h(
                PrimaryButton,
                {
                  onClick: () => {
                    if (selectedRows.length > 6) return
                    setNotice({ text: '正在建队…', tone: T.sub })
                    startTeamConversation(selectedRows).then((result) => {
                      setNotice({ text: result.message, tone: result.ok ? T.ok : T.err })
                    })
                  },
                  disabled: selectedRows.length > 6,
                  title: selectedRows.length > 6 ? '一次最多 6 个会话' : '开一条新对话，把这几份上下文交给 dsh 主 agent',
                },
                '建队开新对话',
              ),
              h(
                GhostButton,
                { onClick: () => runMerge(selectedRows), disabled: mergeState.status === 'running' },
                mergeState.status === 'running' ? '合并中…' : '只看合并摘要',
              ),
              h(GhostButton, { onClick: clearSelect }, '清空'),
            )
          : null,
        mergeState.status === 'running'
          ? h(
              'div',
              { style: { margin: '12px 16px 0', fontSize: 11.5, color: T.caption } },
              `正在合并 ${mergeState.count} 个会话的上下文…`,
            )
          : null,
        mergeState.status === 'error'
          ? h(
              'div',
              { style: { margin: '12px 16px 0', fontSize: 11.5, color: T.err } },
              `合并失败：${mergeState.message}`,
            )
          : null,
        mergeState.status === 'ready'
          ? h(
              'div',
              {
                style: {
                  margin: '12px 16px 0',
                  border: `${HAIRLINE} solid ${T.cardStroke}`,
                  borderRadius: R.card,
                  background: T.card,
                  padding: '10px 12px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  maxHeight: 240,
                  overflowY: 'auto',
                },
              },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                h(
                  'span',
                  { style: { fontSize: FS2, fontWeight: 600, color: T.text } },
                  `合并摘要 · ${mergeState.payload.parts.length} 个会话 · ${mergeState.payload.text.length} 字`,
                ),
                h('span', { style: { flex: '1 1 auto' } }),
                h(CopyButton, { label: '复制全部', value: mergeState.payload.text }),
                h(GhostButton, { onClick: () => setMergeState({ status: 'idle' }) }, '收起'),
              ),
              h(
                'pre',
                {
                  style: {
                    margin: 0,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontFamily: FONT,
                    fontSize: FS2,
                    color: T.sub,
                    lineHeight: 1.6,
                  },
                },
                mergeState.payload.text,
              ),
            )
          : null,
        notice
          ? h(
              'div',
              {
                style: {
                  padding: '7px 16px',
                  fontSize: 11.5,
                  color: notice.tone,
                  borderBottom: `${HAIRLINE} solid ${T.line}`,
                  background: T.layer1,
                },
              },
              notice.text,
            )
          : null,
        h(ManagedBand, { onChange: () => setTick((value) => value + 1) }),
        error
          ? h(
              'div',
              {
                style: {
                  margin: '12px 16px 0',
                  padding: '8px 12px',
                  borderRadius: 8,
                  border: `${HAIRLINE} solid ${T.err}`,
                  fontSize: FS2,
                  color: T.err,
                },
              },
              `读取失败：${error}`,
            )
          : null,
        h(
          'div',
          {
            style: {
              display: 'grid',
              gridTemplateColumns: GRID,
              gap: 10,
              padding: '8px 16px 8px 12px',
              marginTop: 10,
              borderBottom: `1px solid ${T.line}`,
              background: T.base,
              fontSize: 10,
              letterSpacing: '0.09em',
              textTransform: 'uppercase',
              color: T.caption,
            },
          },
          h('span', null, ''),
          h('span', null, '状态'),
          h('span', null, '会话'),
          h('span', null, '工作目录'),
          h('span', { style: { textAlign: 'right' } }, '最后活动'),
          h('span', { style: { textAlign: 'right' } }, '操作'),
        ),
        h(
          'div',
          { style: { flex: '1 1 auto', overflowY: 'auto', overflowX: 'hidden' } },
          loading && !data
            ? h(SkeletonRows, null)
            : rows.length === 0
            ? h(
                'div',
                {
                  style: {
                    padding: '48px 16px',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 6,
                    color: T.caption,
                  },
                },
                h('span', { style: { fontSize: FS2 } }, '没有匹配的会话'),
                h('span', { style: { fontSize: 11 } }, '换个筛选条件，或清空搜索词'),
              )
            : rows.map((row) =>
                h(Row, {
                  key: row.id,
                  row,
                  selected: selected.includes(row.id),
                  onToggleSelect: toggleSelect,
                  onTakeOver,
                  onRelease: releaseSession,
                  onOpen: chatEnabled ? openChat : undefined,
                  onSubagents: chatEnabled ? openSubagents : undefined,
                }),
              ),
        ),
        subView
          ? h(SubagentDrawer, {
              key: subView.sessionId,
              view: subView,
              onClose: () => setSubView(null),
            })
          : null,
      )
    }

    function PanelIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': true, style: { display: 'block' },
        },
        h('rect', { x: 2.5, y: 3.5, width: 19, height: 17, rx: 0 }),
        h('path', { d: 'M2.5 8.5h19' }),
        h('path', { d: 'M6 12.5h6M6 16.5h9' }),
        h('path', { d: 'M16.5 12.5l2 2-2 2' }),
      )
    }

    return {
      inject: ['slots'],
      __test: { SessionsPanel, Row, ChatView, MessageList, QuestionCard, ToolCard, SubagentDrawer },
      apply(ctx) {
        ROOT = ctx
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, SessionsPanel))
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => 'CC Sessions Hub' }, PanelIcon),
        )
      },
    }
  },
})
