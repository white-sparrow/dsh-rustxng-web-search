// Re-ranking for the metasearch results this plugin receives.
//
// Why this exists: RustXNG (like SearXNG) scores a merged result as
// `weight x sum(1 / position-in-that-engine)`, and it ships `weight = 1` for
// essentially every general-web engine. So every engine's first hit scores
// exactly 1 and the merged list opens with "one arbitrary #1 from each engine",
// which is what the model-facing `web_search` slice would otherwise show. The
// engine *has* the relevant pages (they were at index 9-12 of 59); only the
// order is useless. This module scores the merged list by how well each result
// agrees with the query, then caps how many results one host may contribute.
//
// It is deliberately pure: it takes the raw `results` array and returns a reordered
// copy, so the behaviour is testable without the engine running.

/** Lower-case, drop punctuation, collapse spaces. */
function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Share of letters that are outside the Latin range, 0..1. */
function nonLatinShare(s) {
  const letters = String(s ?? '').match(/\p{L}/gu)
  if (!letters || !letters.length) return 0
  let foreign = 0
  for (const ch of letters) if (ch.codePointAt(0) > 0x2b4f) foreign += 1
  return foreign / letters.length
}

/** Host of a URL, with `www.` stripped, or '' when unparseable. */
function hostOf(url) {
  const match = /^https?:\/\/([^/]+)/i.exec(String(url ?? ''))
  if (!match) return ''
  return match[1].toLowerCase().replace(/^www\./, '')
}

/**
 * Score one merged result against the query. Higher is better; the absolute
 * value means nothing, only the order. `tokens` carry document-frequency weights
 * so that a token every result mentions ("release", "version") cannot outrank a
 * distinctive one ("rustxng"), and `phrases` are the whole query plus each of
 * its adjacent pairs, so a title carrying the phrase beats one sharing loose
 * tokens.
 */
function scoreResult(item, query, tokens, queryPhrase, pairs, distinctive, versionBoosts) {
  const title = norm(item.title)
  const snippet = norm(item.content)
  const url = norm(item.url)
  const joined = `${title} ${snippet} ${url}`

  let score = 0
  const wantsVersions = tokens.some((entry) => VERSION_TOKENS.has(entry.token))

  for (const { token, weight } of tokens) {
    if (title.includes(token)) score += 3 * weight
    if (url.includes(token)) score += 2.5 * weight
    if (snippet.includes(token)) score += 1.2 * weight
  }
  if (queryPhrase && title.includes(queryPhrase)) score += 8
  else if (queryPhrase && joined.includes(queryPhrase)) score += 4

  // Adjacent pairs of the query are much stronger evidence than loose tokens.
  // Pairs match in either order, because "sahenjp RustXNG" and "RustXNG sahenjp"
  // name the same subject.
  for (const pair of pairs) {
    if (matchesPair(title, pair)) score += 3
    else if (matchesPair(joined, pair)) score += 1.5
  }

  // A result that carries none of the query's distinctive tokens is off-topic
  // noise from this engine's blocked-engine set: push it down hard.
  if (distinctive.length) {
    let carriesOne = false
    for (const token of distinctive) {
      if (joined.includes(token)) {
        carriesOne = true
        break
      }
    }
    if (!carriesOne) score -= 6
  }

  // When the query asks about versions, order the version-named pages by how
  // recent their number is *relative to the versions in this pool* — that is
  // bounded, so a big version number can never swamp a topic match.
  if (wantsVersions) {
    const value = versionValue(String(item.url))
    if (value > 0) {
      const boost = versionBoosts.get(`${clusterKey(item.url)}|${value}`)
      if (boost) score += boost
    }
  }

  // A URL whose path simply *is* the subject ("github.com/sahenjp/RustXNG") is
  // the project's home page, which should beat pages merely about the project.
  if (homeLike(String(item.url), distinctive)) score += 1.5

  // Several engines agreeing on one URL is independent evidence of a real hit.
  const engines = Array.isArray(item.engines) ? item.engines.length : 1
  if (engines > 1) score += 1.5 * engines

  // A page higher up a site hierarchy is likelier the canonical one than a
  // deep child page; capped so a long path cannot dominate.
  const segments = hostOf(item.url) ? String(item.url).replace(/^https?:\/\//i, '').split('/').filter(Boolean).length : 0
  score += Math.max(0, Math.min(3, 4 - segments)) * 0.4

  // A discussion, pull request or forum thread is rarely the answer to a
  // "what is this / where is this project" query, so it costs a little.
  if (/\/(pull|issues|issue|commit|forum|thread|topic)\b/i.test(String(item.url))) score -= 1

  // Known-first hosts: organisations whose pages are usually the canonical ones.
  const host = hostOf(item.url)
  const trusted = Boolean(host) && TRUSTED_HOSTS.some((entry) => host === entry || host.endsWith(`.${entry}`))
  if (trusted) score += 2

  // Keyword-squatting domains: a host built out of the query's own words
  // ("deepseek-plugin.org", "dshplugin.dev") is usually a content farm that
  // exists to be found by that query, not a source about its subject.
  if (host) {
    let hits = 0
    for (const token of distinctive) if (host.includes(token)) hits += 1
    if (hits >= 2) score -= 4
    else if (hits === 1) score -= 2
  }

  // A trusted host carrying the query's own subject words is very likely the
  // canonical page for the subject, whatever keyword-farm pages out-score it
  // on raw word overlap.
  if (trusted) {
    let distinctHits = 0
    for (const token of distinctive) {
      if (title.includes(token) || url.includes(token)) distinctHits += 1
    }
    if (distinctHits >= 2) score += 5
    else if (distinctHits === 1) score += 2.5
  }

  // Junk that this machine's blocked-engine set produces is mostly pages in a
  // script the query never used; a legitimate non-Latin query keeps its own
  // results, so only penalise when the query itself is Latin.
  const latinQuery = nonLatinShare(query) < 0.2
  if (latinQuery) {
    const foreign = Math.max(nonLatinShare(item.title), nonLatinShare(item.content))
    if (foreign > 0.4) score -= 3
  }

  // The engine's own score only ever as a tie-breaker.
  score += (Number(item.score) || 0) * 0.05

  return score
}

/** Query words that mean "I care about which version / how recent". */
const VERSION_TOKENS = new Set(['latest', 'newest', 'version', 'versions', 'ver', 'release', 'releases', 'update', 'updates', 'changelog'])

/** Registrable hosts whose pages are usually canonical for a software query. */
const TRUSTED_HOSTS = [
  'github.com', 'gitlab.com', 'bitbucket.org', 'sourceforge.net', 'pypi.org', 'crates.io',
  'npmjs.com', 'docker.com', 'wikipedia.org', 'wikiwand.com', 'stackoverflow.com',
  'githubusercontent.com', 'archive.org', 'readthedocs.io', 'deepseek.com',
]

/**
 * Query tokens with weights assigned from the query itself.
 *
 * Document frequency inside the returned pool is deliberately NOT used: measured
 * on real responses, the pool is already narrowed to the subject, so "rustxng"
 * and "sahenjp" appear in *more* results than "latest" or "version" and pool-internal
 * idf would damp exactly the tokens that matter. Instead, the few meta-words people
 * put in queries ("latest", "version", "download", …) get a small fixed weight.
 */
const META_TOKENS = new Set([
  'latest', 'newest', 'new', 'old', 'version', 'versions', 'ver', 'release', 'releases',
  'update', 'updates', 'changelog', 'download', 'free', 'best', 'top', 'list', 'all',
  'the', 'a', 'an', 'and', 'for', 'with', 'get', 'how', 'what', 'when', 'where', 'why',
  'is', 'of', 'to', 'in', 'on', 'info', 'about', 'page', 'official', 'site', 'website',
  'http', 'https', 'www', 'com', 'net', 'org',
])

function tokenList(query) {
  const seen = new Set()
  const tokens = []
  for (const raw of norm(query).split(' ')) {
    if (raw.length < 2 || seen.has(raw)) continue
    seen.add(raw)
    tokens.push({ token: raw, weight: META_TOKENS.has(raw) ? 0.35 : 1 })
  }
  return tokens
}

/** Tokens that name the subject: real words that are not query meta-words. */
function distinctiveTokens(tokens) {
  return tokens.filter((entry) => entry.weight >= 1 && entry.token.length >= 3).map((entry) => entry.token)
}

/** Each adjacent pair of query tokens, normalised. */
function tokenPairs(query) {
  const tokens = norm(query).split(' ')
  const pairs = []
  for (let i = 0; i + 1 < tokens.length; i += 1) pairs.push([tokens[i], tokens[i + 1]])
  return pairs
}

/** True when both tokens of a pair appear next to each other, in either order. */
function matchesPair(text, pair) {
  if (!text || !pair || pair.length < 2) return false
  if (!text.includes(pair[0]) || !text.includes(pair[1])) return false
  const a = escapeRe(pair[0])
  const b = escapeRe(pair[1])
  // Adjacent, allowing only the separators a URL or title uses between words.
  const pattern = `${a}\\s*[-_/.]?\\s*${b}|${b}\\s*[-_/.]?\\s*${a}`
  return new RegExp(pattern).test(text)
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `major*1000 + minor*100 + patch` for the version a URL names, else 0. */
function versionValue(url) {
  const match = String(url).match(/\/(?:releases\/tag\/)?v?(\d+)\.(\d+)\.(\d+)/i)
  if (!match) return 0
  return Number(match[1]) * 1000 + Number(match[2]) * 100 + Number(match[3])
}

/** True when the URL's path is simply the query's own subject words. */
function homeLike(url, distinctive) {
  const segments = String(url).replace(/^https?:\/\//i, '').split('/').filter(Boolean).slice(1)
  if (!segments.length || segments.length > 3) return false
  return segments.every((segment) => distinctive.includes(norm(segment)))
}

/** Project identity of a URL: host plus its first two path segments. */
function clusterKey(url) {
  const parts = String(url).replace(/^https?:\/\//i, '').split('/').filter(Boolean)
  if (parts.length < 3) return (parts[0] ?? '').toLowerCase()
  return `${parts[0]}/${norm(parts[1])}/${norm(parts[2])}`
}

/**
 * Recency boosts for pages that name a version, computed per project cluster:
 * within one repository the page naming the newest version wins, while the
 * absolute numbers never leak across clusters (a `v9.0` in an unrelated project
 * could otherwise swamp everything).
 */
function buildVersionBoosts(list) {
  const clusters = new Map()
  for (const item of list) {
    const value = versionValue(item.url)
    if (!value) continue
    const key = clusterKey(item.url)
    if (!clusters.has(key)) clusters.set(key, new Set())
    clusters.get(key).add(value)
  }
  const boosts = new Map()
  for (const key of clusters.keys()) {
    const sorted = Array.from(clusters.get(key)).sort((a, b) => a - b)
    sorted.forEach((value, index) => boosts.set(`${key}|${value}`, (3.6 * (index + 1)) / sorted.length))
  }
  return boosts
}

/**
 * Reorder `items` for `query`.
 *
 * `opts.hostCap` limits how many results one host may contribute (0 or Infinity
 * disables the cap). Results that the cap would drop are appended afterwards,
 * so a caller asking for N results still receives N whenever the engine gave
 * that many.
 */
export function rankResults(query, items, opts = {}) {
  const list = Array.isArray(items) ? items : []
  if (!list.length) return []

  const hostCap = Number.isFinite(opts?.hostCap) ? Math.max(1, Math.floor(opts.hostCap)) : 0
  const pool = Number.isFinite(opts?.pool) && opts.pool > 0 ? Math.floor(opts.pool) : list.length

  const normalisedQuery = norm(query)
  const tokens = tokenList(query)
  const pairs = tokenPairs(query)
  const distinctive = distinctiveTokens(tokens)
  const versionBoosts = buildVersionBoosts(list)

  const scored = list.map((item) => ({ item, score: scoreResult(item, normalisedQuery, tokens, normalisedQuery, pairs, distinctive, versionBoosts) }))
  scored.sort((a, b) => b.score - a.score)

  const taken = []
  const seenHosts = new Map()
  const overflow = []

  for (const entry of scored) {
    const host = hostOf(entry.item.url)
    if (hostCap > 0 && host) {
      const used = seenHosts.get(host) ?? 0
      if (used >= hostCap) {
        overflow.push(entry.item)
        continue
      }
      seenHosts.set(host, used + 1)
    }
    taken.push(entry.item)
    if (taken.length >= pool) break
  }

  return taken.concat(overflow)
}

/** Debug helper: the scores `rankResults` gives, highest first. */
export function rankScores(query, items) {
  const list = Array.isArray(items) ? items : []
  const tokens = tokenList(query)
  const pairs = tokenPairs(query)
  const distinctive = distinctiveTokens(tokens)
  const versionBoosts = buildVersionBoosts(list)
  const normalisedQuery = norm(query)
  return list
    .map((item) => ({ url: item.url, engine: item.engine, score: scoreResult(item, normalisedQuery, tokens, normalisedQuery, pairs, distinctive, versionBoosts) }))
    .sort((a, b) => b.score - a.score)
}
