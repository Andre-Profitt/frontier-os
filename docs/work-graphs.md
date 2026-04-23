# Work Graph Executor

Phase 6 of Frontier OS. Turns `schemas/work-graph.schema.json` documents into executed, ledgered work — the "work compiler" from `frontier-os-v1.md` §7.1.

## CLI

```bash
frontier work validate <graph.json>
frontier work run <graph.json> [--auto-approve] [--dry-run] [--session <id>]
```

- `validate`: loads the file, ajv-checks it against the schema, returns topo order + node count.
- `run`: executes every node in topo order, writing `work.*` events to `~/.frontier/ledger.db`.

## Event kinds

Every run emits a stream under the session `workgraph-<graphId>-...`:

| Kind                                                       | When                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------- |
| `work.graph_start`                                         | Once, before any node runs                                |
| `work.node_start`                                          | Before each node dispatches                               |
| `work.awaiting_approval`                                   | When a class ≥ 2 node has no auto-approve / no token file |
| `work.verifier_pass` / `work.verifier_fail`                | When a node has `verifierPolicy.mode != "none"`           |
| `work.node_end` / `work.node_failed` / `work.node_skipped` | One per node, final                                       |
| `work.graph_end`                                           | Once, with tallies                                        |

Follow a run live via `frontier-watch --prefix work.` or the menu-bar app.

## Dispatcher (MVP)

Every node's `inputs[]` is inspected for:

- `{ type: "structured_payload", value: { adapterId, command, mode?, arguments? } }` → invokes the adapter via `registry.resolveAdapter()`.
- `{ type: "structured_payload", value: { cli: { command, args?, stdin?, cwd?, timeoutMs? } } }` → `spawnSync` on the linux plane.
- `approval` nodes → auto-granted if `--auto-approve`, else require a token file at `~/.frontier/approvals/<graphId>.<nodeId>.approved`.

Anything else returns `not_implemented` → node is marked `skipped`, the graph moves on.

## Approval gates

A node's effective approval class is `max(graph.approvalPolicy.defaultClass, node.approvalClass)`. Class ≥ 2 blocks unless either `--auto-approve` is set OR the node's kind is `approval` and an approval token exists. Downstream nodes that depend on a blocked node are marked `skipped` (dependency incomplete), not failed.

## Verifier (MVP)

`verifierPolicy.mode`:

- `none` → always passes.
- `required` → passes if dispatch status is `succeeded` AND (if `checks` includes `artifact_schema`) the dispatch payload is non-empty.
- `required_before_side_effect` → same as `required`, but only enforced when the node's `sideEffects` array contains anything other than `"none"`.

This is intentionally thin. Phase 6.1+ will plug in real verifier services — test runners, policy evaluators, trace graders.

## Not yet in scope

- Parallel execution of independent nodes (MVP is strictly sequential, deterministic toposort).
- Retries, exponential backoff, compensation paths.
- Budgets enforcement (`maxRuntimeSeconds`, `maxCostUsd`, `maxToolCalls` are read but not acted on).
- Real verifier services beyond the presence check above.
- Scheduled work graphs via launchd / the existing scheduler family.

## Example

```bash
frontier work validate examples/workgraphs/ledger-self-audit.json
frontier work run examples/workgraphs/ledger-self-audit.json --auto-approve --pretty
```

The `ledger-self-audit` graph runs without Chrome or external creds: two research nodes (ledger stats + a sqlite count), an approval gate (class 2), and a dispatch echo. Useful for smoke-testing the executor on a new machine.
