# Root Router 8-Hour Build Result

Date: 2026-04-21

## Shipped

- `frontierd` user LaunchAgent generator, installer, plist lint, and loaded resident daemon.
- `frontier project status` and `frontier ops status` now prefer `frontierd` and report `servedBy`.
- Policy core: `simulate`, `evaluate`, one-shot `approve`, and one-shot `consume`.
- Read-only MCP bridge: tool registry, `smoke --read-only`, `call`, and JSON-RPC-lines `run`.
- Helper scaffold: native source/template plus user-mode simulator for status, launchd status, logs, network, and denial self-tests.
- Route explainer: `frontier route explain` maps verbs to `frontierd`, MCP, helper, local CLI, or blocked.

## Verified

```bash
npm run typecheck
/Users/test/frontier-os/bin/frontier daemon status --json
/Users/test/frontier-os/bin/frontier project status --json
/Users/test/frontier-os/bin/frontier ops status --json
/Users/test/frontier-os/bin/frontier mcp smoke --read-only --json
/Users/test/frontier-os/bin/frontier policy simulate --verb service.restart --project frontier-os --json
/Users/test/frontier-os/bin/frontier helper status --json
/Users/test/frontier-os/bin/frontier helper self-test --json
/Users/test/frontier-os/bin/frontier route explain --verb project.status --project frontier-os --json
/Users/test/frontier-os/bin/frontier route explain --verb service.restart --project frontier-os --json
```

## Residual Risk

- The privileged helper is intentionally not installed as root yet.
- MCP `run` is a lightweight JSON-RPC-lines entrypoint; SDK/framing hardening remains.
- Project verify/smoke declarations are still registry metadata, not executable runners.
- Siri and menubar integration are next-layer clients over these contracts.
