# Skills

Per-task-class agent contracts. One directory per task class, matching the
classes declared in `config/model-policy.json:classes`.

The skill loader (`src/skills/loader.ts`) asserts that **every task class in
the policy has a skill, and every skill points at a real task class** — no
drift. A test in `src/skills/__tests__/loader.test.ts` enforces this.

## Why these exist

Workers in this repo do not invent their own permissions or success criteria.
They load a skill that declares:

- which model roles may take this work (`allowedRoles`)
- which tools they may invoke (`allowedTools` allowlist)
- which tools are explicitly off-limits even if the runtime would permit them
  (`forbiddenTools` denylist; takes precedence over allow)
- what side effects a successful run is allowed to produce (`sideEffects`,
  sharing vocabulary with the work-graph schema)
- whether a verifier must run before merge (`verifierMode`)
- the minimum acceptable quality score (`qualityFloor`, when applicable)

The prose half (`SKILL.md`) carries the role description, success criteria,
anti-patterns, and a prompt template. Future PRs (R3 review swarm, R5 builder
swarm) will read `SKILL.md` and interpolate the task into the template
instead of embedding 30-line prompts inline in factory code.

## Layout

```
skills/
├── README.md                     ← this file
├── routine_summary/
│   ├── skill.json
│   └── SKILL.md
├── patch_builder/
│   ├── skill.json
│   └── SKILL.md
├── adversarial_review/
│   ├── skill.json
│   └── SKILL.md
├── research_extraction/
│   ├── skill.json
│   └── SKILL.md
└── merge_arbiter/
    ├── skill.json
    └── SKILL.md
```

The two-file split keeps the metadata machine-checkable (validated against
`schemas/skill.schema.json`) without dragging a YAML parser into the repo —
see `taste/README.md` for the no-YAML rule.

## Tool vocabulary (v1)

Strings used in `allowedTools` / `forbiddenTools`. Stable enough for the
loader to validate; not yet bound to a runtime — workers in PR R2/R3 will
interpret these against actual tool calls.

| Verb                   | Means                                                   |
| ---------------------- | ------------------------------------------------------- |
| `read.file`            | Read files in the worktree (incl. `.frontier`-tracked)  |
| `read.repo`            | Glob/Grep across the worktree                           |
| `read.web`             | HTTP GET to public URLs (citations, changelog research) |
| `read.mcp.frontier`    | Any read-only frontier MCP tool (approvalClass 0)       |
| `read.ledger`          | Read `~/.frontier/ledger.db` (events, sessions, briefs) |
| `write.worktree`       | Create/edit files inside the worker's own git worktree  |
| `exec.test`            | Run `node --import tsx --test …` and similar            |
| `exec.lint`            | Run linters (eslint, ruff, etc.)                        |
| `exec.typecheck`       | Run `npm run typecheck`                                 |
| `exec.build`           | Run build commands (no main-worktree side effects)      |
| `exec.git.status`      | `git status` / `git diff` (read-only)                   |
| `exec.git.commit`      | `git commit` inside own worktree                        |
| `exec.git.push`        | `git push` to a remote                                  |
| `exec.shell.read`      | Read-only shell (`ls`, `cat`, etc.); no mutation        |
| `exec.shell.write`     | Mutating shell (`rm`, `mv`, etc.)                       |
| `broker.call`          | Recursively call `InferenceBroker.callClass`            |
| `mcp.read.*`           | Specific read MCP tool, e.g. `mcp.read.github`          |
| `mcp.write.*`          | Specific write MCP tool                                 |
| `adapter.<id>.read`    | Adapter read mode (e.g. `adapter.salesforce.read`)      |
| `adapter.<id>.propose` | Adapter propose mode                                    |
| `adapter.<id>.apply`   | Adapter apply mode (real side effect)                   |
| `launchd.read`         | Read launchd plist state                                |
| `launchd.apply`        | Bootstrap/bootout/kickstart launchd jobs                |

`forbiddenTools` matters even when the verb isn't in `allowedTools` — it's a
hard denial that survives later allow-list expansion. Default-forbid for
every skill: `exec.git.push`, `launchd.apply`, `adapter.*.apply` unless
explicitly granted.

## Authoring a new skill

1. Add the task class to `config/model-policy.json:classes` with a model list.
2. `mkdir skills/<task-class>/`
3. Write `skill.json` matching `schemas/skill.schema.json`. The loader test
   will fail fast if you skip required fields or use unknown enums.
4. Write `SKILL.md` with role description, success criteria (prefer numbered
   IDs), anti-patterns, and a prompt template. Keep it under ~120 lines.
5. Add a `rubric` pointer to a `taste/rubrics/*.json` if the output is
   reviewable.
6. `npm run typecheck && node --import tsx --test src/skills/__tests__/*.test.ts`.

## What this is not

- **Not a runtime sandbox.** Tool restrictions are policy declarations.
  Enforcement happens in PR R2 (worktree manager + per-worker tool gate)
  and the broker pre-call hook. Today the contract is documentation +
  loader assertion.
- **Not a prompt cache.** Skills carry templates, not full prompts. The
  caller interpolates task-specific context.
- **Not a model selector.** That's `config/model-policy.json`. Skills
  describe the _envelope_ a model operates inside; the policy decides
  _which model_ to send.
