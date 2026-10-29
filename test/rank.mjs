// Assertions for the re-ranking this plugin applies to RustXNG's merged results.
// Run with `npm test`. Not shipped in the package tarball.

import { rankResults, rankScores } from '../rank.mjs'

const results = []
let failed = 0

function check(name, condition) {
  results.push({ name, ok: Boolean(condition) })
  if (!condition) failed += 1
}

const host = (list) => list.map((r) => new URL(r.url).hostname)

// The shape this machine actually produced: five engines' unrelated #1 hits,
// then the repository the query was about. Scores are the engine's own
// (1 for the first hit of every engine, decreasing after that).
const junk = [
  { engine: 'duckduckgo', score: 1, title: 'Rustxng - DeepSeek Harness plugin', url: 'https://dsh.so/artifact/dsh-rustxng/', content: 'catalog listing' },
  { engine: 'bing', score: 1, title: 'forum.konkur.in', url: 'https://forum.konkur.in/', content: '' },
  { engine: 'mwmbl', score: 1, title: 'Latest Release of Back-End CMS', url: 'http://lwn.net/Articles/86732/', content: 'latest release' },
  { engine: 'seznam', score: 1, title: 'Download Cinebench', url: 'https://cinebench.com.co/', content: 'download free' },
  { engine: 'quark', score: 1, title: 'SearXNG', url: 'https://baike.baidu.com/item/SearXNG/67642035', content: 'SearXNG' },
  { engine: 'duckduckgo', score: 0.5, title: 'Rust Versions', url: 'https://releases.rs/', content: 'rust versions' },
  { engine: 'duckduckgo', score: 0.5, title: 'sahenjp', url: 'https://github.com/sahenjp', content: 'Sahen on GitHub' },
  { engine: 'swisscows', score: 0.25, title: 'GitHub - sahenjp/RustXNG: SearXNG-compatible metasearch engine written in Rust', url: 'https://github.com/sahenjp/RustXNG', content: 'metasearch' },
  { engine: 'swisscows', score: 0.2, title: 'Release RustXNG v0.4.1', url: 'https://github.com/sahenjp/RustXNG/releases/tag/v0.4.1', content: 'RustXNG v0.4.1 release' },
  { engine: 'swisscows', score: 0.1, title: 'Unrelated', url: 'https://example.com/x', content: '' },
]

const query = 'RustXNG sahenjp latest release version'
const ranked = rankResults(query, junk, { hostCap: 3 })

check('re-ranking keeps every result (nothing dropped)', ranked.length === junk.length)
check('a page of the repository itself leads the list, not an unrelated site', ranked[0].url.includes('github.com/sahenjp/RustXNG'))
check('the project home page is still in the first five', ranked.slice(0, 5).some((r) => r.url === 'https://github.com/sahenjp/RustXNG'))
// Two pages of the same project that differ only in the version they name: the
// newer one must win when the query asks about versions.
const versioned = [
  { engine: 'bing', score: 1, title: 'Release RustXNG v0.2.0', url: 'https://github.com/sahenjp/RustXNG/releases/tag/v0.2.0', content: 'RustXNG v0.2.0 release notes' },
  { engine: 'bing', score: 1, title: 'Release RustXNG v0.4.1', url: 'https://github.com/sahenjp/RustXNG/releases/tag/v0.4.1', content: 'RustXNG v0.4.1 release notes' },
]
check('the newer release page outranks the older one', rankResults('RustXNG release version', versioned, { hostCap: 3 })[0].url.includes('v0.4.1'))
check('a query that does not ask about versions is not reordered by version', rankResults('RustXNG notes', versioned, { hostCap: 3 })[0].url.includes('v0.2.0'))
check('all four repository/release hits stay in the first three', ranked.slice(0, 3).some((r) => r.url.includes('/releases/tag/v0.4.1')))
const junkIndex = ranked.findIndex((r) => r.url.includes('baike.baidu.com'))
const repoIndex = ranked.findIndex((r) => r.url === 'https://github.com/sahenjp/RustXNG')
check('the Chinese wiki page is pushed below the repository', junkIndex > repoIndex)
check('the engine order did have it at index 7, proving the reorder', junk[7].url.includes('sahenjp/RustXNG'))
check('hostCap keeps at most 3 github.com results ahead of the overflow', host(ranked).filter((h) => h === 'github.com').length === 3)
check('overflow keeps the same relative order', host(ranked).join(',').includes('github.com'))

// A host cap of 1 must not lose results either.
const capped = rankResults(query, junk, { hostCap: 1 })
check('hostCap=1 still returns everything', capped.length === junk.length)
check('hostCap=1 leads with one github.com result', host(capped)[0] === 'github.com')

// Script penalty only applies to Latin-script queries: the same page is fine
// for a query written in that page's own script.
const cjkTitle = 'RustXNG \u97ed\u54f8 \u6600\u5500' // CJK characters, not Latin accents
const mixed = [
  { engine: 'quark', score: 1, title: cjkTitle, url: 'https://baike.baidu.com/item/x', content: cjkTitle },
  { engine: 'bing', score: 1, title: 'RustXNG metasearch engine', url: 'https://github.com/sahenjp/RustXNG', content: 'metasearch engine' },
]
check('a Latin query demotes the CJK page', rankResults('RustXNG', mixed, { hostCap: 3 })[0].url.includes('sahenjp'))
check('a CJK query keeps the CJK page first', rankResults(`RustXNG \u97ed\u54f8`, mixed, { hostCap: 3 })[0].url.includes('baike'))

// Degenerate inputs.
check('no results in, no results out', rankResults('anything', [], {}).length === 0)
check('empty query still returns the pool', rankResults('', junk, { hostCap: 3 }).length === junk.length)
check('null-ish inputs are tolerated', rankResults('q', null, {}).length === 0)

// The debug helper agrees with the reorder and is sorted.
const scored = rankScores(query, junk)
check('rankScores is sorted descending', scored.every((entry, i) => i === 0 || scored[i - 1].score >= entry.score))

console.log(`test/rank.mjs: ${results.length} checks, ${failed} failed`)
results.forEach((entry) => console.log(`  ${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.name}`))
process.exit(failed ? 1 : 0)
