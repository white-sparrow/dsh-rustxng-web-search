// Where the RustXNG binary comes from, so the plugin never depends on someone
// hand-placing a .exe: upstream GitHub releases, sha256-verified, written atomically.
//
// Shared by `scripts/install-engine.mjs` (install time) and `index.js` (first-use
// download and the auto-update check).
//
// Upstream: https://github.com/sahenjp/RustXNG — a SearXNG-compatible metasearch
// engine written in Rust, AGPL-3.0-or-later. Each release ships one binary per Rust
// target triple plus a `.sha256` sidecar; the release JSON also carries `digest`,
// so verification normally needs no second request. This package does NOT
// redistribute the engine: its tarball only says where to get it.

import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import https from 'node:https'

/** Repository this plugin downloads from; override with the `engineRepo` config. */
export const REPO = 'sahenjp/RustXNG'
/**
 * The release this plugin was built against: a fresh install takes this one.
 * 0.5.0 added the agent-facing parameters this plugin sends (`max_results`,
 * `include_domains`, `exclude_domains`) and fixed `timeout_limit` discarding results
 * from engines that had already answered; older builds simply ignore the extra
 * query parameters.
 */
export const PINNED_VERSION = '0.5.1'
export const UA = 'rustxng-web-search-plugin'

const API = 'https://api.github.com'
/** Redirect ceiling for `github.com/…/releases/download/…` links. */
const MAX_REDIRECTS = 6

/**
 * Which asset name this machine needs. Upstream names assets
 * `rustxng-<tag>-<rust target triple>`, with `.exe` only on Windows, so the
 * lookup is by target-triple suffix rather than an exact pinned name.
 * @param platform - Node's `process.platform`.
 * @param arch - Node's `process.arch`.
 * @returns preferred asset-name suffixes, best first.
 */
export function assetSuffixes(platform = process.platform, arch = process.arch) {
  const archPart = { x64: 'x86_64', arm64: 'aarch64' }[arch]
  if (!archPart) return []
  if (platform === 'win32') return [`${archPart}-pc-windows-msvc.exe`]
  if (platform === 'darwin') return [`${archPart}-apple-darwin`]
  return [`${archPart}-unknown-linux-gnu`, `${archPart}-unknown-linux-musl`]
}

/** Where the engine belongs inside this package: `bin/rustxng`, `.exe` on Windows. */
export function defaultDest(packageDir) {
  return path.join(packageDir, 'bin', process.platform === 'win32' ? 'rustxng.exe' : 'rustxng')
}

/** Sibling metadata file for a downloaded engine: `bin/rustxng.exe` -> `bin/rustxng.json`. */
export function metaPath(destPath) {
  const dir = path.dirname(destPath)
  const base = path.basename(destPath, path.extname(destPath))
  return path.join(dir, `${base}.json`)
}

/**
 * Read the install metadata written next to the binary.
 * @param destPath - the engine path.
 * @returns the stored object, or null when absent or unreadable.
 */
export function readMetadata(destPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath(destPath), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Merge fields into the install metadata. Best-effort: a read-only volume must not
 * break searching.
 * @param destPath - the engine path.
 * @param fields - fields to merge.
 * @returns whether the file was written.
 */
export function writeMetadata(destPath, fields) {
  const target = metaPath(destPath)
  const merged = { ...readMetadata(destPath) ?? {}, ...fields }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify(merged, null, 2))
    return true
  } catch {
    return false
  }
}

/** `v0.4.1` -> `0.4.1`. */
export function versionOfTag(tag) {
  return String(tag ?? '').replace(/^v/, '').trim()
}

/** Pull the first `X.Y.Z` out of text such as `RustXNG 0.4.1`. */
export function parseVersion(text) {
  const match = String(text ?? '').match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)
  return match ? match[0] : ''
}

/**
 * Compare two dotted versions numerically (prerelease suffixes ignored).
 * @param a - left version.
 * @param b - right version.
 * @returns -1, 0, or 1.
 */
export function compareVersions(a, b) {
  const left = String(a ?? '').split('.')
  const right = String(b ?? '').split('.')
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const one = Number.parseInt(left[index] ?? '0', 10) || 0
    const other = Number.parseInt(right[index] ?? '0', 10) || 0
    if (one !== other) return one < other ? -1 : 1
  }
  return 0
}

/** Collapse a response body into one short line for an error message. */
function summarize(text, limit = 200) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

/**
 * GET one URL and hand back the response object, following redirects by re-requesting
 * the `Location` value. Node's `https` client does not follow redirects, and GitHub
 * release downloads answer 302 to a blob host.
 * @param url - the URL to fetch.
 * @param options - `timeoutMs`, an optional hop budget, and an optional `range`
 * header used to resume a download that the server honours with status 206.
 * @returns the live response plus its final URL.
 */
async function open(url, { timeoutMs = 15000, hops = MAX_REDIRECTS, range = '' } = {}) {
  let current = url
  for (let hop = 0; ; hop += 1) {
    const target = new URL(current)
    const response = await new Promise((resolveResponse, rejectRequest) => {
      const request = https.get(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port ? target.port : undefined,
          path: `${target.pathname}${target.search}`,
          headers: { 'user-agent': UA, accept: 'application/json, application/octet-stream;q=0.9', 'accept-encoding': 'identity' },
        },
        (incoming) => resolveResponse(incoming),
      )
      request.setTimeout(timeoutMs, () => request.destroy(new Error(`request to ${target.hostname} timed out after ${timeoutMs} ms`)))
      request.on('error', rejectRequest)
      request.end()
    })
    const location = response.headers.location
    if (hop < hops && response.statusCode >= 300 && response.statusCode < 400 && location) {
      response.destroy()
      current = new URL(location, current).href
      continue
    }
    return { response, url: current }
  }
}

/** Read a response body into text, capped to keep error paths cheap. */
async function readText(response, limit = 4000) {
  let raw = ''
  for await (const chunk of response) {
    raw += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    if (raw.length > limit) break
  }
  return raw
}

/**
 * Read a body that must not be truncated: a release JSON document needs every byte,
 * so an over-cap body is an error rather than a partial read that fails to parse.
 * @param response - the live response.
 * @param limit - byte ceiling.
 * @returns the full body text.
 */
async function readCapped(response, limit = 400_000) {
  let raw = ''
  let total = 0
  for await (const chunk of response) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > limit) {
      response.destroy()
      throw new Error(`response body passed the ${limit} byte ceiling after ${total} bytes`)
    }
    raw += buffer.toString('utf8')
  }
  return raw
}

/**
 * Fetch and parse a JSON endpoint.
 * @param url - the endpoint.
 * @param options - `timeoutMs`.
 * @returns the parsed body.
 */
async function getJson(url, { timeoutMs = 15000 } = {}) {
  const { response } = await open(url, { timeoutMs })
  const text = await readCapped(response, 400_000)
  if (response.statusCode !== 200) {
    throw new Error(`${url} answered ${response.statusCode}${summarize(text) ? `: ${summarize(text)}` : ''}`)
  }
  return JSON.parse(text)
}

/**
 * GET a URL and return its text, for a release's `.sha256` sidecar.
 * @param url - the URL.
 * @param options - `timeoutMs`.
 * @returns the body text.
 */
async function fetchText(url, { timeoutMs = 15_000 } = {}) {
  const { response } = await open(url, { timeoutMs })
  const text = await readText(response, 4_000)
  if (response.statusCode !== 200) {
    throw new Error(`${url} answered ${response.statusCode}: ${summarize(text)}`)
  }
  return text
}

/**
 * Fetch a release. With no `version` this reads the newest non-draft, non-prerelease
 * release; with one it resolves that tag (trying both `v`-prefixed and bare spellings).
 * @param options - `repo`, optional `version`, `timeoutMs`.
 * @returns `{ tag, version, publishedAt, prerelease, assets }`.
 */
export async function fetchRelease({ repo = REPO, version = '', timeoutMs = 15000 } = {}) {
  const repoPath = String(repo).replace(/^\/+|\/+$/g, '')
  const fetchOne = async (tagSpelling) => {
    const url = `${API}/repos/${repoPath}/releases/${tagSpelling}`
    const { response } = await open(url, { timeoutMs })
    const text = await readText(response, 400_000)
    if (response.statusCode !== 200) return { status: response.statusCode, url, hint: summarize(text, 120) }
    return { status: 200, url, body: JSON.parse(text) }
  }
  let attempt
  if (version) {
    const raw = String(version).trim()
    const spellings = [`tags/${raw}`, ...(raw.startsWith('v') ? [] : [`tags/v${raw}`])]
    for (const spelling of spellings) {
      attempt = await fetchOne(spelling)
      if (attempt.status === 200) break
    }
  } else {
    attempt = await fetchOne('latest')
  }
  if (attempt.status !== 200) {
    throw new Error(`no ${version ? `release ${version} in` : 'latest release of'} ${repoPath} (${attempt.status}${attempt.hint ? `: ${attempt.hint}` : ''})`)
  }
  const body = attempt.body
  const assets = (Array.isArray(body.assets) ? body.assets : [])
    .map((asset) => ({
      name: String(asset.name ?? ''),
      url: String(asset.browser_download_url ?? asset.url ?? ''),
      bytes: Number(asset.size ?? 0) || 0,
      sha256: typeof asset.digest === 'string' && asset.digest.startsWith('sha256:') ? asset.digest.slice('sha256:'.length) : '',
    }))
    .filter((asset) => asset.name && asset.url)
  if (!assets.length) throw new Error(`release ${body.tag_name} of ${repoPath} lists no downloadable assets`)
  return {
    repo: repoPath,
    tag: String(body.tag_name ?? ''),
    version: versionOfTag(body.tag_name),
    publishedAt: String(body.published_at ?? ''),
    prerelease: Boolean(body.prerelease),
    assets,
    endpoint: attempt.url,
  }
}

/**
 * Choose the asset for this machine, falling back to a `.sha256` sidecar when the
 * release JSON carries no `digest`.
 * @param release - a release from fetchRelease.
 * @param options - optional explicit `suffixes`, plus platform/arch for the message.
 * @returns the chosen asset.
 */
export function pickAsset(release, { suffixes, platform = process.platform, arch = process.arch } = {}) {
  const wanted = suffixes ?? assetSuffixes(platform, arch)
  const usable = release.assets.filter((asset) => !asset.name.toLowerCase().endsWith('.sha256'))
  for (const suffix of wanted) {
    const found = usable.find((asset) => asset.name.toLowerCase().endsWith(suffix.toLowerCase()))
    if (!found) continue
    // Older releases carry no `digest`; the `.sha256` sidecar asset does.
    const sidecar = release.assets.find((asset) => asset.name.toLowerCase() === `${found.name.toLowerCase()}.sha256`)
    return { ...found, sha256Url: found.sha256 ? '' : sidecar?.url ?? '' }
  }
  const triple = wanted.length ? wanted[0] : `a build for ${platform}/${arch}`
  throw new Error(
    `release ${release.tag} of ${release.repo} ships no asset for ${platform}/${arch} (looked for ${wanted.join(' or ') || triple}); assets: ${usable.map((asset) => asset.name).join(', ')}`,
  )
}

/**
 * Fetch the version of the binary already on disk. Metadata written at install time
 * is authoritative; otherwise ask the binary itself (`rustxng -v`).
 * @param destPath - the engine path.
 * @returns `{ version, source, meta }`.
 */
export function installedVersion(destPath) {
  const meta = readMetadata(destPath)
  if (meta?.version) return { version: String(meta.version), source: 'metadata', meta }
  if (!fs.existsSync(destPath)) return { version: '', source: 'missing', meta }
  try {
    const probe = spawnSync(destPath, ['-v'], { encoding: 'utf8', timeout: 8000, windowsHide: true })
    const version = probe?.stdout ? parseVersion(probe.stdout) : ''
    return { version, source: version ? 'binary -v' : 'unknown', meta }
  } catch {
    return { version: '', source: 'unknown', meta }
  }
}

/**
 * Download one URL to a file: stream into `<dest>.part-<pid>`, hash as it arrives,
 * verify size and sha256, then rename over the destination so a partial pull can never
 * look like a working engine. A connection that dies mid-stream is continued with a
 * Range request for the same URL, so a 20 MB download survives a flaky link; a pass
 * that turned out wrong still fails the digest check, and the old binary stays in place.
 * @param url - the download URL.
 * @param destPath - where the finished file lands.
 * @param options - `sha256`, `bytes`, `timeoutMs` (a sliding per-chunk budget), `retries`
 * (extra passes a stalled download may take), `log`.
 * @returns `{ bytes, sha256, verifiedBy, url }`.
 */
export async function downloadFile(url, destPath, { sha256 = '', sha256Url = '', bytes = 0, timeoutMs = 180_000, retries = 8, log = () => {} } = {}) {
  const dir = path.dirname(destPath)
  fs.mkdirSync(dir, { recursive: true })
  // Sweep leftovers from an earlier attempt of the same binary. Windows cannot unlink
  // a file whose write handle is still open, so a stuck handle is simply skipped.
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(`${path.basename(destPath)}.part-`)) {
      try {
        fs.rmSync(path.join(dir, name), { force: true })
      } catch {
        /* still held open by an older attempt in this process */
      }
    }
  }
  // Unique per call: a fixed `<dest>.part-<pid>` name lets one orphaned handle poison
  // the next download, which then dies with EPERM on Windows.
  const part = `${destPath}.part-${process.pid}-${randomUUID().slice(0, 8)}`
  /** Running sha256 over the whole file, so resumed passes keep hashing in order. */
  let hash = createHash('sha256')
  let received = 0
  let resolvedUrl = url
  /** The partial file's write handle, so a failed pass can release it. */
  let out = null
  const closeOut = () => {
    const handle = out
    out = null
    if (handle && !handle.destroyed) {
      try {
        handle.destroy()
      } catch {
        /* already closed */
      }
    }
  }

  /**
   * One pass over the wire: fetch from `received` onwards and append what arrives.
   * @param range - a Range header for a resumed pass, empty for a cold start.
   * @returns `'complete'`, `'short'` (body ended early), `'restart'` (the host
   * refused to resume, so byte 0 is all it can give) or throws on transport failure.
   */
  const runPass = async (range) => {
    const { response, url: finalUrl } = await open(url, { timeoutMs: Math.min(timeoutMs, 60_000), range })
    resolvedUrl = finalUrl
    if (response.statusCode !== 200 && response.statusCode !== 206) {
      const text = await readText(response, 400)
      throw new Error(`${finalUrl} answered ${response.statusCode}: ${summarize(text)}`)
    }
    const from = received
    if (from > 0) {
      // Only a 206 whose `Content-Range` starts exactly at what we hold may be
      // appended to; anything else means the host is restarting the body.
      const start = /^bytes (\d+)-/.exec(String(response.headers['content-range'] ?? ''))?.[1] ?? ''
      if (response.statusCode !== 206 || start !== String(from)) {
        response.destroy()
        return 'restart'
      }
    }
    out = fs.createWriteStream(part, from > 0 ? { flags: 'a' } : { flags: 'w' })
    // A sliding budget: any progress defers the deadline, so a slow link is fine
    // while a stalled connection cannot hang the plugin.
    const fail = () => response.destroy(new Error(`download stalled past ${timeoutMs} ms of quiet`))
    const timer = setTimeout(fail, timeoutMs)
    try {
      await new Promise((resolveWrite, rejectWrite) => {
        response.on('data', (chunk) => {
          const buffer = Buffer.from(chunk)
          received += buffer.length
          hash.update(buffer)
          // Honour backpressure: a full write buffer pauses the response until the
          // file stream drains again. A bare `pause()` here would hang the download.
          if (!out.write(buffer)) {
            response.pause()
            out.once('drain', () => response.resume())
          }
          timer.refresh()
          if (bytes && received > bytes + 4096) {
            response.destroy(new Error(`stream passed the ${bytes} bytes the release advertises`))
          }
        })
        response.on('aborted', () => {
          clearTimeout(timer)
          rejectWrite(new Error(`connection closed after ${received} of ${bytes ? bytes : '?'} bytes`))
        })
        response.on('error', (error) => {
          clearTimeout(timer)
          rejectWrite(error)
        })
        out.on('error', (error) => {
          clearTimeout(timer)
          response.destroy()
          rejectWrite(error)
        })
        response.on('end', () => {
          out.end(() => {
            clearTimeout(timer)
            resolveWrite()
          })
        })
      })
    } catch (error) {
      closeOut()
      throw error
    }
    out = null
    return bytes && received < bytes ? 'short' : 'complete'
  }

  let lastStallAt = -1
  try {
    for (let pass = 0; ; pass += 1) {
      let outcome = 'error'
      try {
        outcome = await runPass(received > 0 ? `bytes=${received}-` : '')
      } catch (error) {
        if (/answered|passed the/.test(error.message)) throw error
        closeOut()
        outcome = 'error'
      }
      if (outcome === 'complete') break
      if (outcome === 'restart') {
        closeOut()
        fs.rmSync(part, { force: true })
        hash = createHash('sha256')
        received = 0
        if (pass >= retries) throw new Error(`${resolvedUrl} would not resume the download for ${destPath}`)
        continue
      }
      // 'short' or 'error': keep what landed and ask the host for the rest.
      const resumable = pass < retries && received > lastStallAt
      lastStallAt = received
      if (!resumable) {
        throw new Error(`download stopped at ${received} of ${bytes ? bytes : '?'} bytes and cannot resume further`)
      }
      log(`download reached ${received} of ${bytes || '?'} bytes; resuming (pass ${pass + 2} of ${retries + 1})`)
    }

    const digest = hash.digest('hex')
    if (bytes && received !== bytes) {
      throw new Error(`downloaded ${received} bytes but the release says ${bytes}`)
    }
    let expected = sha256
    let verifiedBy = 'release digest'
    if (!expected && sha256Url) {
      const sidecar = await fetchText(sha256Url, { timeoutMs: Math.min(timeoutMs, 30_000) })
      expected = (sidecar.match(/[a-f0-9]{64}/i) ?? [''])[0]?.toLowerCase() ?? ''
      verifiedBy = 'sha256 sidecar'
      if (!expected) throw new Error(`the ${sha256Url} sidecar carries no sha256 to check`)
    }
    if (expected && digest !== expected) {
      throw new Error(`sha256 mismatch (${verifiedBy}): expected ${expected}, got ${digest}`)
    }
    try {
      fs.chmodSync(part, 0o755)
    } catch {
      /* Windows ignores the bit; posix keeps the executable flag */
    }
    fs.renameSync(part, destPath)
    log(`installed ${path.basename(destPath)} (${(received / 1048576).toFixed(1)} MB, sha256 ${digest.slice(0, 12)}…, verified by ${verifiedBy})`)
    return { bytes: received, sha256: digest, verifiedBy, url: resolvedUrl }
  } catch (error) {
    if (out && !out.destroyed) {
      // Windows will not delete a file this process still holds open: close the
      // handle before unlinking, then retry until the kernel lets go.
      try {
        out.destroy()
      } catch {
        /* already closed */
      }
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (!fs.existsSync(part)) break
      try {
        fs.rmSync(part, { force: true })
      } catch {
        /* handle still held; wait for it */
        await new Promise((sleep) => setTimeout(sleep, 200))
      }
    }
    throw error
  }
}

/**
 * Install a release engine: pick this machine's asset, download it, verify it,
 * record metadata next to it.
 * @param options - `destPath`, `repo`, optional `version` (empty means latest),
 * `checkTimeoutMs`, `downloadTimeoutMs`, `log`.
 * @returns the metadata object now stored beside the binary.
 */
export async function installEngine({ destPath, repo = REPO, version = '', checkTimeoutMs = 15_000, downloadTimeoutMs = 180_000, log = () => {} } = {}) {
  const release = await fetchRelease({ repo, version, timeoutMs: checkTimeoutMs })
  const asset = pickAsset(release)
  log(`fetching ${asset.name} (${(asset.bytes / 1048576).toFixed(1)} MB) from ${repo} ${release.tag}`)
  const pulled = await downloadFile(asset.url, destPath, {
    sha256: asset.sha256,
    sha256Url: asset.sha256Url ?? '',
    bytes: asset.bytes,
    timeoutMs: downloadTimeoutMs,
    log,
  })
  const meta = {
    version: release.version,
    tag: release.tag,
    repo,
    asset: asset.name,
    bytes: pulled.bytes,
    sha256: pulled.sha256,
    verifiedBy: pulled.verifiedBy,
    url: asset.url,
    installedAt: new Date().toISOString(),
    lastCheckAt: new Date().toISOString(),
    latestSeen: release.version,
  }
  writeMetadata(destPath, meta)
  return meta
}

/**
 * Compare what is installed with what upstream ships, and remember the check so a
 * restart does not immediately ask again.
 * @param options - `destPath`, `repo`, `checkTimeoutMs`.
 * @returns `{ installed, installedSource, latest, tag, available, asset }`.
 */
export async function checkForUpdate({ destPath, repo = REPO, checkTimeoutMs = 15_000 } = {}) {
  const current = installedVersion(destPath)
  const release = await fetchRelease({ repo, timeoutMs: checkTimeoutMs })
  let asset = null
  try {
    asset = pickAsset(release)
  } catch {
    asset = null
  }
  const available = current.version ? compareVersions(release.version, current.version) > 0 : true
  const now = new Date().toISOString()
  const fields = { lastCheckAt: now, latestSeen: release.version, latestTag: release.tag }
  if (current.version) {
    // A hand-placed binary has no metadata of its own: record the version just read
    // from it, so later reads answer from disk instead of probing again.
    fields.version = current.version
    fields.versionSource = current.source
  }
  writeMetadata(destPath, fields)
  return {
    installed: current.version,
    installedSource: current.source,
    latest: release.version,
    tag: release.tag,
    publishedAt: release.publishedAt,
    available,
    asset: asset?.name ?? '',
    assetUrl: asset?.url ?? '',
    bytes: asset?.bytes ?? 0,
    target: assetSuffixes()[0] ?? '',
    checkedAt: now,
  }
}
