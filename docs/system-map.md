# System Map

Date: April 8, 2026
Mode: personal control plane

## Priority Systems

| System | Primary interface | Fallback | First adapter / watcher job |
| --- | --- | --- | --- |
| Salesforce | Chrome/Atlas CDP + Salesforce helper | bounded UI automation | inspect dashboards, edit filters, capture layout and errors |
| GitHub | `gh` + GitHub API | browser | read PRs, create branches, reviews, alerts |
| Chrome | CDP | browser CLI wrapper | tab inspect, DOM/network capture, scripted actions |
| GPT Atlas | Chromium-style browser control | manual integration until confirmed | active-session tab control and research workflows |
| Terminal | native shell | none | controlled local execution with policy gates |
| Azure | `az` + Azure Monitor | portal browser automation | jobs, resources, alerts, cost awareness |
| Sigma | Sigma API | browser-backed controls | workbook state, refresh, metadata capture |
| Siri | App Intent / Shortcut | notifications | voice ingress only |
| Shortcuts | Shortcuts actions and automations | AppleScript | action bus for approved local flows |
| Databricks | Databricks CLI | browser | jobs, workspace state, notebook actions |
| Kaggle | Kaggle CLI/API | browser | kernels, datasets, model pulls, run tracking |
| RunPod | RunPod API | browser | pod inspect, spend guardrails, idle shutdown |
| NVIDIA | local runtimes / NIM / telemetry | shell | model serving and GPU telemetry |
| Local models | local inference broker | direct runtime call | private routing and cheap background work |
| Local GPU watcher | `nvidia-smi` and process inspection | vendor dashboards | cost and thermal watcher |
| Pod GPU watcher | RunPod API + process heartbeat | browser | idle killer to stop wasted spend |
| Quantum | Azure Quantum + local Q# workspace | notebooks | experiment orchestration and memory capture |

## Architecture Split

### 1. Native protocol and API plane

Use here first:

- browser CDP
- HTTP APIs
- native CLIs
- Apple automation

### 2. Semantic adapter plane

Translate raw control into stable verbs:

- `inspect_dashboard`
- `list_pull_requests`
- `stop_idle_pod`
- `explain_failed_job`
- `capture_daily_brief`

### 3. Watcher plane

Always-on loops that:

- observe
- detect drift or opportunity
- alert
- take bounded actions
- write outcomes to memory

### 4. Memory plane

Structured memory only. Avoid dumping everything into one vector index.

Memory classes:

- episodic
- procedural
- outcome
- cross-project
- system-health

## Immediate Adapter Priorities

### Browser

Responsibilities:

- attach to a live approved browser session
- inspect tabs, DOM, accessibility tree, network, console, and screenshots
- run bounded actions
- return normalized state

### Salesforce

Responsibilities:

- map Lightning pages into semantic objects
- expose dashboards, widgets, filters, edit state, and save state
- verify browser actions with state snapshots and screenshots
- write layout and usability findings into memory

## Immediate Watcher Priorities

### RunPod idle killer

Primary mission:

- detect idle paid GPUs
- notify first
- stop or terminate only under approved policy

### Overnight review

Primary mission:

- summarize wins, failures, costs, stale work, and suggested next moves

### Work radar

Primary mission:

- unify GitHub, Azure, Databricks, Kaggle, and local runtime alerts
