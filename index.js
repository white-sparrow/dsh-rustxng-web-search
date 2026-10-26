// DSH plugin: key-free web search backed by a locally spawned RustXNG metasearch server.
//
// Two halves, one package:
//
// Host (this file) — registers a WebSearchProvider (id "rustxng") on ctx.web. The bundle
// patch pins web.searchProvider = "rustxng" and enables the dsh-tool-web row, so the
// built-in web_search / web_fetch tools route here with no API key and no configuration.
// It also owns the per-session Web search switch: state lives here and is enforced with
// `agent.ctx.tools.restrict()`, and it answers this package's own Web route so the page
// can read and change that state.
//
// Client (`client.js`) — the "Web search" switch chip in the composer tool row
// (`conversation.input.left`). It reads and writes the Host state through the same
// package-private route, exactly as the `power-after-task` plugin's control does.
//
// RustXNG is the bundled Rust rewrite of SearXNG: a self-contained HTTP server,
// AGPL-3.0-or-later. It is NOT shipped inside this package. `engine.mjs` fetches the
// release asset for this platform and verifies its sha256; the package's `postinstall`
// runs it, and this plugin runs it too on first search, so an install whose scripts
// were skipped (or that had no network at install time) still works. The same helper
// drives the auto-update check.
// We spawn the binary lazily on the first search, keep it alive for the plugin's
// lifetime (one server reused across searches), and query GET /search?...&format=json.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

import {
  REPO as ENGINE_REPO,
  PINNED_VERSION as ENGINE_PIN,
  defaultDest,
  assetSuffixes,
  installedVersion,
  readMetadata,
  checkForUpdate,
  installEngine,
} from './engine.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// Where the engine belongs inside this package: `bin/rustxng.exe` on Windows,
// `bin/rustxng` elsewhere. A fresh checkout has no such file until something
// downloads it, which is why `available()` below also treats "downloadable" as ready.
const DEFAULT_BINARY = defaultDest(HERE)

// Tunables surfaced through the plugin's Config. The Loader validates the row's
// `config` at activation through the Standard Schema interface (`Config['~standard'].validate`),
// so a raw JSON Schema object crashes activation, and `@deepseek-ai/schemastery`
// cannot be imported from a locally linked bundle (Node resolves imports from the
// checkout, not from the profile's node_modules). Hence a hand-rolled Standard Schema.
const CONFIG_DEFAULTS = {
  binaryPath: DEFAULT_BINARY,
  bindAddress: '127.0.0.1',
  port: 8888,
  searchTimeoutMs: 30000,
  defaultEnabled: true,
  // Engine supply: which upstream release fills `binaryPath`, and how it stays current.
  engineRepo: ENGINE_REPO,
  engineVersion: ENGINE_PIN,
  autoDownload: true,
  autoUpdate: true,
  updateIntervalMs: 21_600_000, // 6 h between upstream release checks
  downloadTimeoutMs: 180_000,
  checkTimeoutMs: 15_000,
}

/** Inclusive bounds for the numeric knobs; the schema types them as numbers only. */
const CONFIG_RANGES = {
  port: [1, 65535],
  searchTimeoutMs: [1000, 300_000],
  updateIntervalMs: [60_000, 432_000_000], // 1 minute .. 5 days
  downloadTimeoutMs: [5_000, 3_600_000], // 5 s .. 1 h
  checkTimeoutMs: [1_000, 120_000], // 1 s .. 2 min
}

// RustXNG's CLI takes only `-c/--config`, `-b/--bind`, `-p/--port`, `-v`, `-h`,
// so the only knobs this plugin can set without writing a settings file are the
// bind address, the port, and our own per-call client-side timeout.

/**
 * Standard Schema validation for the row config: applies defaults, rejects unknown
 * fields, and range-checks numbers. Returns `{ value }` on success or `{ issues }`
 * on failure, per the Standard Schema contract.
 */
function validateConfig(input) {
  if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) {
    return { issues: [{ message: 'rustxng-web-search config must be an object' }] }
  }
  const source = input || {}
  const issues = []
  const unknown = Object.keys(source).filter((key) => !(key in CONFIG_DEFAULTS))
  if (unknown.length) {
    issues.push({ message: `unknown config field(s): ${unknown.join(', ')}; expected ${Object.keys(CONFIG_DEFAULTS).join(', ')}` })
  }
  const value = { ...CONFIG_DEFAULTS }
  for (const key of Object.keys(CONFIG_DEFAULTS)) {
    const raw = source[key]
    if (raw === undefined) continue
    if (typeof CONFIG_DEFAULTS[key] === 'boolean') {
      if (typeof raw !== 'boolean') {
        issues.push({ path: [key], message: `${key} must be true or false` })
        continue
      }
      value[key] = raw
    } else if (typeof CONFIG_DEFAULTS[key] === 'number') {
      if (typeof raw !== 'number' || !Number.isInteger(raw)) {
        issues.push({ path: [key], message: `${key} must be an integer` })
        continue
      }
      const bounds = CONFIG_RANGES[key] ?? [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]
      if (raw < bounds[0] || raw > bounds[1]) {
        issues.push({ path: [key], message: `${key} must be between ${bounds[0]} and ${bounds[1]}` })
        continue
      }
      value[key] = raw
    } else if (key === 'engineVersion' && raw === '') {
      // An empty pin means "follow the newest release", not "missing value".
      value[key] = ''
    } else if (typeof raw !== 'string' || raw.length === 0) {
      issues.push({ path: [key], message: `${key} must be a non-empty string` })
    } else {
      value[key] = raw
    }
  }
  return issues.length ? { issues } : { value }
}

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'rustxng-web-search',
    validate: validateConfig,
  },
}

// A plugin only sees the services it declares, so the Web server (the switch's
// route host) and the session controller (which sessions are live right now) are
// both part of the injection: without them the chip would have nothing to read.
export const inject = ['web', 'webServer', 'sessionController']

/**
 * One prefix route owns every endpoint of this package's Client half, mirroring
 * the shape `power-after-task` uses for its own control: the page requests it
 * document-relative through the shell transport, so the state stays Host-owned.
 */
const ROUTE = '/rustxng-web-search'
/** The model-facing tools the Web search switch takes in and out of a session. */
const GATED_TOOLS = ['web_search', 'web_fetch']
/** Body ceiling for the plugin route. */
const MAX_BODY_BYTES = 4 * 1024
/**
 * A reload may not ask upstream again within this window of the check recorded in
 * the engine's own metadata file; `updateIntervalMs` governs the checks after that.
 */
const ACTIVATION_CHECK_GRACE_MS = 600_000

/**
 * Parse a small JSON request body.
 * @param req - the incoming request.
 * @returns the parsed body object.
 */
async function readJsonBody(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += typeof chunk === 'string' ? chunk : String(chunk)
    if (raw.length > MAX_BODY_BYTES) throw new Error('request body exceeds 4 KiB')
  }
  if (!raw) return {}
  const parsed = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('request body must be a JSON object')
  return parsed
}

/**
 * Whether a host value names this machine. A rebinding attack reaches the route
 * under a foreign name, so the Host header is what separates the page from an
 * outside web page.
 * @param value - a `Host` or URL hostname, with or without a port.
 * @returns whether it is a loopback name.
 */
function isLoopbackHost(value) {
  const host = String(value ?? '').toLowerCase()
  if (!host) return false
  const closing = host.lastIndexOf(']')
  const bare = closing > 0 ? host.slice(1, closing) : host.split(':')[0]
  return bare === 'localhost' || bare === '127.0.0.1' || bare === '::1'
}

/**
 * Refuse a read request that proves it came from elsewhere.
 * @param req - the incoming request.
 * @returns whether the request may be served.
 */
function isSameOrigin(req) {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string') return site === 'same-origin' || site === 'none'
  const origin = req.headers['origin']
  if (typeof origin !== 'string') return true
  try {
    return isLoopbackHost(new URL(origin).hostname)
  } catch {
    return false
  }
}

/**
 * Whether a mutating request is trusted. A request is refused only when it proves
 * it is not the page: addressed to a non-loopback host, reported by the browser as
 * cross-site, or sent with a non-loopback `Origin`.
 * @param req - the incoming request.
 * @returns whether the switch change may be applied.
 */
function fromPage(req) {
  const host = req.headers.host
  if (typeof host === 'string' && !isLoopbackHost(host)) return false
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers['origin']
  if (typeof origin === 'string') {
    try {
      if (!isLoopbackHost(new URL(origin).hostname)) return false
    } catch {
      return false
    }
  }
  return true
}

export function apply(ctx, config) {
  const cfg = config || {}
  const binaryPath = cfg.binaryPath ?? DEFAULT_BINARY
  const bindAddress = cfg.bindAddress ?? '127.0.0.1'
  const port = cfg.port ?? 8888
  const searchTimeoutMs = cfg.searchTimeoutMs ?? 30000
  const defaultEnabled = cfg.defaultEnabled !== false
  // Engine supply: which upstream release fills `binaryPath`, and how it stays current.
  // `engineVersion: ''` (explicit) means follow the newest release instead of a pin.
  const engineRepo = cfg.engineRepo || ENGINE_REPO
  const engineVersion = cfg.engineVersion ?? ENGINE_PIN
  const autoDownload = cfg.autoDownload !== false
  const autoUpdate = cfg.autoUpdate !== false
  const updateIntervalMs = cfg.updateIntervalMs ?? 21_600_000
  const downloadTimeoutMs = cfg.downloadTimeoutMs ?? 180_000
  const checkTimeoutMs = cfg.checkTimeoutMs ?? 15_000
  const baseUrl = `http://${bindAddress}:${port}`

  const log = (message) => ctx.logger?.info?.(`rustxng-web-search: ${message}`)

  const webServer = ctx.get?.('webServer') ?? ctx.webServer

  let child = null
  let startPromise = null
  /** The last engine action taken (download, update, or failure), for the version route. */
  let engineNote = 'engine untouched since this plugin activated'
  let engineError = ''
  /** Only one download may write the binary at a time. */
  let engineBusy = false
  /** What the auto-update loop decided when the plugin activated, so the version route
   * shows whether the updater is running at all instead of leaving it to be guessed. */
  let updaterState = { scheduled: false, immediateCheck: false, reason: 'the updater has not run its activation pass yet' }
  /** Whether this instance of the plugin owns the `rustxng` Web provider slot. */
  let providerState = { registered: false, error: '' }

  /**
   * Per-session switch state, owned by the Host. A missing key means the default,
   * so a session that resumed, forked, or was never visited runs with Web search
   * on, and only an explicit click writes an override.
   * `sessionOverides` maps SessionId -> boolean; `liveAgents` maps each Agent this
   * plugin has seen to `{ key, raiseGate }`.
   */
  const sessionOverrides = new Map()
  const liveAgents = new Map()
  /** SessionId -> the single Agent handle adopted from `resolveAgent` for that session. */
  const adopted = new Map()

  /**
   * The session an Agent belongs to. Root Agents are addressed by their session
   * id (as the tool-facing `exec.agent.id` shows in sibling plugins); a scoped Agent
   * may name its owning session directly, and an unknown key simply keeps the default.
   * @param agent - the Agent object from an Agent lifecycle event.
   * @returns the session key, or '' when it cannot be resolved.
   */
  function sessionKeyOf(agent) {
    const candidate = agent?.sessionId ?? agent?.id
    if (typeof candidate !== 'string' || !candidate) return ''
    // A scoped Agent id that carries its session id (a subagent handle, for example)
    // belongs to that session's switch, so match it against the known overrides.
    if (sessionOverrides.has(candidate)) return candidate
    for (const sessionId of sessionOverrides.keys()) {
      if (sessionId !== candidate && candidate.includes(sessionId)) return sessionId
    }
    return candidate
  }

  /** Whether Web search is offered to one session right now. */
  function enabledFor(key) {
    const override = key ? sessionOverrides.get(key) : undefined
    return override === undefined ? defaultEnabled : override
  }

  /**
   * Pull the Agent out of an Agent lifecycle event, tolerating either call shape
   * (a payload object, or positional arguments).
   * @param args - the listener arguments.
   * @returns the Agent, or null.
   */
  function agentFrom(args) {
    for (const arg of args) {
      if (!arg || typeof arg !== 'object') continue
      if (arg.agent) return arg.agent
      if ('ctx' in arg || 'id' in arg) return arg
    }
    return null
  }

  /** Whether a lifecycle event reports a session rebuilt from an older log. */
  function isRebuiltSession(args) {
    for (const arg of args) {
      const value = typeof arg === 'string'
        ? arg
        : (arg && typeof arg === 'object' ? arg.source : undefined)
      if (typeof value === 'string' && /resume|fork|restore|replay|load/i.test(value)) return true
    }
    return false
  }

  /**
   * Align one Agent entry with its session's switch state. The gate is one scoped
   * effect per Agent, so raising it again is just calling that effect's disposer.
   * @param entry - `{ agent, key }` bookkeeping for one Agent, plus its last probe.
   */
  function syncEntry(entry) {
    const agent = entry?.agent
    if (!agent) return
    const off = !enabledFor(entry.key)
    if (!off && entry.raiseGate) {
      try {
        entry.raiseGate()
      } catch {
        /* already gone */
      }
      entry.raiseGate = undefined
      entry.probe = 'raised'
    } else if (off && !entry.raiseGate) {
      const tools = agent.ctx?.tools
      if (!tools?.restrict) {
        entry.probe = 'this Agent exposes no tools.restrict'
        return
      }
      // `restrict` rejects unknown names, so filter against the registry first. (The
      // registry is fine for *names*; it is not a read-out of the per-Agent mask —
      // `get` / `schemas` always report the global set, which this plugin measured.)
      const deny = GATED_TOOLS.filter((name) => {
        try {
          return Boolean(tools.get(name))
        } catch {
          return false
        }
      })
      if (!deny.length) {
        entry.probe = 'neither gated tool is registered in this profile'
        return
      }
      try {
        // Register the mask inside an Agent effect so it belongs to that Agent's context
        // and goes away with it; keep the disposer here too so a switch click can lift
        // the mask (an `agent.ctx` registration has two owners).
        entry.raiseGate = agent.ctx.effect(() => {
          const dispose = tools.restrict({ deny })
          entry.probe = `web search denied for this Agent (${deny.join(', ')})`
          return typeof dispose === 'function' ? dispose : () => {}
        }, 'rustxng-web-search: web search switch')
      } catch (error) {
        entry.probe = `restrict failed: ${error instanceof Error ? error.message : String(error)}`
        log(`could not gate tools for session ${entry.key}: ${entry.probe}`)
      }
    } else if (off) {
      entry.probe = 'denied already'
    }
  }

  function syncAll() {
    for (const entry of liveAgents.values()) syncEntry(entry)
    for (const entry of adopted.values()) syncEntry(entry)
  }

  /**
   * Which sessions the live registry reports right now.
   * @returns the session ids.
   */
  async function liveSessionIds() {
    const ids = []
    try {
      const value = await ctx.sessionController?.list?.({}, new AbortController().signal)
      for (const item of value?.items ?? []) ids.push(String(item.sessionId))
    } catch {
      /* the live registry is optional context for this reply */
    }
    return ids
  }

  /** What the last `resolveAgent` attempt saw, surfaced by `/rustxng-web-search/debug`. */
  let adoptProbe = 'no Agent adopted yet'

  /**
   * Adopt the live Agent of one session. A session that was already running when
   * this plugin activates never emits an Agent event this plugin observes, so the
   * session id named by a switch click is resolved on demand instead of enumerating
   * the session registry (`list` reports every persisted session, not a live set).
   * @param sessionId - the session whose Agent to adopt.
   */
  async function adoptAgent(sessionId) {
    try {
      const resolved = await ctx.sessionController?.resolveAgent?.(sessionId)
      const agent = resolved?.agent ?? (resolved && resolved.ctx ? resolved : null)
      if (!agent) {
        adoptProbe = `no Agent for ${sessionId}: keys ${Object.keys(resolved ?? {}).slice(0, 8).join(',') || 'none'}`
        return
      }
      // One handle per session, so repeated clicks do not accumulate Agents; drop
      // the previous handle's gate before replacing it.
      const previous = adopted.get(sessionId)
      if (previous?.raiseGate) {
        try {
          previous.raiseGate()
        } catch {
          /* already gone */
        }
      }
      adopted.set(sessionId, { agent, key: sessionId, source: 'resolveAgent', raiseGate: undefined })
      adoptProbe = `adopted Agent for ${sessionId}`
    } catch (error) {
      adoptProbe = `resolveAgent('${sessionId}') failed: ${error instanceof Error ? error.message : String(error)}`
      log(adoptProbe)
    }
  }

  /**
   * Report one session's switch state for the page.
   * @param sessionId - the session to report, omitted for every known session.
   * @returns the JSON answer.
   */
  async function stateReply(sessionId) {
    if (sessionId) {
      return {
        sessionId,
        enabled: enabledFor(sessionId),
        defaultEnabled,
        gatedTools: GATED_TOOLS,
        configured: sessionOverrides.has(sessionId),
        engine: engineSummary(),
      }
    }
    return {
      defaultEnabled,
      gatedTools: GATED_TOOLS,
      overrides: [...sessionOverrides.entries()].map(([id, enabled]) => ({ sessionId: id, enabled })),
      known: [...liveAgents.values(), ...adopted.values()].map((entry) => entry.key),
      engine: engineSummary(),
    }
  }

  /**
   * Answer one plugin-route request.
   * @param req - the incoming request.
   * @param res - the response to own.
   */
  async function handle(req, res) {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (!isSameOrigin(req)) return reply(403, { error: 'this endpoint is only reachable from the Harness page' })

    const path = (req.url ?? '').split('?')[0]
    const sub = path.slice(ROUTE.length).replace(/^\//, '')
    try {
      if (req.method === 'GET' && sub === 'debug') {
        return reply(200, {
          marker: 'switch-v2-engine',
          services: {
            webServerRegister: typeof webServer?.register,
            sessionList: typeof ctx.sessionController?.list,
            resolveAgent: typeof ctx.sessionController?.resolveAgent,
          },
          defaultEnabled,
          gatedTools: GATED_TOOLS,
          liveCount: (await liveSessionIds()).length,
          engine: engineSummary(),
          adoptProbe,
          overrides: [...sessionOverrides.entries()].map(([id, enabled]) => ({ sessionId: id, enabled })),
          gates: [...liveAgents.values(), ...adopted.values()].map((entry) => ({
            key: entry.key,
            source: entry.source ?? 'adopted',
            gated: Boolean(entry.raiseGate),
            probe: entry.probe ?? 'idle',
          })),
        })
      }
      if (req.method === 'GET' && sub === 'engine') {
        // Cheap answer from disk and memory only; the chip tooltip reads this.
        return reply(200, engineSummary())
      }
      if (req.method === 'GET' && sub === 'version') {
        // Ask upstream as well: what is installed, what is newest, whether to swap.
        const base = engineSummary()
        try {
          const check = await checkForUpdate({ destPath: binaryPath, repo: engineRepo, checkTimeoutMs })
          return reply(200, {
            ...base,
            version: check.installed || base.version,
            versionSource: check.installedSource,
            latest: check.latest,
            tag: check.tag,
            publishedAt: check.publishedAt,
            updateAvailable: check.available,
            asset: check.asset || base.asset,
            bytes: check.bytes,
          })
        } catch (error) {
          return reply(200, { ...base, checkError: error instanceof Error ? error.message : String(error) })
        }
      }
      if (req.method === 'GET' && sub === 'state') {
        const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '').get('session')
        return reply(200, await stateReply(query || ''))
      }
      if (req.method === 'GET' && sub === 'tools') {
        return reply(200, { gatedTools: GATED_TOOLS, defaultEnabled })
      }
      if (req.method === 'GET' && sub === 'probe') {
        // End-to-end self test: start the engine if needed, search through the
        // `web` service exactly as the model-facing tool does, report the outcome.
        const params = new URLSearchParams((req.url ?? '').split('?')[1] ?? '')
        const query = params.get('query') || 'deepseek harness'
        const maxResults = Number(params.get('max')) || 2
        try {
          const result = await ctx.web?.search?.({ query, maxResults })
          return reply(200, {
            ok: true,
            sources: result?.sources?.length ?? 0,
            first: result?.sources?.[0]?.url ?? null,
            answered: Boolean(result?.content),
            truncated: result?.truncated ?? false,
          })
        } catch (error) {
          return reply(200, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      if (req.method !== 'POST') return reply(405, { error: `unsupported method ${req.method ?? 'unknown'}` })
      if (!fromPage(req)) {
        return reply(403, { error: 'this control only accepts requests from the Harness page' })
      }

      const body = await readJsonBody(req)
      if (sub === 'set') {
        const sessionId = String(body.sessionId ?? '')
        if (!sessionId) return reply(400, { error: 'sessionId is required' })
        if (typeof body.enabled !== 'boolean') return reply(400, { error: 'enabled must be true or false' })
        sessionOverrides.set(sessionId, body.enabled)
        await adoptAgent(sessionId)
        syncAll()
        return reply(200, await stateReply(sessionId))
      }
      if (sub === 'update') {
        // Swap the engine now: check upstream, stop the running server, install the
        // newer asset. The next search starts the new binary.
        return reply(200, await applyUpdate())
      }
      if (sub === 'clear') {
        const sessionId = String(body.sessionId ?? '')
        if (!sessionId) return reply(400, { error: 'sessionId is required' })
        sessionOverrides.delete(sessionId)
        await adoptAgent(sessionId)
        syncAll()
        return reply(200, await stateReply(sessionId))
      }
      return reply(404, { error: `unknown rustxng-web-search endpoint '${sub}'` })
    } catch (error) {
      return reply(400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * What the engine looks like right now, read from disk without touching the network:
   * the installed version (from install metadata), the configured pin, the last known
   * upstream release, and the outcome of the last engine action. Feeds the chip tooltip
   * through the state route, `GET /rustxng-web-search/engine`, and the debug view.
   */
  function engineSummary() {
    const meta = readMetadata(binaryPath)
    return {
      path: binaryPath,
      present: fs.existsSync(binaryPath),
      version: meta?.version ?? '',
      repo: engineRepo,
      pinned: engineVersion,
      target: assetSuffixes()[0] ?? '',
      asset: meta?.asset ?? '',
      installedAt: meta?.installedAt ?? '',
      latestSeen: meta?.latestSeen ?? '',
      lastCheckAt: meta?.lastCheckAt ?? '',
      autoDownload,
      autoUpdate,
      updateIntervalMs,
      running: Boolean(child),
      busy: engineBusy,
      updater: updaterState,
      provider: providerState,
      note: engineNote,
      error: engineError,
    }
  }

  /**
   * Make sure the engine binary exists, fetching the configured release when
   * `autoDownload` allows it. Runs before every spawn, so a published install needs
   * nobody to place a binary by hand and a skipped `postinstall` stays recoverable.
   */
  async function ensureEngine() {
    if (fs.existsSync(binaryPath)) return
    if (!autoDownload) {
      throw new Error(
        `no engine at "${binaryPath}" and autoDownload is off: point binaryPath at an existing RustXNG binary, or enable autoDownload`,
      )
    }
    engineBusy = true
    try {
      log(`no engine at ${binaryPath}: fetching ${engineRepo} ${engineVersion || 'the newest release'}`)
      const meta = await installEngine({
        destPath: binaryPath,
        repo: engineRepo,
        version: engineVersion,
        checkTimeoutMs,
        downloadTimeoutMs,
        log: (message) => log(`engine: ${message}`),
      })
      engineNote = `supplied ${meta.asset} (${meta.version}, sha256 ${String(meta.sha256).slice(0, 12)}…)`
      engineError = ''
    } catch (error) {
      engineError = error instanceof Error ? error.message : String(error)
      engineNote = `engine download failed: ${engineError}`
      throw new Error(`could not supply the RustXNG engine: ${engineError}`)
    } finally {
      engineBusy = false
    }
  }

  /**
   * Stop the running engine and wait for it to leave. Windows refuses to replace the
   * image file of a live process, so an update has to take its own server down first.
   * @param graceMs - how long to wait for the child to exit.
   * @returns whether no engine process of ours is left.
   */
  async function stopEngine(graceMs = 5000) {
    const running = child
    if (!running) return true
    child = null
    startPromise = null
    try {
      running.kill()
    } catch {
      /* already exited */
    }
    const deadline = Date.now() + graceMs
    while (running.exitCode === null && Date.now() < deadline) {
      await new Promise((sleep) => setTimeout(sleep, 100))
    }
    return running.exitCode !== null
  }

  /**
   * Compare with upstream and, when a newer release exists, swap it in. A failure is
   * never fatal to search: the engine on disk keeps serving, and the reason surfaces
   * in `note` / `error`.
   * @returns a short summary for the `update` route.
   */
  async function applyUpdate() {
    if (engineBusy) return { ok: false, error: 'an engine download is already running' }
    engineBusy = true
    try {
      const current = installedVersion(binaryPath)
      const check = await checkForUpdate({ destPath: binaryPath, repo: engineRepo, checkTimeoutMs })
      if (!check.available) {
        engineNote = `engine ${check.installed || 'unknown'} is the newest ${engineRepo} release (${check.latest})`
        engineError = ''
        return { ok: true, updated: false, from: check.installed, latest: check.latest }
      }
      if (!check.asset) {
        engineError = `newer release ${check.tag} ships no asset for ${process.platform}/${process.arch}`
        engineNote = engineError
        return { ok: false, error: engineError }
      }
      log(`update available: ${check.installed || 'nothing'} -> ${check.latest} (${check.asset})`)
      if (!(await stopEngine())) {
        engineError = 'the running engine did not exit, so its binary was not replaced'
        engineNote = engineError
        return { ok: false, error: engineError }
      }
      const meta = await installEngine({
        destPath: binaryPath,
        repo: engineRepo,
        // The tag this check resolved, so the swap lands on the release already verified.
        version: check.tag,
        checkTimeoutMs,
        downloadTimeoutMs,
        log: (message) => log(`engine: ${message}`),
      })
      engineNote = `updated engine ${check.installed || 'nothing'} -> ${meta.version} (${meta.asset})`
      engineError = ''
      log(engineNote)
      return {
        ok: true,
        updated: true,
        from: current.version,
        fromSource: current.source,
        to: meta.version,
        asset: meta.asset,
        bytes: meta.bytes,
        sha256: meta.sha256,
        restart: 'the next search starts the new engine',
      }
    } catch (error) {
      engineError = error instanceof Error ? error.message : String(error)
      engineNote = `update failed: ${engineError}`
      return { ok: false, error: engineError }
    } finally {
      engineBusy = false
    }
  }

  async function startServer() {
    await ensureEngine()
    child = spawn(
      binaryPath,
      ['-b', bindAddress, '-p', String(port)],
      { stdio: 'ignore', windowsHide: true },
    )
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        const code = child.exitCode
        child = null
        throw new Error(`RustXNG exited early (code ${code}); check the configured port "${port}"`)
      }
      try {
        const probe = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(1500) })
        probe.body?.cancel?.()
        return // any HTTP response means the server is listening
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    try {
      child.kill()
    } catch {
      /* already gone */
    }
    child = null
    throw new Error(`RustXNG did not become ready on ${baseUrl} within 8s`)
  }

  async function doSearch(request, signal) {
    if (!startPromise) startPromise = startServer()
    try {
      await startPromise
    } catch (e) {
      startPromise = null // let the next call retry a fresh spawn
      throw new Error(`RustXNG search server failed to start: ${e.message}`)
    }

    const u = new URL(`${baseUrl}/search`)
    u.searchParams.set('q', request.query)
    u.searchParams.set('format', 'json')

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), searchTimeoutMs)
    const onAbort = () => ac.abort()
    if (signal) {
      if (signal.aborted) ac.abort()
      else signal.addEventListener('abort', onAbort)
    }

    try {
      const res = await fetch(u.toString(), { signal: ac.signal })
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`RustXNG search responded HTTP ${res.status}`)
      }
      const data = await res.json()

      let sources = (Array.isArray(data.results) ? data.results : [])
        .map((r) => {
          const s = { url: r.url }
          if (r.title) s.title = r.title
          const snippet = r.content || r.snippet
          if (snippet) s.snippet = snippet
          if (r.publishedDate) s.publishedAt = r.publishedDate
          return s
        })
        .filter((s) => typeof s.url === 'string' && s.url.length > 0)

      if (typeof request.maxResults === 'number' && request.maxResults >= 0) {
        sources = sources.slice(0, request.maxResults)
      }

      // Prefer an aggregated instant answer (SearXNG "answers") as the summary body.
      let content
      if (Array.isArray(data.answers)) {
        const parts = data.answers.map((a) => a && a.content).filter((x) => typeof x === 'string' && x)
        if (parts.length) content = parts.join('\n')
      }

      return { sources, content, truncated: false }
    } catch (e) {
      if (signal && signal.aborted) throw e
      throw new Error(`RustXNG search request failed (${u.origin}): ${e.message}`)
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  }

  const provider = {
    id: 'rustxng',
    // A missing-but-downloadable binary counts as available: the first search supplies
    // it, so a fresh install still resolves the pinned `searchProvider: rustxng` instead
    // of the harness reporting the configured provider missing.
    available: () => fs.existsSync(binaryPath) || autoDownload,
    search: doSearch,
  }

  ctx.effect(() => {
    // A duplicate provider id means an earlier instance of this plugin still holds the
    // slot; log it, but do not let that take the auto-update loop with it.
    let disposeProvider = null
    try {
      disposeProvider = ctx.web.registerSearchProvider(provider)
      providerState = { registered: true, error: '' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      providerState = { registered: false, error: message }
      log(`search provider "${provider.id}" could not be registered: ${message}`)
    }

    // Auto-update loop, owned by the same effect that owns the engine: one pending
    // timeout at a time, checked every `updateIntervalMs`. An update stops its own
    // server and replaces the binary; the next search spawns the new build, and a
    // failed check leaves the working engine untouched.
    let updateTimer = null
    const tick = () => {
      updateTimer = null
      void applyUpdate()
      updateTimer = setTimeout(tick, updateIntervalMs)
      updateTimer.unref?.()
    }
    if (!autoUpdate) {
      updaterState = { scheduled: false, immediateCheck: false, reason: 'autoUpdate is off' }
    } else if (!assetSuffixes().length) {
      updaterState = {
        scheduled: false,
        immediateCheck: false,
        reason: `no asset mapping for ${process.platform}/${process.arch}`,
      }
      log(`no RustXNG asset mapping for ${process.platform}/${process.arch}; set binaryPath to an existing binary`)
    } else {
      const meta = readMetadata(binaryPath)
      const last = Date.parse(meta?.lastCheckAt ?? '')
      const sinceLast = Number.isFinite(last) ? Date.now() - last : Number.POSITIVE_INFINITY
      const elapsed = Number.isFinite(sinceLast) ? `${Math.round(sinceLast / 60_000)} min` : 'never'
      const immediateCheck = sinceLast >= ACTIVATION_CHECK_GRACE_MS
      // Restarting the Host must not push the next check another interval out, so the
      // wait counts from the check that already happened, floored at one minute.
      const wait = Number.isFinite(sinceLast)
        ? Math.max(60_000, Math.min(updateIntervalMs, updateIntervalMs - sinceLast))
        : updateIntervalMs
      updaterState = {
        scheduled: true,
        immediateCheck,
        reason: `last check ${elapsed} ago; grace ${Math.round(ACTIVATION_CHECK_GRACE_MS / 60_000)} min, next check in ${Math.round(wait / 60_000)} min`,
      }
      if (immediateCheck) void applyUpdate()
      updateTimer = setTimeout(tick, immediateCheck ? updateIntervalMs : wait)
      updateTimer.unref?.()
    }

    return () => {
      disposeProvider?.()
      if (updateTimer) clearTimeout(updateTimer)
      startPromise = null
      if (child) {
        try {
          child.kill()
        } catch {
          /* already exited */
        }
        child = null
      }
    }
  }, 'rustxng-web-search: engine provider and auto-update')

  // The switch: Agent lifecycle in, tool visibility out, and the page's own route
  // back. Registered as one effect so an HMR re-activation rebuilds every piece.
  ctx.effect(() => {
    const disposers = []

    if (typeof webServer?.register === 'function') {
      try {
        disposers.push(webServer.register({ kind: 'prefix', path: ROUTE, handler: handle }))
      } catch (error) {
        log(`web route unavailable: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      log('no Web server in this composition, so the switch chip has no route to read')
    }

    // Every Agent this plugin sees through a lifecycle event becomes one entry; the
    // gate itself is only created when its session has been switched off. A subagent
    // is only gated when the runtime names its owning session (see `sessionKeyOf`).
    disposers.push(ctx.on('agent/created', (...args) => {
      const agent = agentFrom(args)
      if (!agent) return
      const key = sessionKeyOf(agent)
      if (isRebuiltSession(args) && key) sessionOverrides.delete(key)
      if (key && !liveAgents.has(agent)) liveAgents.set(agent, { agent, key, source: 'event' })
      const entry = liveAgents.get(agent)
      if (entry) syncEntry(entry)
    }))

    disposers.push(ctx.on('agent/disposed', (...args) => {
      const agent = agentFrom(args)
      if (!agent) return
      const entry = liveAgents.get(agent)
      if (entry?.raiseGate) {
        try {
          entry.raiseGate()
        } catch {
          /* already gone */
        }
      }
      liveAgents.delete(agent)
    }))

    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* already disposed */
        }
      }
      for (const entry of [...liveAgents.values(), ...adopted.values()]) {
        try {
          entry.raiseGate?.()
        } catch {
          /* already gone */
        }
      }
      liveAgents.clear()
      adopted.clear()
      sessionOverrides.clear()
    }
  }, 'rustxng-web-search: switch route, agent gates')
}
