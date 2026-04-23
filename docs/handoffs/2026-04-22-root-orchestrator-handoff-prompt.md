# Handoff Prompt

Paste this into the next Codex session as the first message.

---

You are taking over the Frontier root-level orchestrator work in `/Users/test/frontier-os` and the native companion surface in `/Users/test/code/platform/companion-platform/apps/apple-companion`.

First step: read `/Users/test/frontier-os/docs/handoffs/2026-04-22-root-orchestrator-handoff.md` in full.

Then validate live state before proposing new work:

```bash
cd /Users/test/frontier-os
git status --short
/Users/test/frontier-os/bin/frontier command readiness --hours 24 --limit 50 --json
/Users/test/frontier-os/bin/frontier command worker status --json --local
/Users/test/frontier-os/bin/frontier daemon health --json
/Users/test/frontier-os/bin/frontier helper self-test --json
```

Ground rules from the prior session:

- The honest project read is still:
  - root-router substrate: `85-90%`
  - full orchestrator product: `65-75%`
  - reliable 8-hour autonomous work: `45-55%`
- Do not treat the recent `M60-M69` tranche as major capability movement. It was mostly Apple passive-surface wording and metadata cleanup.
- Do not spend the next tranche on more micro-polish in App Intents, notifications, widgets, or passive labels.
- The next tranche must be capability-bearing and should target execution-lane maturity.

Priority direction:

1. browser lane maturity
2. Salesforce lane maturity
3. retry / verifier / budget hardening across real lanes
4. overnight quality and useful morning briefs

Additional context:

- CRM Analytics and AI stack / MLX tooling both had substantive background work today. Those should be triaged separately from Frontier polish.
- Perplexity is eval-only. Do not commit into that lane.
- For host-level MLX work, use the shared workbench under `/Users/test/.frontier/mlx/bin/mlxw`.

Expected behavior for this takeover:

- start from the handoff doc, not from memory
- verify live state before making claims
- propose and execute the next capability-bearing slice
- avoid another milestone run made mostly of wording cleanup

Suggested first response to the user:

`Live state verified. I’m treating the recent Apple tranche as polish, not core progress. I’m moving the next slice back to execution-lane maturity and starting with the highest-leverage gap.`
