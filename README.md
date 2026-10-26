# rustxng-web-search

A DSH (DeepSeek Harness) Host plugin that gives the chat box **key-free web search**.
It bundles the Rust rewrite of SearXNG — rustxng v0.4.0
(`D:\Downloads\rustxng-v0.4.0-x86_64-pc-windows-msvc.exe`, copied in) — as
`bin/rustxng.exe`, spawns it as a local HTTP server, and registers it as the `web`
service's search provider. No API key, no external service, no extra runtime dependency.

## What it does

| Layer | Change |
| --- | --- |
| `bin/rustxng.exe` | Bundled metasearch binary (v0.4.0, 169 engines). |
| `index.js` | Spawns the server lazily on first search and registers a `WebSearchProvider` with id `rustxng` on `ctx.web`. Queries `GET /search?q=...&format=json`. |
| `cordis.patch.yml` | Inserts the plugin; pins `web` → `searchProvider: rustxng`; forces the built-in `tool-web` row (the model-facing `web_search` / `web_fetch` tools) enabled. |

Because the provider id is pinned in `web` config, DSH always selects this provider even when
the built-in `web-search-deepseek` provider is also loaded — that provider needs
`DEEPSEEK_API_KEY`; this one needs nothing.

## Install

In this session the `dsh` CLI is not on `PATH`, so the plugin is installed through the
harness `plugin_manager` tool: `install_bundle` with `target` = this directory. A local
install **links** the checkout (no copy), so this folder is the live source of the plugin.

Keep this folder in place: moving or deleting it breaks the plugin. To make the plugin
survive a move, install from a copy outside the workspace instead.

## Configuration (all optional)

The plugin activates with `config: {}`. Every knob has a code default:

| Key | Default | Notes |
| --- | --- | --- |
| `binaryPath` | `bin/rustxng(.exe)` next to `index.js` | Point elsewhere to reuse an existing rustxng build. |
| `bindAddress` | `127.0.0.1` | Loopback only. |
| `port` | `8888` | Change if the port is already in use. |
| `requestTimeoutMs` | `20000` | Timeout for a single upstream engine inside rustxng. |
| `searchTimeoutMs` | `30000` | Per-call timeout for one `web_search` query. |

## Notes

- One server process is reused across searches; it is killed when the plugin's fiber
  disposes (session stop / plugin disable). A failed start is retried on the next search.
- The server is spawned with `stdio: 'ignore'` — no named pipes, which keeps it clear of
  the Windows sandbox's stdio boundary.
- `available()` is just an existence check for the binary; the search path handles
  start-up and HTTP failures with actionable messages.
- Only English locale metadata is shipped (`locale/en.json`).
