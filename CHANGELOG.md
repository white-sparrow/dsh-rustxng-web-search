# Changelog

## 1.0.0

- Host half: spawns a locally downloaded RustXNG metasearch server and registers it
  as the Harness `web` search provider (`searchProvider: rustxng`), so `web_search`
  and `web_fetch` need no API key.
- Engine supply: fetched on demand from `sahenjp/RustXNG` GitHub releases into
  `bin/`, verified by published sha256 and byte count, written atomically, resumed
  across interrupted downloads, and kept current with a scheduled upstream check. The
  package runs no install scripts, so installing never stops on a blocked build script.
- Client half: a Web search chip in the composer tool row toggles web search per
  session (default on) and shows the engine's version and status.
- Control routes under `/rustxng-web-search`: `engine`, `version`, `state`,
  `tools`, `probe`, `debug`, `set`, `clear`, `update`.
- Publish-ready metadata (MIT license, repository and issue links), plus staging helpers
  for a staging-only access token (`npm run stage`, `stage:approve`).
- Public repository tag `v1.0.0` and a GitHub release carrying the same tarball, so the
  plugin installs from npm, from the repository, or from the release asset.
