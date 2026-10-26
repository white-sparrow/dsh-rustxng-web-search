# Changelog

## 1.0.1

- Installs without a fight: the package runs **no install scripts**, so a package
  manager no longer blocks the install on a build-script prompt (1.0.0 shipped a
  `postinstall` that pnpm refused to run). The engine still arrives on the first
  search, or up front with `npm run engine`.
- Public repository install: `white-sparrow/dsh-rustxng-web-search`, tag `v1.0.1`,
  and a GitHub release carrying the packed tarball; the README lists the install
  specs that a package manager accepts, npm and repository alike.
- `repository` and `bugs` metadata, and `LICENSE` kept as the verbatim MIT text
  (the engine binary's AGPL terms live in the README).

## 1.0.0

- Host half: spawns a locally downloaded RustXNG metasearch server and registers it
  as the Harness `web` search provider (`searchProvider: rustxng`), so `web_search`
  and `web_fetch` need no API key.
- Engine supply: fetched on demand from `sahenjp/RustXNG` GitHub releases into
  `bin/`, verified by published sha256 and byte count, written atomically, resumed
  across interrupted downloads, and kept current with a scheduled upstream check.
- Client half: a Web search chip in the composer tool row toggles web search per
  session (default on) and shows the engine's version and status.
- Control routes under `/rustxng-web-search`: `engine`, `version`, `state`,
  `tools`, `probe`, `debug`, `set`, `clear`, `update`.
- Staged and approved on npm.
