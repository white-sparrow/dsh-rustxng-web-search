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
| `index.js` | Spawns the server lazily on first search and registers a `WebSearchProvider` with id `rustxng` on `ctx.web`. Queries `GET /search?q=...&format=json`. Also serves this plugin's own HTTP routes under `/rustxng-web-search` (`state`, `set`, `probe`, `debug`) and gates the tools per session. |
| `client.js` | The chat-box half: a **Web search switch** chip in the `conversation.input.left` slot (compact controls at the left of the composer tool row). It reads `/rustxng-web-search/state?session=<id>` every 3 s and writes `/set` on click. |
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
| `defaultEnabled` | `true` | Starting state of the chat-box switch. Set `false` to ship with web search off. |

rustxng's CLI accepts only `-c/--config`, `-b/--bind`, `-p/--port`, `-v`, `-h`, so the
bind address, the port, and this plugin's own client-side timeout are the only knobs
available without writing a rustxng settings file.

## Web search switch

The chip in the chat box is a **per-session toggle, on by default**. Switching it off
calls `ctx.tools.restrict({ deny: ['web_search','web_fetch'] })` on that session's Agent
context, so the model can no longer see or call the tools; switching it on disposes the
restriction. This is the weakest mechanism the harness offers for the job (it can only
remove tools, so it cannot rewrite what other plugins contribute), and the harness
documents it as exactly the way to hide tools from one Agent.

- A session that was already running when this plugin activates is reached through
  `sessionController.resolveAgent(sessionId)` on the first switch click, so the click works
  without a restart.
- Agents this plugin sees created later (`agent/created`) are gated or left alone from the
  same table. `sessionOverrides` is in-memory, so state resets to the default on a plugin
  reload, and a resume/fork drops that session's override.
- `tools.get(name)` and `tools.schemas()` read the **global** registry: they keep reporting
  both tools even while the mask is live, so they cannot be used to verify the switch.
  The authoritative read is the Agent's own callable tool list (`cordis_inspect_query` →
  host provider `Tool`, method `listTools`), which drops `web_search` / `web_fetch` while
  off and restores them while on — measured both ways.
- `GET /rustxng-web-search/probe?query=...&max=3` searches through the `web` service
  exactly as the model-facing tool does, so the engine and provider can be checked without
  a model turn.

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
- The model learns about `web_search` / `web_fetch` from the shipped `dsh-tool-web` plugin's
  own system-prompt section: this bundle only forces that row on, so the wording is the
  harness's, not a prompt invented here.

## Verified (live, against the running harness)

- Provider end to end: `GET /rustxng-web-search/probe?max=1` → `{"ok":true,"sources":1,…}`
  with real URLs; a model turn returned eight rustxng sources, including a mapped
  `publishedAt`.
- Switch off → `Tool.listTools` for that session lists no `web_search` / `web_fetch`; switch
  on → both present. The debug route reports `gated: true / probe: "web search denied…"` and
  then `gated: false / probe: "idle"`.
- Chat-box chip: Client `Slots.listSubTree { root: "conversation.input.left" }` shows
  occupant `id: "rustxng-web-search"`, `order: 5`, `active: true`.
- Not verified: how the chip looks, and clicking it. There is no browser control from this
  session, so that needs a look at the running page (`http://127.0.0.1:14264` in this session);
  an installed Client half loads on page refresh.
