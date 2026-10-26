# rustxng-web-search

A DSH (DeepSeek Harness) plugin that gives the chat box **key-free web search**. It runs
[RustXNG](https://github.com/sahenjp/RustXNG) — the Rust rewrite of SearXNG — as a local
metasearch server and registers it as the `web` service's search provider. No API key, no
hosted service, nothing to sign up for.

**The engine binary is not shipped in this package.** `bin/` is git-ignored and filled by
downloading an upstream release asset (pinned to `v0.4.1` by default). Upstream is
AGPL-3.0-or-later, so redistribution is upstream's job, not this package's; each download
records its provenance (repo, tag, asset, bytes, sha256) in `bin/rustxng.json` next to the
binary it installed.

## What it does

| Layer | Change |
| --- | --- |
| `index.js` | Registers a `WebSearchProvider` with id `rustxng` on `ctx.web`, spawns the server lazily on first search (`GET /search?q=…&format=json`), keeps the engine current, serves this plugin's routes under `/rustxng-web-search`, and gates the tools per session. |
| `engine.mjs` | Release resolution, asset pick, download, verification — shared by install time and runtime. |
| `scripts/install-engine.mjs` | `postinstall` fetch; never fails an install, because the runtime downloads the same asset if this step is skipped. |
| `client.js` | The chat-box half: a **Web search switch** chip in `conversation.input.left`, whose tooltip names the engine behind it. |
| `cordis.patch.yml` | Inserts the plugin; pins `web` → `searchProvider: rustxng` + `fetchProvider: http`; forces the built-in `tool-web` row (model-facing `web_search` / `web_fetch`) enabled. |
| `bin/` | Created at install or on first search: `rustxng(.exe)` plus `rustxng.json`. Never committed, never published. |

Because the provider id is pinned in `web` config, DSH always selects this provider even when
the built-in `web-search-deepseek` provider is also loaded — that one needs
`DEEPSEEK_API_KEY`; this one needs nothing.

## Engine supply

- **Source**: `https://api.github.com/repos/<engineRepo>/releases/…`, default repo
  `sahenjp/RustXNG`. `engineVersion: "0.4.1"` asks `releases/tags/v0.4.1`; `engineVersion: ""`
  asks `releases/latest`.
- **Asset for this platform/arch**, by target-triple suffix (Node `x64` → `x86_64`, Node
  `arm64` → `aarch64`):

  | Platform | Asset suffix searched, in order |
  | --- | --- |
  | `win32` | `<arch>-pc-windows-msvc.exe` |
  | `darwin` | `<arch>-apple-darwin` |
  | linux | `<arch>-unknown-linux-gnu`, then `<arch>-unknown-linux-musl` |

  Asset sets differ per release (older RustXNG releases ship linux only), and upstream has
  no `aarch64-pc-windows-msvc.exe`, so Windows on ARM has nothing to fetch. When nothing
  matches, the plugin logs that and leaves `autoDownload` / `autoUpdate` inert: point
  `binaryPath` at a binary you placed yourself.
- **Verified before it is installed**: the release asset's own `digest` field (`sha256:…`) is
  compared, and the byte size must match what the release advertises
  (`verifiedBy: "release digest"`). A mismatch installs nothing.
- **Atomic**: bytes stream into `bin/rustxng.exe.part-<pid>-<random>`, and a single rename puts
  the binary in place, so a half-written engine is never run. Leftover `.part-*` files from an
  earlier attempt are swept first; on Windows a part file whose handle is still open is skipped
  rather than reused (reusing one caused an `EPERM` failure before).
- **Interruptions**: a stalled or cut-short pass reports how far it got
  (`connection closed after N of M bytes`) and resumes from that byte with a `Range` request —
  the release CDN answers 206 with `content-range` — up to 8 resume passes by default.
- **Windows**: the running server child is stopped and awaited before the rename, because
  renaming over a running `.exe` is denied.
- **Metadata** (`bin/rustxng.json`): `version`, `versionSource`, `tag`, `repo`, `asset`,
  `bytes`, `sha256`, `verifiedBy`, `url`, `installedAt`, `lastCheckAt`, `latestSeen`,
  `latestTag` — so reopening the Host does not re-hit the release API on a rate limit.
- **Auto-update loop**: at activation one check runs unless the last check was under 10 minutes
  ago; afterwards a check is scheduled every `updateIntervalMs`, counted from the check that
  already happened (floored at 1 minute). An update checks upstream, stops the server, installs
  the newer asset, and the next search starts the new binary. A failed check or download leaves
  the working binary untouched, and a newer release with no asset for this platform is reported
  rather than fatal. `POST /rustxng-web-search/update` forces one pass now.

## Install

The `dsh` CLI is not on `PATH` in this environment, so the plugin is installed through the
harness `plugin_manager` tool: `install_bundle` with `target` = this directory. A local install
**links** the checkout (no copy), so this folder is the live source of the plugin.

Keep this folder in place: moving or deleting it breaks the plugin. To make the plugin survive
a move, install from a copy outside the workspace instead.

A local install did **not** run `postinstall` here (observed: no `pendingBuilds` for a `link:`
install), which is fine — the first search downloads the same verified asset. To pre-fill it
from the command line: `node scripts/install-engine.mjs` (add `--force` to replace, `--latest`
to follow upstream instead of the pin). Set `RUSTXNG_ENGINE=skip` or `RUSTXNG_ENGINE_SKIP=1` to
skip it deliberately.

## Configuration (all optional)

The plugin activates with `config: {}`. Every knob has a code default:

| Key | Default | Notes |
| --- | --- | --- |
| `binaryPath` | `bin/rustxng(.exe)` next to `index.js` | Point elsewhere to reuse an existing RustXNG build; then `autoDownload` / `autoUpdate` still apply to this path. |
| `bindAddress` | `127.0.0.1` | Loopback only. |
| `port` | `8888` | Change if the port is already in use; a clash surfaces as `RustXNG exited early (code N); check the configured port`. |
| `searchTimeoutMs` | `30000` | Per-call timeout for one `web_search` query. |
| `defaultEnabled` | `true` | Starting state of the chat-box switch. Set `false` to ship with web search off. |
| `engineRepo` | `sahenjp/RustXNG` | Fork or mirror to fetch from. |
| `engineVersion` | `0.4.1` | Pin a release; `""` means follow `releases/latest`. |
| `autoDownload` | `true` | Fetch the engine on first search when it is missing. |
| `autoUpdate` | `true` | Keep the engine current after activation. |
| `updateIntervalMs` | `21600000` (6 h) | Range 1 minute .. 5 days. |
| `downloadTimeoutMs` | `180000` | Quiet-spending budget per download pass; range 5 s .. 1 h. |
| `checkTimeoutMs` | `15000` | Timeout for one release-API request; range 1 s .. 2 min. |

RustXNG's CLI accepts only `-c/--config`, `-b/--bind`, `-p/--port`, `-v`, `-h`, so bind address,
port, and this plugin's own client-side timeout are the only knobs available without writing a
RustXNG settings file. Resume passes (8) and the 10-minute activation grace are fixed in code.

## Web search switch

The chip in the chat box is a **per-session toggle, on by default**. Switching it off calls
`ctx.tools.restrict({ deny: ['web_search','web_fetch'] })` on that session's Agent context, so
the model can no longer see or call the tools; switching it on disposes the restriction. This
is the weakest mechanism the harness offers for the job (it can only remove tools, so it
cannot rewrite what other plugins contribute), and the harness documents it as exactly the way
to hide tools from one Agent.

- A session already running when this plugin activates is reached through
  `sessionController.resolveAgent(sessionId)` on the first switch click, so the click works
  without a restart.
- Agents created later (`agent/created`) are gated or left alone from the same table.
  `sessionOverrides` is in-memory: state resets to the default on a plugin reload, and a
  resume/fork drops that session's override. Subagents inherit `defaultEnabled`, not a
  per-session override.
- `tools.get(name)` and `tools.schemas()` read the **global** registry: they keep reporting
  both tools while the mask is live, so they cannot verify the switch. The authoritative read
  is the Agent's own callable tool list (`cordis_inspect_query` → host provider `Tool`, method
  `listTools`), which drops `web_search` / `web_fetch` while off and restores them while on —
  measured both ways.
- `deny` is filtered through `tools.get(name)` first, because `restrict` rejects unknown names
  — that keeps activation working if the `tool-web` row is disabled by another layer.
- The tooltip line is built from the engine block the Host already returns: version, whether
  it is `running` or `starts on first search`, a `newer <version> pending`, or a
  `not downloaded yet` note. Nothing about the engine is guessed in the browser.

## HTTP routes

All under `/rustxng-web-search`, registered on `ctx.webServer` and disposed with the plugin.

| Route | Method | Body / answer |
| --- | --- | --- |
| `state` | GET | Switch state; `?session=<id>` adds `enabled` / `configured` for that session, no `session` returns the whole override table. Both include the engine block. |
| `engine` | GET | Disk-and-memory-only engine summary; feeds the chip tooltip. |
| `version` | GET | The same plus a live upstream check: `latest`, `tag`, `publishedAt`, `updateAvailable`, `bytes`. |
| `probe?query=…&max=2` | GET | End-to-end self test through the `web` service, exactly as the model-facing tool does. |
| `debug` | GET | Per-Agent gate view (`gated`, `probe`), service shapes, override table. |
| `tools` | GET | Gated tool names and the default. |
| `set` | POST | `{sessionId, enabled}` → writes an override and re-adopts that Agent. |
| `clear` | POST | `{sessionId}` → drops the override, back to the default. |
| `update` | POST | `{}` → one forced engine update pass (`{ok, updated, from, to, asset, bytes, sha256, restart}` or `{ok:false, error}`). |

Guards: every request must pass `isSameOrigin` (loopback host, or the browser reporting
`sec-fetch-site: same-origin|none`), and mutating routes must pass `fromPage`. A CLI request that
sends neither header passes both, which is why these routes are drivable from
`Invoke-WebRequest`; a cross-site browser request is refused with 403.

## Notes

- One server process is reused across searches; it is killed when the plugin's fiber disposes
  (session stop / plugin disable). A failed start is retried on the next search.
- The server is spawned with `stdio: 'ignore'` — no named pipes, which keeps it clear of the
  Windows sandbox's stdio boundary.
- `available()` reports true when the binary exists **or** the engine is auto-downloadable, so
  provider auto-selection cannot fail with `WEB_PROVIDER_UNAVAILABLE` before the first search
  fills the gap; the search path still handles start-up and HTTP failures with actionable
  messages.
- `Config` is a hand-rolled Standard Schema (`Config['~standard'].validate`). A raw JSON Schema
  object crashes activation with `Cannot read properties of undefined (reading 'validate')`, and
  `@deepseek-ai/schemastery` cannot be imported from a locally linked bundle because Node
  resolves imports from this checkout, not from the profile's `node_modules`. Runtime code uses
  Node builtins only, plus the local `./engine.mjs`.
- Patch row `web` restates **both** `searchProvider` and `fetchProvider`: a patch replaces a
  row's `config` wholesale, and omitting `fetchProvider` makes `web_fetch` fail with
  `WEB_PROVIDER_AMBIGUOUS` once `deepseek-fetch-api` and `http` are both registered.
- Only English locale metadata is shipped (`locale/en.json`).
- Known limitation: the Settings page reports this plugin's config schema as `unsupported`
  (`Config.listConfigs`, entry `include:rustxng-web-search`), because a hand-rolled Standard
  Schema cannot be projected into an editable form. Validation and defaults still work; change
  values by editing the row's `config` in a patch layer, e.g. `config: { port: 9123 }`.
- The Web search settings switch writes a `web` row into the **profile** patch, a HIGHER layer
  than this bundle's patch. If that switch is used, it wins over the pin here; re-assert
  `searchProvider: rustxng` + `fetchProvider: http` in the profile patch to keep this provider.
- The model learns about `web_search` / `web_fetch` from the shipped `dsh-tool-web` plugin's
  own system-prompt section: this bundle only forces that row on, so the wording is the
  harness's, not a prompt invented here.
- The release API is rate-limited without credentials, so the last check and the last seen
  release are persisted in `bin/rustxng.json`; network failure never breaks search.

## Publish checklist

1. Rename the package from `@local/rustxng-web-search` to your scope and delete `"private":
   true`. Choose a license for this package yourself — AGPL-3.0-or-later covers the upstream
   engine, which this package does not contain.
2. Keep three identifiers aligned, all equal to the new package name: the patch row's `name`,
   the package name, and the client factory id (`window.__ModuleLoader__.load({ id: … })`) in
   `client.js`. They match today on purpose.
3. `files` ships `index.js`, `client.js`, `engine.mjs`, `cordis.patch.yml`,
   `scripts/install-engine.mjs`, `locale/*.json`, `icon.svg` — `bin/` is never published, which
   is what keeps the tarball small and the AGPL question out of your hands.
4. `postinstall` runs only where install scripts are allowed: `plugin_manager` reports such a
   package in `pendingBuilds` and installs it once the user approves by passing that name in
   `approvedBuilds`. If it is skipped, the plugin downloads on first search instead, so the
   published plugin needs no build-script permission at all.

## Verified (live, against the running harness)

- Provider end to end: `GET /rustxng-web-search/probe?max=1` → `{"ok":true,"sources":1,…}` with
  real URLs; model turns returned real sources, including a mapped `publishedAt`.
- Engine download from scratch in the Host: `POST /rustxng-web-search/update` →
  `{"ok":true,"updated":true,"from":"0.4.0","to":"0.4.1","bytes":22808064,"sha256":"8fd4ab8db313…",
  "restart":"the next search starts the new engine"}`. On disk `bin/rustxng.exe` is 22808064 bytes
  and `Get-FileHash` returns exactly the digest upstream published; `bin/rustxng.json` records
  `verifiedBy: "release digest"`.
- Install-time path, standalone: `node scripts/install-engine.mjs --latest` into a scratch path
  → exit 0, same size and digest.
- Auto-update scheduling after a reinstall: `GET /engine` reports
  `"updater":{"scheduled":true,"immediateCheck":true,…}`, `lastCheckAt` refreshed,
  `note: "engine 0.4.1 is the newest sahenjp/RustXNG release (0.4.1)"`, and
  `"provider":{"registered":true,"error":""}`. When the last check is recent the immediate
  check is skipped by design and the reason is shown.
- Search still works through the replaced binary: `web_search` returned eight sources and
  `GET /engine` then shows `"running":true` with the freshly spawned child process.
- Switch off → `Tool.listTools` for that session lists no `web_search` / `web_fetch`; switch
  on → both present, and the debug route reports `gated: true / probe: "web search denied…"`
  then `gated: false / probe: "idle"`. Reinstalling clears the override table, so sessions fall
  back to `defaultEnabled: true`.
- Chat-box chip: Client `Slots.listSubTree { root: "conversation.input.left" }` shows occupant
  `id: "rustxng-web-search"`, `order: 5`, `active: true`, and the chip was confirmed on the
  page.
- Not verified: the resume path end-to-end (every download in the Host and in standalone probes
  completed in a single pass; only the 206 / `content-range` support it relies on was measured
  against the release CDN), and how the tooltip line looks on the page.
