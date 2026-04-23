# Watchers

Watchers are the always-on operating layer.

Initial watcher set:

- `runpod-idle-killer`
- `overnight-review`
- `work-radar`

Each watcher should:

- observe structured inputs
- decide with explicit policy
- emit alerts
- write outcomes to memory
- respect a kill switch

Do not let watchers become unbounded agents. They are durable loops with narrow missions.
