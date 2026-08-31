# Contributing

## Before opening a change

- Use an issue for bugs or a short proposal for behavior, public contracts, or architecture.
- Keep extension-specific behavior inside `extensions/bugtrace-recorder`.
- Recorded sessions and exported `.bugtrace.zip` files can contain secrets. Never attach real
  recordings, screenshots, or page data to issues or pull requests.

## Local setup

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

Node.js and pnpm versions are pinned in `.node-version` and `package.json`.

## Pull requests

- Keep the change focused and update tests for changed behavior or public contracts.
- Run `pnpm check` before requesting review.
- Run `pnpm package:zip && pnpm verify:zip` when packaging behavior changes.
- Do not commit `node_modules`, `.output`, coverage, caches, local screenshots, recordings, or secrets.
- Use Conventional Commit style for commit subjects.

CI must pass before merge. Dependency updates are reviewed like source changes and are never
auto-merged.

## Releases

Bugtrace Recorder releases use one namespaced tag:

- `bugtrace-recorder-v<version>`

Only maintainers should create version commits and tags. GitHub Actions validates the tag,
runs the full quality gate, builds the Chrome zip, generates its SHA-256 checksum, and
creates the GitHub Release.
