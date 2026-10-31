# Changelog

## [Unreleased]

- Upgrade the default RustXNG engine pin from `0.5.1` to `0.24.0`, so fresh installs
  receive the current upstream engine and its search reliability improvements.
- Keep RustXNG local indexing disabled: upstream marks it experimental, and the
  plugin does not yet generate or manage an engine settings file.
- Document that per-engine proxy support is not exposed by the plugin.
- Existing auto-update, SHA-256 verification, and fallback-to-installed-binary
  behavior remain unchanged.

## 1.0.2

- Search results are re-ranked before they reach the model. RustXNG gives every
  engine's first hit a score of exactly `1.0`, so its merged order is one arbitrary
  hit per engine; `rank.mjs` orders a wide pool by query agreement, host diversity
  (`hostCap`), script sanity, known hosts over keyword-squatting domains, the project
  home page, and release recency for version queries, then slices.
- New config keys: `searchLanguage`, `safesearch`, `resultPool`, `hostCap`,
  `includeDomains`, `excludeDomains` — the last two are engine-side domain filters.
- `GET engine` reports the engine's own blocked-engine count in `lastSearch`; that
  is usually the real reason a result list looks off-topic.
- Engine pin raised to `0.5.1`, the release that honours `max_results` and
  `include_domains`; auto-update still follows upstream (`0.6.1` verified by sha256).
- `npm test` runs 18 assertions over the re-ranker.

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
  as the Harness `web` search provider (`searchProvider: rustxng`), so
  `web_search` and `web_fetch` need no API key.
- Engine supply: fetched on demand from `sahenjp/RustXNG` GitHub releases into
  `bin/`, verified by published sha256 and byte count, written atomically, resumed
  across interrupted downloads, and kept current with a scheduled upstream check.
- Client half: a Web search chip in the composer tool row toggles web search per
  session (default on) and shows the engine's version and status.
- Control routes under `/rustxng-web-search`: `engine`, `version`, `state`,
  `tools`, `probe`, `debug`, `set`, `clear`, `update`.
- Staged and approved on npm.
