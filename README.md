# pi-tmux-session-map

A [pi](https://pi.dev) extension that records which Pi session runs in which tmux pane, so tmux-resurrect can restore the **exact** session after a tmux server restart — instead of blindly continuing the newest session for the pane's working directory.

It also writes [tws](https://github.com/ytaskiran/tws)-compatible Pi work-status sidecar files for both tmux and Zellij, so each TWS edition can distinguish working, retrying, successful, cancelled, incomplete, and failed Pi runs.

Both work on their own with tmux-resurrect and the wrapper below. The [tmux-recovery integration](#optional-tmux-recovery-integration), which continues a Pi run that a tmux restart interrupted, needs tmux-recovery, which is not public at the moment. Without it, that code stays inactive.

## Problem

`pi --continue` resumes the most recent session for the current directory. When tmux-resurrect restores panes with a blanket `pi --continue`, every pane in the same directory gets the same (newest) session — the wrong one for all but one pane.

## How it works

The extension records two complementary tmux identities:

```text
restart identity: #{session_name}:#{window_index}.#{pane_index}
live identity:    (#{pid}, #{pane_id})
```

The pane key is what tmux-resurrect recreates across server restarts. The server-PID/pane-ID pair remains stable while one tmux server is running, even when windows or panes are renumbered. A periodic, jittered reconciliation resolves the current key for the live pane ID and atomically republishes the mapping under the new key. Pane IDs are never trusted across a tmux server restart because tmux can reuse them.

File names use a readable sanitized prefix plus a 12-character SHA-256 suffix so different identities cannot collide and very long tmux session names stay below filesystem filename limits.

For tmux it writes the exact-resume mapping and status sidecar. For Zellij it writes only the status sidecar because Zellij owns session resurrection itself:

```text
~/.local/state/pi/tmux-sessions/<sanitized-pane-key>-<sha256-12>.session
~/.local/state/pi/tmux-sessions/pane-id-<sanitized-pane-id>-<sha256-12>.session
~/.config/tws/pi-status/<sanitized-pane-key>-<sha256-12>.json
~/.config/tws-zellij/pi-status/<sanitized-pane-key>-<sha256-12>.json
```

The `.session` files contain schema-3 JSON with pane key, pane ID, tmux server PID, exact Pi session path and ID, cwd, and session name. They are written only by an interactive Pi TUI with a real stdin TTY, never by a headless `pi-subagents` child that merely inherited the parent's tmux environment. Publication also requires that the JSONL exists and its session header matches Pi's current session ID. Writes occur on Pi lifecycle events and periodic reconciliation. A replacement key and pane-ID alias are published atomically before stale names are removed, so interruption can leave duplicates but never a mapping gap.

The status `.json` also publishes `session_id`, `pi_pid` and `tmux_server_pid`.
This live identity comes directly from Pi at session start, even before its JSONL
exists. Consumers must match the foreground Pi PID, tmux server and pane, reject
shutdown/stale status, and revalidate before copying. The session ID is therefore
available before the first message; a resume command still requires a matching
on-disk header. The durable `.session` mappings retain their persistence checks.

The `.json` file contains the multiplexer backend, tws work state (`idle`, `working`, `retrying`, `done`, `cancelled`, `incomplete`, `failed`, `shutdown`), and pane/session metadata. A technical-error `agent_end` is provisional `retrying`; aborts and token-limit responses become `cancelled`/`incomplete` immediately. `agent_settled` confirms the final outcome (`failed` if recovery did not succeed). The extension touches the matching `agent.trigger` file after status writes so that edition refreshes within one poll tick.

Mappings are intentionally **not** removed on shutdown — they must survive `tmux kill-server` so resurrect can use them. During one live tmux server, reconciliation self-heals pane renumbering through the stable pane-ID alias. After a server restart, consumers ignore old aliases and use the restart-stable pane key. Very old missing-target mappings and interrupted atomic-write temp files are cleaned up opportunistically on session start.

## Install

Requires Pi `0.80.5` or newer (`agent_settled` lifecycle event).

```sh
pi install npm:pi-tmux-session-map
```

Then reload pi:

```txt
/reload
```

## Pairing with tmux-resurrect

Add a `pi-tmux-resume` wrapper on your `PATH`:

```sh
#!/usr/bin/env bash
set -euo pipefail

state_dir="$HOME/.local/state/pi/tmux-sessions"

fallback() {
  exec pi --continue
}

if [ -z "${TMUX:-}" ] || [ -z "${TMUX_PANE:-}" ]; then
  fallback
fi

key="$(tmux display-message -p -t "$TMUX_PANE" '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null || true)"
if [ -z "$key" ]; then
  fallback
fi

# Keep in sync with src/domain/pane-key.ts.
sanitized="$(printf '%s' "$key" | LC_ALL=C tr -c 'A-Za-z0-9._-' '_' | cut -c 1-120)"
if [ -z "$sanitized" ] || printf '%s' "$sanitized" | grep -Eq '^\.+$'; then
  sanitized="pane"
fi
hash="$(printf '%s' "$key" | shasum -a 256 | awk '{print substr($1, 1, 12)}')"
map="$state_dir/$sanitized-$hash.session"

if [ -f "$map" ]; then
  session_file="$(head -n 1 "$map" 2>/dev/null || true)"
  if [ -n "$session_file" ] && [ -f "$session_file" ]; then
    exec pi --session "$session_file"
  fi
fi

fallback
```

Then tell tmux-resurrect to restore Pi panes with it:

```tmux
set -g @resurrect-processes '"~pi-coding-agent/dist/cli.js->pi-tmux-resume"'
```

## Behavior

The exact session mapping and pane-scoped tws status are written only when Pi is an interactive TUI with a real stdin TTY and is not marked as a `PI_SUBAGENT_CHILD`. Tmux additionally requires `$TMUX` and `$TMUX_PANE`; Zellij requires `$ZELLIJ`, `$ZELLIJ_SESSION_NAME`, and `$ZELLIJ_PANE_ID`. This ownership gate prevents invisible headless children from replacing the visible parent's resume identity or work status. When an eligible interactive session has no Pi session path, the status `session_file` is `null`. Pi can also supply a planned path before the file exists; that path alone is not proof of resumability. The live `session_id` remains available in either case. Final failure-like outcomes are delayed until `agent_settled`, so automatic retries or compaction recovery do not appear as permanent failures.

If the recorded session file no longer exists, the wrapper falls back to `pi --continue` for the pane's working directory.

## Caveats

- Pane IDs are scoped to one tmux server and may be reused after restart. Schema 3 therefore includes the tmux server PID and consumers require both values before using a live alias.
- A Pi process without a valid on-disk JSONL has a live identity but no durable resume mapping. The extension waits for persistence before publishing a resume alias; it never creates session history merely to make a command available.

## Optional: tmux-recovery integration

This part works only together with tmux-recovery, a restore tool that is not public at the moment. Without its resume wrapper, Pi gets no restore token and no continuation plan: no acknowledgement is written, the executor does not start and the status has no `continue` field. Two things stay active in every interactive pane owner: the recovery evidence fields `run_anchor` and `shutdown_cause` in the status, and a SIGHUP/SIGTERM listener for `shutdown_cause`. The TWS skip action described below exists in a TWS fork, not in upstream tws.

### Recovery evidence

For tmux-recovery's auto-continue decision the status carries recovery evidence. `run_anchor` (`{ leaf_id, started_at_ms }`) is set at the `agent_start` that begins a run: `leaf_id` is the session leaf before the run's prompt entry, captured synchronously because Pi persists the prompt after `agent_start`. Retries keep the anchor; final states and `idle` clear it. On `shutdown`, `shutdown_cause` is `signal` when the process received SIGHUP or SIGTERM (closed terminal, dead tmux server, reboot), `quit` for an interactive quit, `reload`, or `replace` for `/new`, `/resume` and fork. Only the interactive pane owner installs the signal listener, and the cause is resolved when the queued write builds its payload, after the signal dispatch has finished. A graceful signal shutdown can still leave `working` or `retrying` when Pi exits on a dead terminal before the write lands.

### Restore acknowledgement

A restore acknowledgement (`PI_TMUX_RESTORE_*` environment from tmux-recovery's `pi-tmux-resume`, not from the wrapper above) is written at most once per token: the first writer wins, so a later `/new` or `/reload` cannot replace the proof of what the restore resumed. A restore keeps the tmux server busy, so while the acknowledgement is pending the pane lookup is retried with growing timeouts; if every attempt fails, the next lifecycle event or reconciliation writes it.

### Auto-continue executor

When tmux-recovery restores a Pi that was interrupted inside a run, its resume wrapper sets `PI_TMUX_CONTINUE_PLAN` to a plan file in the recovery ledger. Only that restored process runs the executor, once, at its `startup`, and only as the interactive pane owner for the planned session. The executor waits for the restore acknowledgement (`resumed`; a mismatch skips) and for the plan's slot, then checks the final conditions in one section under the ledger's dispatch lock: plan still released and listed in `ready.json`, mode `on`, no hold file, same session, pane and last message entry, Pi idle without pending messages, empty editor, no open dialog, no live `pi-session-watchdog` for the session. It then claims the plan with an exclusive create (`<key>.claim`, never removed) and sends one visible `tmux-recovery-continue` message with `triggerTurn`. The German text names the stop time, the elapsed time and open tool calls and asks Pi to check the actual state first; its `continuationId` matches the message details.

Any real keystroke (`ctx.ui.onTerminalInput`), interactive or RPC input, extension dialog or other run before the dispatch writes a durable veto (`<key>.skip`, first writer wins). A session end before the claim writes a `process-end` skip. After the dispatch, `before_agent_start` with the matching `continuationId` writes the outcome `admitted`, and the turn's `agent_settled` writes its final state; without admission within 120 s the outcome is `uncertain`. Nothing is ever re-sent.

A `<key>.skip` that another program wrote before the claim is a veto too: TWS writes `{"class": "veto", "reason": "skipped-in-tws", …}` with an exclusive create when you skip a planned continuation. The executor checks for it at least once a second while it waits for the slot or the spacing, and again inside the dispatch section; it then stops without a claim and keeps the file as written. A file it cannot read or parse also counts as a veto. A skip written after the claim has no effect, so a writer should check `<key>.claim` after its own create to know whether it came too late.

The status sidecar shows the executor in `continue`, from its start on:

```json
"continue": {"state": "planned", "reason": null, "slot_ms": 1794000014000, "deadline_ms": 1794000614000,
             "key": "<64 hex>", "ledger_dir": "/Users/…/resurrect/pi-continue/ledger"}
```

`state` is `planned`, `dispatched`, `admitted`, the turn's outcome (`done`, `failed`, `cancelled`, …), `uncertain`, `skipped` or `stopped`; `reason` is set for `skipped` and `stopped` (for example `user-active`, `skipped-in-tws`, `claimed`). `slot_ms` and `deadline_ms` come from the released plan and stay `null` until the release.

## License

MIT

## Configuration

Optional environment variables for hardening or local integration:

- `PI_TMUX_SESSION_MAP_STATE_DIR` — override the mapping directory.
- `PI_TMUX_SESSION_MAP_TWS_CONFIG_DIR` — override the tws config directory.
- `PI_TMUX_SESSION_MAP_TWS_STATUS_DIR` — override only the tws status directory.
- `PI_TMUX_SESSION_MAP_TWS_TRIGGER_FILE` — override the tws trigger file.
- `PI_TMUX_SESSION_MAP_TMUX_BIN` — override the `tmux` binary path.
- `PI_TMUX_SESSION_MAP_RESTORE_PANE_TIMEOUTS_MS` — comma-separated `tmux display-message` timeouts while a tmux-recovery restore acknowledgement is pending; default `1000,2000,4000,8000,16000`.
- `PI_TMUX_SESSION_MAP_RECONCILE_INTERVAL_MS` — periodic mapping reconciliation interval; minimum 10 seconds, default 60 seconds, deterministically jittered per pane.
- `PI_TMUX_SESSION_MAP_ZELLIJ_BIN` — override the `zellij` binary path.
- `PI_TMUX_SESSION_MAP_ZELLIJ_STATUS_DIR` — override the Zellij TWS status directory.
- `PI_TMUX_SESSION_MAP_ZELLIJ_TRIGGER_FILE` — override the Zellij TWS trigger file.

Lifecycle sidecar updates are serialized in-process, mapping and status files are written atomically, and `tmux display-message` is bounded by a short timeout so Pi lifecycle hooks do not hang indefinitely. A refresh that times out keeps the last known pane of the process, so a busy tmux never drops a status write such as `working` at `agent_start`.
