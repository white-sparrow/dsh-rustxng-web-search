# dsh-rustxng-web-search

Key-free web search for DeepSeek Harness. The plugin runs
[RustXNG](https://github.com/sahenjp/RustXNG) — a SearXNG-style metasearch server
written in Rust — as a local child process and registers it as the Harness `web`
service's search provider. DSH's `web_search` and `web_fetch` tools can then be
used without a paid search API key or a search service that the user must operate.

**An internet connection is required.** RustXNG runs locally, but its upstream
search providers and the pages being fetched are reached over the internet.

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
session). The repository is public, so npm is not required.

| Source | Install spec |
| --- | --- |
| GitHub tag | `dsh-rustxng-web-search@github:white-sparrow/dsh-rustxng-web-search#vX.Y.Z` (replace with the tag shown on [Releases](https://github.com/white-sparrow/dsh-rustxng-web-search/releases)) |
| GitHub release tarball | Download `dsh-rustxng-web-search-X.Y.Z.tgz` from [Releases](https://github.com/white-sparrow/dsh-rustxng-web-search/releases) |
| npm package | `dsh-rustxng-web-search` (registry publication may lag behind GitHub releases) |
| Local checkout, for development | `<path>/rustxng-web-search` (pnpm links it) |

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
not exposed by this plugin.

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
- `ERR_PNPM_IGNORED_BUILDS` while installing → check that you are using a version
  that does not ship an install script; use the GitHub release tarball if unsure.

## Versioning

This project uses `MAJOR.MINOR.PATCH`:

| Part | Increment when | Example |
| --- | --- | --- |
| **MAJOR** | A breaking change to the DSH integration, tool contract, or required configuration | `2.0.0` |
| **MINOR** | A backward-compatible capability or meaningful user-facing integration improvement | `1.1.0` |
| **PATCH** | Bug fixes, documentation corrections, and small internal refinements that do not add a capability | `1.1.1` |

Do not use a patch increment for a new user-facing capability. In particular, a
meaningful RustXNG integration upgrade can justify a MINOR increment even when the
plugin's JavaScript API remains compatible.

## GitHub Releases

GitHub Releases are created by the **Release** GitHub Actions workflow. After
changes have been merged and are ready to publish:

1. Open the repository's **Actions** tab.
2. Select **Release**, then **Run workflow** on `master`.
3. Choose `patch`, `minor`, or `major`.

The workflow runs `npm run check` and `npm test`, increments the package version
according to the selected level, commits the version change to `master`, creates
the matching `vX.Y.Z` tag, runs `npm pack`, and publishes a GitHub Release with
generated release notes and the packed `.tgz` asset. It refuses to overwrite an
existing tag and can resume if a run stops after pushing the tag but before creating
the GitHub Release.

The workflow creates **GitHub Releases only**. It does not publish to the npm
registry. npm publication remains a separate, manually approved operation:

```
npm run stage                 # stage publish → prints the stage id
npm run stage:list            # inspect staged packages
npm run stage:approve <id>    # requires your 2FA code; run this yourself
```

The staging-only npm token remains in the gitignored `.env` (`NPM_TOKEN=<token>`,
see `.env.example`). `scripts/npm-auth.mjs` moves it into a throwaway owner-only
`.npmrc` that is deleted when the command returns. The token appears in no command
line, log, commit, or tarball.

## Verification status

The re-ranker is covered by assertions in `test/rank.mjs` (`npm test`) and has been
measured against live engine responses. The default engine pin is RustXNG `0.24.0`;
it has not yet been exercised end to end in the Harness runtime. The download-resume
path has not been tested through a deliberately interrupted download, and the chip
tooltip has not been browser-verified. Re-ranking cannot recover pages that blocked
upstream engines never returned — see `lastSearch.blockedCount` in `GET engine`.
