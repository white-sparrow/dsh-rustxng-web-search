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

// Tunables surfaced through the plugin's Config. All optional; sensible defaults
// applied in code so activation never requires a config.
export const Config = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  properties: {
    binaryPath: {
      type: 'string',
      description: 'Absolute path to the RustXNG binary. Defaults to the bundled bin/rustxng(.exe).',
    },
    bindAddress: {
      type: 'string',
      default: '127.0.0.1',
      description: 'Loopback address the server listens on.',
    },
    port: {
      type: 'integer',
      minimum: 1,
      maximum: 65535,
      default: 8888,
      description: 'Port the server listens on; change it if the port is already taken.',
    },
    requestTimeoutMs: {
      type: 'integer',
      minimum: 1000,
      default: 20000,
      description: 'Timeout for a single upstream engine request inside RustXNG.',
    },
    searchTimeoutMs: {
      type: 'integer',
      minimum: 1000,
      default: 30000,
      description: 'Per-call timeout for one web_search query.',
    },
  },
}

export const inject = ['web']

export function apply(ctx, config) {
  const cfg = config || {}
  const binaryPath = cfg.binaryPath ?? defaultBinary()
  const bindAddress = cfg.bindAddress ?? '127.0.0.1'
  const port = cfg.port ?? 8888
  const requestTimeoutMs = cfg.requestTimeoutMs ?? 20000
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
      ['-b', bindAddress, '-p', String(port), '--debug', String(requestTimeoutMs)],
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
