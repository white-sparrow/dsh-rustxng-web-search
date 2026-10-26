/**
 * Run an npm registry command for this package using the token in `.env`.
 *
 * Why this exists: the access token is deliberately limited to the npm staging
 * area, so a plain `npm publish` is rejected (E_STAGE_REQUIRED) and `npm stage
 * publish` is the intended path. `npm stage` needs npm 11+, this machine ships
 * npm 10.x, and `npx npm@11 -- stage publish …` misroutes its arguments, so the
 * helper installs npm under `.npm-tools/` (gitignored) and runs its `npm-cli.js`
 * through node, which parses flags correctly.
 *
 * The token is written into a throwaway owner-only `.npmrc` in the temp directory
 * for the duration of the command and deleted afterwards — npm ignores `${VAR}`
 * interpolation in `--userconfig`, so the value has to be literal there. Nothing
 * here prints the token: it appears in no command line, no npm output, no commit,
 * and no tarball.
 *
 * Approval of a staged version is proof-of-presence and asks for a 2FA code, so
 * that step belongs to the package owner, not to this helper:
 *
 *   node scripts/npm-auth.mjs stage publish      # stage this package version
 *   node scripts/npm-auth.mjs stage list         # what is waiting
 *   node scripts/npm-auth.mjs stage view <id>    # inspect one stage
 *   npm run stage:approve <id>                  # asks for your 2FA code
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

/** Registry the commands talk to, and the npm version that knows `stage`. */
const REGISTRY = 'https://registry.npmjs.org/'
const NPM_VERSION = '11.21.1'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TOOLS = join(ROOT, '.npm-tools')
const CLI = join(TOOLS, 'node_modules', 'npm', 'bin', 'npm-cli.js')

/**
 * Read one key from a `.env` file, tolerating quotes, comments, and CRLF.
 * @param name - the key to find.
 * @returns the value, or an empty string when absent or blank.
 */
function fromDotEnv(name) {
  let text = ''
  try {
    text = readFileSync(join(ROOT, '.env'), 'utf8')
  } catch {
    return ''
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 0) continue
    if (line.slice(0, separator).trim() !== name) continue
    return line.slice(separator + 1).trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
  }
  return ''
}

/**
 * Major version of the npm on PATH, so a machine already on npm 11+ needs no
 * local copy.
 * @returns the major number, or 0 when npm cannot be probed.
 */
function localNpmMajor() {
  const probe = spawnSync('npm', ['-v'], { encoding: 'utf8', shell: process.platform === 'win32' })
  const major = Number.parseInt((probe.stdout ?? '').trim().split('.')[0], 10)
  return Number.isFinite(major) ? major : 0
}

const argv = process.argv.slice(2)
if (argv.length === 0) {
  console.error('usage: node scripts/npm-auth.mjs <npm command> [args…]')
  console.error('  stage publish | stage list | stage view <id> | stage approve <id> | publish')
  process.exit(1)
}

const token = process.env.NPM_TOKEN || fromDotEnv('NPM_TOKEN')
if (!token) {
  console.error('NPM_TOKEN is not set. Copy .env.example to .env and fill it in, or export it.')
  console.error('A staging-only Granular Access Token is enough for `stage publish`.')
  process.exit(1)
}

// npm 11+ on PATH can run `stage` itself; otherwise use the pinned local copy.
const major = localNpmMajor()
if (major < 11 && !existsSync(CLI)) {
  console.log(`installing npm ${NPM_VERSION} under .npm-tools/ (first run only)`)
  const install = spawnSync('npm', [
    'i', '--prefix', TOOLS, `npm@${NPM_VERSION}`,
    '--silent', '--no-save', '--no-audit', '--no-fund', '--no-package-lock', '--no-progress',
  ], { stdio: 'inherit', shell: process.platform === 'win32', cwd: ROOT })
  if (install.status !== 0 || !existsSync(CLI)) {
    console.error(`could not install npm ${NPM_VERSION}; run: npm i --prefix .npm-tools npm@${NPM_VERSION}`)
    process.exit(install.status ?? 1)
  }
}

// Owner-only, outside the project, gone as soon as the command returns.
const dir = mkdtempSync(join(tmpdir(), 'dsh-npm-auth-'))
const npmrc = join(dir, '.npmrc')
writeFileSync(npmrc, `registry=${REGISTRY}\n//registry.npmjs.org/:_authToken=${token}\n`, { mode: 0o600 })

const flags = ['--registry', REGISTRY, '--userconfig', npmrc]
const useLocal = major >= 11
const runner = useLocal ? 'npm' : 'node'
const args = useLocal ? [...argv, ...flags] : [CLI, ...argv, ...flags]
// `process.exit()` inside `try` would skip `finally`, so record the status and
// exit only after the throwaway credential is gone.
let status = 1
try {
  const result = spawnSync(runner, args, {
    stdio: 'inherit',
    cwd: ROOT,
    shell: useLocal && process.platform === 'win32',
  })
  status = result.status ?? 1
} finally {
  rmSync(dir, { recursive: true, force: true })
}
process.exit(status)
