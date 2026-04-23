# Ghost Shift — overnight autonomous work-graph execution

Ghost Shift is the Frontier OS nightly batch runner. It drains the queue at
`~/.frontier/ghost-shift/queue/*.json`, executes each work graph, writes ledger
events, and exits. Runs once a night on a launchd schedule.

## Schedule

- **Label:** `com.frontier-os.ghost-shift`
- **Plist:** `~/Library/LaunchAgents/com.frontier-os.ghost-shift.plist`
- **Time:** daily at 02:00 local (`StartCalendarInterval` Hour=2, Minute=0)
- **Command:** `frontier ghost run --max-runtime 1800 --max-concurrent 4 --max-retries 1`
- **RunAtLoad:** false — installing the plist does not fire a run, only schedules the next one.

> macOS note: `StartCalendarInterval` fires missed runs when the Mac wakes, but
> only one catch-up per missed window. If the Mac is asleep / off at 02:00,
> you'll get one run on next wake rather than on the dot. Full reliability
> requires either keeping the Mac awake or adding a `pmset` wake schedule
> separately (not part of this install).

## Install / uninstall

```
bash ~/frontier-os/scripts/install-ghost-shift-plist.sh
bash ~/frontier-os/scripts/uninstall-ghost-shift-plist.sh
```

The installer is idempotent: re-running it refreshes the plist, unloads any
previous copy, then reloads with `-w` (persistent across reboots).

## Enqueueing a graph

```
frontier ghost queue <path-to-work-graph.json>
```

Queued graphs live at `~/.frontier/ghost-shift/queue/*.json` until the next
02:00 run picks them up. You can enqueue multiple; Ghost Shift runs up to
`--max-concurrent 4` in parallel, bounded by `--max-runtime 1800` seconds total.

## Kill switch (disable without uninstalling)

```
touch ~/.frontier/ghost-shift/.disabled
```

The CLI checks for this file at startup and exits as a no-op. Remove the file
to re-enable:

```
rm ~/.frontier/ghost-shift/.disabled
```

For a harder stop (keep plist out of launchd entirely) use the uninstaller
above, or:

```
launchctl unload ~/Library/LaunchAgents/com.frontier-os.ghost-shift.plist
```

## Logs

- `~/Library/Logs/frontier-os/ghost-shift.out.log` — stdout
- `~/Library/Logs/frontier-os/ghost-shift.err.log` — stderr

Logs are launchd-appended; rotate manually if they grow (`: > <file>`).

## See what ran last night

```
frontier ledger search --kind ghost.shift_end --limit 7
```

That lists the last seven nightly shift-end events with graph counts, durations,
and pass/fail outcomes. For a single graph's step-level detail, grep the ledger
by its id or inspect the out-log above for the same window.

## Manual one-off run

```
frontier ghost run --max-runtime 1800 --max-concurrent 4 --max-retries 1
```

Runs immediately against the current queue. Useful for validating that the
binary and queue work before the first 02:00 fire.
