// Client half of the RustXNG Web search plugin: the switch chip in the chat box.
//
// The composer tool row seat `conversation.input.left` is additive and currently
// empty, so this package registers one occupant there: a `role="switch"` control
// labelled "Web search". State lives entirely in the Host half. The chip reads and
// writes it through this package's own route — requested document-relative, exactly
// as the shipped HMR client requests its event stream — so no Host state is ever
// guessed at in the browser. A failed probe means the Host half is not running (the
// row is disabled, or it has no Web server), so the chip removes itself rather than
// showing a switch that would not work.
//
// Styles carry theme tokens only; visible text is routed through the Client locale
// service. No DOM from another plugin is read to estimate placement.

window.__ModuleLoader__.load({
  id: '@local/rustxng-web-search',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const STATE_ROUTE = 'rustxng-web-search/state'
    const SET_ROUTE = 'rustxng-web-search/set'

    /**
     * Request one of this package's routes.
     * @param route - document-relative route.
     * @param body - request body, omitted for a read.
     * @returns the parsed JSON answer.
     */
    function request(route, body) {
      const transport = globalThis.__DSH_TRANSPORT__
      const fetchImpl = transport?.fetch ?? globalThis.fetch
      if (typeof fetchImpl !== 'function') return Promise.reject(new Error('no Web transport on this page'))
      const init = body === undefined
        ? { method: 'GET', cache: 'no-store' }
        : {
            method: 'POST',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
      return Promise.resolve(fetchImpl(route, init)).then((res) => {
        if (!res || !res.ok) throw new Error(`${route} answered ${res?.status ?? 'no response'}`)
        return res.json()
      })
    }

    /**
     * The shared control chrome: an inherited font, no UA appearance, theme tokens.
     */
    const chrome = {
      appearance: 'none',
      font: 'inherit',
      fontSize: 11,
      lineHeight: 1.4,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '2px 6px',
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'color-mix(in srgb, var(--dsw-alias-bg-base) 55%, transparent)',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }

    /**
     * The magnifier glyph, drawn in the inherited label colour.
     * @param size - pixel size.
     * @returns the inline SVG element.
     */
    function SearchIcon(size) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        'aria-hidden': true,
        style: { flex: 'none', display: 'block' },
      },
        h('circle', { cx: 10.5, cy: 10.5, r: 6.5 }),
        h('path', { d: 'M15.4 15.4 L21 21' }))
    }

    /**
     * Describe the engine half in one short line for the tooltip, from the `engine`
     * block the Host already returns on the state route. Nothing is guessed here.
     * @param engine - the engine block, or undefined when the Host gave none.
     * @returns the status line, or an empty string when there is nothing to report.
     */
    function engineLine(engine) {
      if (!engine) return ''
      if (!engine.present) {
        if (engine.autoDownload) {
          return `engine ${engine.pinned || engine.latestSeen || 'release'} not downloaded yet: the first search fetches it`
        }
        return 'no engine binary: set binaryPath, or enable autoDownload'
      }
      const parts = [`engine ${engine.version || 'unknown'}`]
      parts.push(engine.running ? 'running' : 'starts on first search')
      if (engine.latestSeen && engine.version && engine.latestSeen !== engine.version) {
        parts.push(`newer ${engine.latestSeen} pending`)
      }
      if (engine.error) parts.push(String(engine.error).slice(0, 90))
      return parts.join(', ')
    }

    /**
     * The Web search switch.
     * @param props - slot props (`sessionId`) plus the registration's `inject`.
     * @returns the entry element, or null when the Host half is unreachable.
     */
    function WebSearchSwitch(props) {
      const { sessionId, t, request: call } = props
      const [enabled, setEnabled] = React.useState(true)
      const [reachable, setReachable] = React.useState(true)
      const [defaultEnabled, setDefaultEnabled] = React.useState(true)
      const [engineText, setEngineText] = React.useState('')

      // A read every few seconds: it adopts Host state changed elsewhere (a resumed
      // session resets to the default) and doubles as the availability probe.
      React.useEffect(() => {
        let alive = true
        const probe = () => {
          call(`${STATE_ROUTE}?session=${encodeURIComponent(sessionId)}`).then((info) => {
            if (!alive) return
            setReachable(true)
            setEnabled(info?.enabled !== false)
            setEngineText(engineLine(info?.engine))
            if (typeof info?.defaultEnabled === 'boolean') setDefaultEnabled(info.defaultEnabled)
          }, () => {
            if (!alive) return
            setReachable(false)
          })
        }
        probe()
        const timer = setInterval(probe, 3000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [call, sessionId])

      /**
       * Hand the Host the state this session should move to and adopt what it reports.
       */
      const toggle = () => {
        call(SET_ROUTE, { sessionId, enabled: !enabled }).then((info) => {
          if (typeof info?.enabled === 'boolean') setEnabled(info.enabled)
        }, () => {})
      }

      if (!sessionId || !reachable) return null

      const off = !enabled
      const colour = off ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-primary)'

      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': enabled,
        'aria-label': off ? t('offLabel') : t('title'),
        title: [off ? t('tipOff') : t('tipOn'), engineText].filter(Boolean).join(' | '),
        style: {
          ...chrome,
          color: colour,
          textDecoration: off ? 'line-through' : 'none',
          opacity: off ? 0.72 : 1,
        },
        onClick: toggle,
      },
        SearchIcon(13),
        h('span', { style: { font: 'inherit', fontSize: 11, letterSpacing: '0.01em' } },
          off ? t('offLabel') : t('title')))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const dicts = {
          en: {
            title: 'Web search',
            offLabel: 'Web search off',
            tipOn: 'Web search is on for this session: the model can look things up with no API key. Click to turn it off.',
            tipOff: 'Web search is off for this session, so the model has no Web tools here. Click to turn it on.',
          },
        }

        return ctx.effect(() => {
          const disposers = [ctx.locale.register('rustxng-web-search', 'en', dicts.en)]
          const translate = ctx.locale.bind('rustxng-web-search')

          /**
           * Translate one key, falling back to the English dictionary so the control
           * never prints a raw key.
           * @param key - dictionary key.
           * @returns the text to show.
           */
          const t = (key) => {
            const value = translate(key)
            return typeof value === 'string' && value !== key ? value : (dicts.en[key] ?? key)
          }
          const injected = () => ({ t, request })

          disposers.push(ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
            name: 'conversation.input.left',
            id: 'rustxng-web-search',
            order: 5,
            label: () => t('title'),
            inject: injected,
          }, WebSearchSwitch)))

          return () => {
            for (const dispose of disposers) dispose()
          }
        }, 'rustxng-web-search: locale and Web search switch')
      },
    }
  },
})
