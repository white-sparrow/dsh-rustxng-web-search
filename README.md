# dsh-rustxng-web-search

Key-free web search for DeepSeek Harness. The plugin runs
[RustXNG](https://github.com/sahenjp/RustXNG) — a SearXNG-style metasearch server
written in Rust — as a local child process and registers it as the Harness `web`
service's search provider, so `web_search` and `web_fetch` work with **no API key**
and no external service.

RustXNG is AGPL-3.0-or-later. Its binary is **not** shipped in this package or this
repository: it is downloaded from upstream's GitHub releases at install time (or on
the first search), verified against the published sha256, and stored in `bin/`.

## What you get

- A **Web search** chip on the left of the composer tool row. Click it to turn web
  search off for the current session; click again to turn it back on. Default is
  on; a resumed or forked session starts from the default again. Turning it off
  hides `web_search` and `web_fetch` from that session's tools, so the model cannot
  reach them.
- Search results with real source URLs, served from `127.0.0.1:<port>`.
- A tooltip on the chip with the engine version, whether it is running, and a
  newer release when one is pending.

## Install

Any of these installs the same bundle; the repository is public, so you do not need
npm to use it:

```
dsh plugin install dsh-rustxng-web-search
dsh plugin install dsh-rustxng-web-search@gh:white-sparrow/dsh-rustxng-web-search
dsh plugin install ./dsh-rustxng-web-search-1.0.0.tgz
```

The first resolves the published npm package, the second builds from this repository
at the `v1.0.0` tag, and the third installs the tarball attached to the GitHub release.

`postinstall` fetches the engine. If that step is skipped (a linked checkout, a blocked
build script, a blocked network), the first search fetches the same asset instead — the
plugin never searches without a verified binary.

Set `RUSTXNG_ENGINE=skip` to opt out of the install-time download; run `npm run engine`
later to fetch it manually (`--force` to re-download, `--latest` to pick the newest
release).

## Engine supply

| Step | Behaviour |
| --- | --- |
| Asset | `<asset>` = `rustxng-v<tag>-<arch>-pc-windows-msvc.exe` on Windows, `…-apple-darwin` on macOS, `…-unknown-linux-gnu` (else `-musl`) on Linux. Upstream publishes no `aarch64-pc-windows-msvc.exe`, so Windows on ARM has nothing to fetch. |
| Verify | sha256 against the release digest, then exact byte count. |
| Place | Written to `bin/rustxng.part-<pid>-<random>`, then renamed into place. On Windows the running engine is stopped before its own file is replaced. |
| Resume | An interrupted download resumes with a `Range` request (up to 8 passes). |
| Update | Every `updateIntervalMs` the plugin checks upstream, and also on activation once the installed copy is older than 10 minutes. A newer asset replaces the binary; the next search starts the new engine. A failed check leaves search working. |

Installed metadata lives in `bin/rustxng.json`. Nothing in `bin/` is committed or
published.

## Config

All keys optional; the patch in `cordis.patch.yml` ships `config: {}`.

`binaryPath`, `bindAddress` (`127.0.0.1`), `port` (`8888`), `searchTimeoutMs`
(`30000`), `defaultEnabled` (`true`), `engineRepo` (`sahenjp/RustXNG`),
`engineVersion` (pinned `0.4.1`), `autoDownload` (`true`), `autoUpdate` (`true`),
`updateIntervalMs` (`21600000` = 6 h), `downloadTimeoutMs` (`180000`),
`checkTimeoutMs` (`15000`).

Unknown keys are rejected at load with the expected list.

## Control routes

The plugin serves a small HTTP surface under `/rustxng-web-search` on the Harness
port, used by the Client chip and for troubleshooting: `GET engine` (same payload
the tooltip shows), `GET version`, `GET state?session=<id>`, `GET tools`, `GET probe?query=…`,
`GET debug`, `POST set` / `POST clear` (the switch), `POST update`. Write routes
accept only requests that do not look foreign — the page's own transport, or a
local process — because that transport does not carry `Origin` or `Sec-Fetch-Site`.

## Troubleshooting

- `RustXNG exited early (code N)` → port collision; set `port`.
- Search still works with the engine unreachable → expected; the installed binary
  keeps being used, and `GET engine` shows the error in `note` / `error`.
- No asset for your platform/arch → `GET engine` reports it in `target`; set
  `binaryPath` to a binary you supply yourself.

## Publishing

The plugin is published in two ways: the npm package (staged, then approved) and this
public repository — tag `v1.0.0` plus a GitHub release carrying
`dsh-rustxng-web-search-1.0.0.tgz`, which is exactly what `npm pack` produces.

The package is staged for publishing with a **staging-only** Granular Access Token
kept in the gitignored `.env` (`NPM_TOKEN=<token>`, see `.env.example`).

```
npm run stage            # stage publish → prints the stage id
npm run stage:list       # what is waiting
npm run stage:approve <stage-id>   # needs your 2FA code: run this yourself
```

`scripts/npm-auth.mjs` installs npm 11.21.1 under the gitignored `.npm-tools/`
(the machine's npm 10.x has no `stage` command) and moves the token from `.env`
into a throwaway owner-only `.npmrc` that is deleted when the command returns.
The token appears in no command line, log, commit, or tarball.

## Verified

Switch off hides both tools for that session and on restores them (checked against
the live Agent tool list); search returns real sources after a cold start; the
engine downloaded from GitHub matches upstream's published sha256; the updater
replaced 0.4.0 with 0.4.1 through a live release. Not checked: the download-resume
path end to end (no interruption has been long enough to need it) and how the chip
tooltip looks in a browser.
