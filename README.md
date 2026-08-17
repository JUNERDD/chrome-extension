# Chrome Extension Collection

A private pnpm workspace for small, focused Chrome extensions built with WXT.

## Extensions

| Extension | Status | Purpose |
| --- | --- | --- |
| Bugtrace Recorder | In development | Capture privacy-conscious browser reproduction evidence for bug reports and agents. |

## Workspace

- Node.js `22.23.1`
- pnpm `11.22.0`
- Packages live in `extensions/*`

```bash
corepack enable
pnpm install
pnpm dev:bugtrace
```

The recorder is an internal, unpacked extension. It stores sessions locally and does not upload telemetry or recordings.

See [the approved implementation plan](docs/plans/2026-08-17-chrome.md) for scope, privacy boundaries, and validation requirements.
