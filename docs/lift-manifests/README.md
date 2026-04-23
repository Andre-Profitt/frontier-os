# Lift Manifests — 2026-04-18

Three parallel research passes covering the unbuilt portions of the Frontier OS v1 vision. For each remaining phase, the goal was: find the best OSS/primary-source to **wrap, port, or skip** — so we don't write from scratch what someone else has already proved.

## Contents

- `agent-memory-and-multi-agent.md` — §8.5 memory class separation + §13.2 Worktree Swarm
- `observability-and-trace-to-eval.md` — §8.6 telemetry + §13.3 Failure Refinery automation
- `adapters-and-research-primitive.md` — remaining adapters + a research-as-a-primitive lift

## Top-level verdict

Most pieces are **WRAP** or **PORT**, not **BUILD**. The key meta-insight: make the research primitive itself a first-class Frontier OS adapter so the system compounds by researching itself rather than us hand-dispatching agents per topic.

See `docs/synthesis-2026-04-18.md` for the decision table.
