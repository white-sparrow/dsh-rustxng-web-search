// Optional up-front engine fetch: `npm run engine` (or `node scripts/install-engine.mjs`).
//
// This package deliberately ships no install scripts, so a package manager never stops
// to ask whether it may run one: a published install is just files. The plugin
// downloads the engine itself on the first search; run this script when you would rather
// have the binary in place beforehand. It pulls the pinned RustXNG release for the
// current platform, verifies its sha256, and writes it to `bin/`. It exits 0 even when
// it fails, so it can never break a build.
//
// Knobs (all optional):
//   RUSTXNG_ENGINE=skip | RUSTXNG_ENGINE_SKIP=1   exit without doing anything
//   RUSTXNG_ENGINE_VERSION=0.24.0                  override the pinned release
//   RUSTXNG_ENGINE_REPO=owner/repo                use a fork's releases
//   RUSTXNG_ENGINE_PATH=<file>                  land somewhere else
//   --force                                           refetch even when present
//   --latest                                            take newest, not the pin

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { defaultDest, installedVersion, compareVersions, installEngine, PINNED_VERSION, REPO, assetSuffixes } from '../engine.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(HERE, '..')

const flags = process.argv.slice(2)
const force = flags.includes('--force')
const takeLatest = flags.includes('--latest')

const skipped = process.env.RUSTXNG_ENGINE === 'skip' || process.env.RUSTXNG_ENGINE_SKIP === '1'
const dest = process.env.RUSTXNG_ENGINE_PATH || defaultDest(PACKAGE_ROOT)
const repo = process.env.RUSTXNG_ENGINE_REPO || REPO
const want = takeLatest ? '' : process.env.RUSTXNG_ENGINE_VERSION || PINNED_VERSION

if (skipped) {
  console.log(`rustxng-web-search: engine install skipped (RUSTXNG_ENGINE=skip); the plugin will fetch ${dest} on first search`)
  process.exit(0)
}

if (!assetSuffixes().length) {
  console.error(`rustxng-web-search: no RustXNG asset mapping for ${process.platform}/${process.arch}; configure binaryPath yourself`)
  process.exit(0)
}

const current = installedVersion(dest)
if (!force && current.version && (!want || compareVersions(current.version, want) >= 0)) {
  console.log(`rustxng-web-search: engine already at ${current.version} (${current.source}); pin is ${want || 'latest'} — nothing to do`)
  process.exit(0)
}
if (current.version && current.source === 'metadata' && fs.existsSync(dest)) {
  console.log(`rustxng-web-search: refetching ${path.basename(dest)}: installed ${current.version}, wanted ${want || 'latest'}`)
}

try {
  const meta = await installEngine({
    destPath: dest,
    repo,
    version: want,
    checkTimeoutMs: 20_000,
    downloadTimeoutMs: 300_000,
    log: (message) => console.log(`rustxng-web-search: ${message}`),
  })
  console.log(`rustxng-web-search: engine ${meta.version} (${meta.asset}) ready at ${dest}`)
} catch (error) {
  console.error(`rustxng-web-search: could not install the engine: ${error instanceof Error ? error.message : String(error)}`)
  console.error('rustxng-web-search: continuing without it — the plugin downloads the same asset on first search, or run `node scripts/install-engine.mjs` once the network is reachable')
}
