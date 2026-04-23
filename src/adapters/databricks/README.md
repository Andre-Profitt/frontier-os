# Databricks adapter (v1)

Read-only adapter for the Databricks workspace REST API. No SDK — plain
`fetch` against five endpoints. Writes (create-cluster, run-now, notebook
import) are a deliberate non-goal in v1; introduce a separate manifest when
that phase lands.

## Auth

Credentials are resolved in this order:

1. Env overrides: `FRONTIER_DATABRICKS_HOST`, `FRONTIER_DATABRICKS_TOKEN`.
2. `~/.databrickscfg`, `[DEFAULT]` section:

   ```ini
   [DEFAULT]
   host  = https://dbc-XXXX.cloud.databricks.com
   token = dapiXXXX...
   ```

Either source can supply either field; env wins per-field. Host is normalized
(trailing slashes stripped, must be `https://`).

If the cfg is missing and no env is set, commands return
`status: "failed"` with the hint
`no ~/.databrickscfg; set FRONTIER_DATABRICKS_HOST + FRONTIER_DATABRICKS_TOKEN`.
HTTP 401 surfaces as `token rejected; run \`databricks configure --token\` to refresh`.

## Commands

| command         | endpoint                               | args                 | notes                                       |
| --------------- | -------------------------------------- | -------------------- | ------------------------------------------- |
| `whoami`        | `GET /api/2.0/preview/scim/v2/Me`      | —                    | Returns `userName`, `id`, `displayName`.    |
| `list-clusters` | `GET /api/2.1/clusters/list`           | —                    | Caps to top 20; highlights running count.   |
| `list-jobs`     | `GET /api/2.2/jobs/list?limit=20`      | —                    | `has_more` surfaced in `observedState`.     |
| `job-status`    | `GET /api/2.2/jobs/get` + `/runs/list` | `job_id` (integer)   | Two calls fused; latest 5 runs + settings.  |
| `workspace-ls`  | `GET /api/2.0/workspace/list?path=<p>` | `path` (default `/`) | 404 is a graceful failed result, not crash. |

All commands only support `mode: "read"`. `sideEffectClass: "none"`.

## Usage

Register in `src/registry.ts` factories map (alphabetical):

```ts
databricks: async (manifest) => {
  const mod = await import("./adapters/databricks/index.ts");
  return mod.createDatabricksAdapter(manifest);
},
```

CLI:

```bash
bin/frontier adapter show databricks --pretty
bin/frontier adapter invoke databricks whoami --mode read
bin/frontier adapter invoke databricks workspace-ls --mode read --arg path=/Users
bin/frontier adapter invoke databricks job-status --mode read --arg job_id=12345
```

## Gotchas

- **Jobs API is 2.2, not 2.0.** Databricks split jobs into a 2.x namespace;
  2.0 still exists but returns a different shape. Stick with 2.2.
- **Clusters API is 2.1, not 2.0.** Same story: 2.1 is the stable modern
  shape. The 2.0 endpoint returns a slightly different response envelope.
- **SCIM /Me is under `/api/2.0/preview/`.** The `/preview/` prefix is
  intentional and part of the public stable path; do not strip it.
- **Tokens are PAT-scoped.** A workspace admin token sees every cluster/job;
  a user token only sees objects the user owns or has been granted. Empty
  result sets are usually a permissions gap, not a bug.
- **No retries.** Read-only GETs are fail-fast. Transient 5xx will surface;
  re-invoke from the caller.
- **Timeouts.** Default 30s; override via `policy.maxRuntimeSeconds`.
- **Workspace-ls on `/` works** even on empty workspaces (returns
  `{objects: []}` with HTTP 200). 404 means the supplied path truly does not
  exist and is surfaced as a failed result with the path echoed back.
