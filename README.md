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
| `cordis.patch.yml` | Inserts the plugin; pins `web` → `searchProvider: rustxng` + `fetchProvider: http`; forces the built-in `tool-web` row (the model-facing `web_search` / `web_fetch` tools) enabled. |

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
| `searchTimeoutMs` | `30000` | Per-call timeout for one `web_search` query. |

rustxng's CLI accepts only `-c/--config`, `-b/--bind`, `-p/--port`, `-v`, `-h`, so the
bind address, the port, and this plugin's own client-side timeout are the only knobs
available without writing a rustxng settings file.

## Notes

- One server process is reused across searches; it is killed when the plugin's fiber
  disposes (session stop / plugin disable). A failed start is retried on the next search.
- The server is spawned with `stdio: 'ignore'` — no named pipes, which keeps it clear of
  the Windows sandbox's stdio boundary.
- `available()` is just an existence check for the binary; the search path handles
  start-up and HTTP failures with actionable messages.
- `Config` is a hand-rolled Standard Schema (`Config['~standard'].validate`). A raw JSON
  Schema object crashes activation with `Cannot read properties of undefined (reading 'validate')`,
  and `@deepseek-ai/schemastery` cannot be imported from a locally linked bundle because
  Node resolves imports from this checkout, not from the profile's `node_modules`.
- Patch row `web` restates **both** `searchProvider` and `fetchProvider`: a patch replaces a
  row's `config` wholesale, and omitting `fetchProvider` makes `web_fetch` fail with
  `WEB_PROVIDER_AMBIGUOUS` once `deepseek-fetch-api` and `http` are both registered.
- Only English locale metadata is shipped (`locale/en.json`).
- Known limitation: the Settings page reports this plugin's config schema as
  `unsupported` (query `Config.listConfigs` with entry `include:rustxng-web-search`), because
  a hand-rolled Standard Schema cannot be projected into an editable form. Validation and
  defaults still work; tune the values by editing the row's `config` in a patch layer, e.g.
  `config: { port: 9123 }`.
- The Web search settings switch writes a `web` row into the profile patch, which is a HIGHER
  layer than this bundle's patch. If that switch is used, it wins over the pin here; re-assert
  `searchProvider: rustxng` + `fetchProvider: http` in the profile patch to keep this provider.
