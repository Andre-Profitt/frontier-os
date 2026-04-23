#!/bin/bash
# Enqueue a nightly-research work-graph for today's rotated watchlist topic.
#
# Rotation (by day-of-week, 0=Sun … 6=Sat):
#   Mon → agent_frameworks       (highest-priority, weekly)
#   Tue → eval_tracing_apple     (high, weekly)
#   Wed → crm_analytics_salesforce (high, monthly-ish)
#   Thu → llm_training_kaggle    (high, weekly)
#   Fri → quantum_derivatives    (medium, monthly)
#   Sat → prediction_market_hft  (medium, weekly)
#   Sun → agent_frameworks       (doubles-up highest-priority)
#
# Meant to be invoked by a launchd plist at ~01:55 local so Ghost Shift at
# 02:00 finds the graph in its queue. Manual invocation is safe and idempotent
# (each enqueue is a separate timestamped file; operators can dedupe later).
#
# Override the selected topic with the first positional argument, e.g.
#   enqueue-nightly-research.sh llm_training_kaggle

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WATCHLIST="$REPO_ROOT/examples/research/watchlist.json"
TEMPLATE="$REPO_ROOT/examples/workgraphs/nightly-research.graph.json"
QUEUE_DIR="$HOME/.frontier/ghost-shift/queue"

if [[ ! -f "$WATCHLIST" ]]; then
  echo "watchlist not found: $WATCHLIST" >&2
  exit 2
fi
if [[ ! -f "$TEMPLATE" ]]; then
  echo "nightly-research template not found: $TEMPLATE" >&2
  exit 2
fi

mkdir -p "$QUEUE_DIR"

# Pick today's topic by day-of-week (Python handles both rotation + JSON).
TOPIC="${1:-$(python3 - "$WATCHLIST" <<'PY'
import json, sys, datetime
watchlist_path = sys.argv[1]
rotation = {
    0: "agent_frameworks",          # Sun → highest-priority doubled
    1: "agent_frameworks",          # Mon
    2: "eval_tracing_apple",        # Tue
    3: "crm_analytics_salesforce",  # Wed
    4: "llm_training_kaggle",       # Thu
    5: "quantum_derivatives",       # Fri
    6: "prediction_market_hft",     # Sat
}
dow = datetime.date.today().weekday()  # Mon=0 … Sun=6
iso_dow = (dow + 1) % 7                # Normalize to Sun=0 … Sat=6
topic = rotation[iso_dow]
# Validate the topic exists in the watchlist.
with open(watchlist_path) as f:
    wl = json.load(f)
topics = {t["topicId"] for t in wl.get("topics", [])}
if topic not in topics:
    # Fall back to first priority=high topic if the rotation picks a missing one.
    for t in wl.get("topics", []):
        if t.get("priority") == "high":
            topic = t["topicId"]; break
print(topic)
PY
)}"

TIMESTAMP="$(date -u +%Y%m%d%H%M%S)"
DEST="$QUEUE_DIR/${TIMESTAMP}-nightly-research-${TOPIC}.graph.json"

# Stamp the template with today's topic + a unique graphId, then drop it in
# the ghost-shift queue.
python3 - "$TEMPLATE" "$DEST" "$TOPIC" "$TIMESTAMP" <<'PY'
import json, sys
template_path, dest_path, topic, timestamp = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
with open(template_path) as f:
    graph = json.load(f)
graph["graphId"] = f"wg_nightly_research_{topic}_{timestamp}"
graph["goal"] = (
    f"Nightly research pass for watchlist topic '{topic}'. "
    "Produces a markdown brief via the research adapter's orchestrator-worker loop."
)
for node in graph.get("nodes", []):
    if node.get("nodeId") == "n1_research":
        inp = node["inputs"][0]
        inp["value"]["arguments"]["topicId"] = topic
with open(dest_path, "w") as f:
    json.dump(graph, f, indent=2)
print(f"enqueued: {dest_path}")
print(f"topic:    {topic}")
print(f"graphId:  {graph['graphId']}")
PY
