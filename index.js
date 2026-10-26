// DSH plugin: key-free web search backed by a locally spawned RustXNG metasearch server.
//
// It registers a WebSearchProvider (id "rustxng") on ctx.web. The bundle patch
// pins web.searchProvider = "rustxng" and enables the dsh-tool-web row, so the
// built-in web_search tool routes here with no API key and no configuration.
//
// RustXNG is the bundled Rust rewrite of SearXNG: a self-contained HTTP server.
// We spawn it lazily on the first search, keep it alive for the plugin's lifetime
// (one server reused across searches), and query GET /search?...&format=json.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function defaultBinary() {
  const dir = path.join(HERE, 'bin')
  const win = path.join(dir, 'rustxng.exe')
  if (fs.existsSync(win)) return win
  const posix = path.join(dir, 'rustxng')
  if (fs.existsSync(posix)) return posix
  return win // best-effort; available() reports false when it is genuinely missing
}

const DEFAULT_BINARY = defaultBinary()

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
}

/** Inclusive bounds for the numeric knobs; the schema types them as numbers only. */
const CONFIG_RANGES = {
  port: [1, 65535],
  searchTimeoutMs: [1000, 300_000],
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
    if (typeof CONFIG_DEFAULTS[key] === 'number') {
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

export const inject = ['web']

export function apply(ctx, config) {
  const cfg = config || {}
  const binaryPath = cfg.binaryPath ?? DEFAULT_BINARY
  const bindAddress = cfg.bindAddress ?? '127.0.0.1'
  const port = cfg.port ?? 8888
  const searchTimeoutMs = cfg.searchTimeoutMs ?? 30000
  const baseUrl = `http://${bindAddress}:${port}`

  let child = null
  let startPromise = null

  async function startServer() {
    if (!fs.existsSync(binaryPath)) {
      throw new Error(`RustXNG binary not found at "${binaryPath}"`)
    }
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
    available: () => fs.existsSync(binaryPath),
    search: doSearch,
  }

  ctx.effect(() => {
    const dispose = ctx.web.registerSearchProvider(provider)
    return () => {
      dispose()
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
  })
}
