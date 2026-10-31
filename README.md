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

Open the Plugin Manager (in the Harness UI, or with the `plugin_manager` tool from a
session) and install one of these. The repository is public, so npm is not required:

| Source | Install spec |
| --- | --- |
| npm package (once the stage is approved) | `dsh-rustxng-web-search` |
| This repository at tag `v1.0.2` | `dsh-rustxng-web-search@github:white-sparrow/dsh-rustxng-web-search#v1.0.2` |
| A packed tarball — the asset on the release | `<path>/dsh-rustxng-web-search-1.0.2.tgz` |
| A local checkout, for development | `<path>/rustxng-web-search` (pnpm links it) |

The package runs **no install scripts**, so installing is only copying files: the first
search downloads the engine into `bin/` beside the installed copy and verifies its
sha256. Run `npm run engine` when you want the binary up front (`--force` re-downloads,
`--latest` takes the newest release); `RUSTXNG_ENGINE=skip` opts out of that script
entirely.

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
`engineVersion` (pinned `0.24.0`; `""` follows the newest release), `autoDownload`
(`true`), `autoUpdate` (`true`), `updateIntervalMs` (`21600000` = 6 h),
`downloadTimeoutMs` (`180000`), `checkTimeoutMs` (`15000`).

The default engine pin is RustXNG `0.24.0`. Local indexing is deliberately not
configured or enabled by this plugin; upstream treats it as experimental, so the
plugin continues to use metasearch results by default. Per-engine proxy settings are
not yet exposed by this plugin; configure them only after adding an explicit settings
file integration and supplying the proxy endpoints you intend to use.

Search quality: `searchLanguage` (`en`), `safesearch` (`1`), `resultPool` (`40`),
`hostCap` (`5`), `includeDomains` (`""`), `excludeDomains` (`""`). The plugin asks
the engine for a wide pool and re-ranks it before slicing, because RustXNG scores
every engine's first hit exactly `1.0` — its own order is one arbitrary hit per
engine — so `rank.mjs` orders by query agreement, host diversity, and, for version
queries, release recency.

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
- Results look off-topic → the engine reports how many upstream engines it
  blocked or timed out in `GET engine` → `lastSearch.blockedCount`; that is where
  thin pools come from. Narrow with `includeDomains`, or widen `resultPool`.
- `ERR_PNPM_IGNORED_BUILDS` while installing → you resolved npm `1.0.0`, which shipped
  an install script; take `1.0.1` or later, or install from this repository's tag instead.

## Publishing

The plugin is published in two ways: the npm package (staged, then approved) and this
public repository — the current tag `v1.0.2` plus a GitHub release carrying
`dsh-rustxng-web-search-1.0.2.tgz`, which is what `npm pack` produces. npm currently
serves `1.0.0` and `1.0.1`; `1.0.2` waits in staging for its approval. Each tag
marks the commit it names.

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
replaced 0.4.0 → 0.4.1 and later 0.4.1 → 0.6.1 through live releases. The default
pin is now RustXNG 0.24.0; this newer release has not yet been exercised end to end
in the Harness runtime. The re-ranker
is covered by 18 assertions in `test/rank.mjs` (`npm test`) and was measured against
live engine responses, where it moved the requested project's release pages from
index 9-10 to the top. Not checked: the download-resume path end to end (no
interruption has been long enough to need it) and how the chip tooltip looks in a
browser. Re-ranking cannot recover pages that blocked upstream engines never
returned — see `lastSearch.blockedCount` in `GET engine`.
