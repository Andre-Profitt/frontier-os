# GitHub Adapter

Read-only PR / issue / repo queries via the `gh` CLI. Auth and rate-limit handling are delegated to `gh`; this adapter just spawns it, parses `--json` stdout, and maps exit state into an `AdapterResult`.

## Setup

The adapter shells out to `gh`. Authenticate once globally:

```
gh auth login         # interactive; pick github.com + HTTPS + browser
gh auth status        # verify
```

Credentials are stored in the OS keyring (or whatever backend `gh` chose). No per-project config lives in this repo.

Override the binary path if needed:

```
export FRONTIER_GH_BIN=/opt/homebrew/bin/gh
```

The manifest declares `transport: "native_cli"` (the canonical schema value for CLI wrappers).

## Commands

All commands are `mode: "read"`, `sideEffectClass: "none"`. Arguments go in `invocation.arguments`.

| Command        | Required args             | Optional args                                                           | Underlying `gh` call                                                                                                             |
| -------------- | ------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `list-prs`     | `owner`, `repo`           | `state` (`open`\|`closed`\|`all`, default `open`), `limit` (default 30) | `gh pr list -R owner/repo --state X --limit N --json number,title,state,author,createdAt,updatedAt,url`                          |
| `get-pr`       | `owner`, `repo`, `number` | —                                                                       | `gh pr view N -R owner/repo --json number,title,body,state,author,baseRefName,headRefName,files,additions,deletions,commits,url` |
| `list-issues`  | `owner`, `repo`           | `state`, `labels` (`string[]`), `limit`                                 | `gh issue list -R owner/repo --state X --label A,B --limit N --json ...`                                                         |
| `repo-summary` | `owner`, `repo`           | —                                                                       | `gh repo view owner/repo --json name,description,defaultBranchRef,pushedAt,stargazerCount,openIssuesCount,url`                   |

### Result shape

```jsonc
{
  "status": "success", // or "failed"
  "summary": "anthropics/claude-code: 4 pr(s) state=open",
  "observedState": {
    "invocation": { "argv": ["gh", "..."], "exitCode": 0, "signal": null },
    "data": [
      /* parsed gh JSON */
    ],
  },
  "verification": { "status": "passed", "checks": ["trace_grade"] },
}
```

`observedState.invocation.argv` is the exact argv spawned — watchers and verifiers replay from that.

### Failure modes

| Condition                                           | Result                                                                 | Notes                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------- |
| `gh` binary not on PATH                             | `status: "failed"`, summary mentions `ENOENT` + `FRONTIER_GH_BIN` hint | No crash                                    |
| `gh` exits non-zero (auth expired, 404, rate limit) | `status: "failed"`, summary is trimmed stderr                          | `observedState.stderr` has full stderr      |
| stdout is not valid JSON                            | `status: "failed"`, summary mentions parse error                       | `observedState.rawStdout` truncated to 4 KB |
| `invocation.policy.maxRuntimeSeconds` exceeded      | `status: "failed"`, child killed with SIGTERM                          |                                             |

### Argument validation

Rejected pre-spawn with `status: "failed"`:

- `owner` / `repo` missing or non-string
- `number` (get-pr) not a positive integer
- `state` not one of `open` / `closed` / `all`
- `limit` not a positive integer
- `labels` not a `string[]`

## Worked example

```bash
/Users/test/frontier-os/bin/frontier adapter invoke github repo-summary \
  --input '{"owner":"anthropics","repo":"claude-code"}' \
  --mode read
```

Expected `observedState.data`:

```jsonc
{
  "name": "claude-code",
  "description": "Claude Code is an agentic coding tool...",
  "defaultBranchRef": { "name": "main" },
  "pushedAt": "2026-04-18T01:34:30Z",
  "stargazerCount": 115585,
  "issues": { "totalCount": 9656 },
  "url": "https://github.com/anthropics/claude-code",
}
```

And the one-line summary: `anthropics/claude-code: 115585 star(s), 9656 total issue(s)`.

Note: `gh repo view` does not expose an `openIssuesCount` scalar, so we surface `issues.totalCount` (total issues, open+closed). Use `list-issues` with `state: "open"` + `limit` if you need an open-only count.

## Why CLI, not REST?

- `gh` already carries the user's auth in the OS keyring; no per-project token handling.
- `gh` handles pagination, rate-limit backoff, and API version pinning.
- Future write commands (`pr comment`, `issue create`) re-use the same spawn path.
- No new runtime dependency — `gh` is a prerequisite anyway.
