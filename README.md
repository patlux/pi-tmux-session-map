# pi-tmux-session-map

A [pi](https://pi.dev) extension that records which Pi session runs in which tmux pane, so tmux-resurrect can restore the **exact** session after a tmux server restart — instead of blindly continuing the newest session for the pane's working directory.

It also writes [tws](https://github.com/ytaskiran/tws)-compatible Pi work-status sidecar files for both tmux and Zellij, so each TWS edition can distinguish working, retrying, successful, cancelled, incomplete, and failed Pi runs.

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

The exact session mapping and pane-scoped tws status are written only when Pi is an interactive TUI with a real stdin TTY and is not marked as a `PI_SUBAGENT_CHILD`. Tmux additionally requires `$TMUX` and `$TMUX_PANE`; Zellij requires `$ZELLIJ`, `$ZELLIJ_SESSION_NAME`, and `$ZELLIJ_PANE_ID`. This ownership gate prevents invisible headless children from replacing the visible parent's resume identity or work status. When an eligible interactive session has no Pi session file yet, the status `session_file` remains `null`. Final failure-like outcomes are delayed until `agent_settled`, so automatic retries or compaction recovery do not appear as permanent failures.

If the recorded session file no longer exists, the wrapper falls back to `pi --continue` for the pane's working directory.

## Caveats

- Pane IDs are scoped to one tmux server and may be reused after restart. Schema 3 therefore includes the tmux server PID and consumers require both values before using a live alias.
- A Pi process whose current session has no valid on-disk JSONL cannot be mapped exactly. The extension fails closed and waits for a later lifecycle event or reconciliation instead of publishing a speculative path.

## License

MIT

## Configuration

Optional environment variables for hardening or local integration:

- `PI_TMUX_SESSION_MAP_STATE_DIR` — override the mapping directory.
- `PI_TMUX_SESSION_MAP_TWS_CONFIG_DIR` — override the tws config directory.
- `PI_TMUX_SESSION_MAP_TWS_STATUS_DIR` — override only the tws status directory.
- `PI_TMUX_SESSION_MAP_TWS_TRIGGER_FILE` — override the tws trigger file.
- `PI_TMUX_SESSION_MAP_TMUX_BIN` — override the `tmux` binary path.
- `PI_TMUX_SESSION_MAP_RECONCILE_INTERVAL_MS` — periodic mapping reconciliation interval; minimum 10 seconds, default 60 seconds, deterministically jittered per pane.
- `PI_TMUX_SESSION_MAP_ZELLIJ_BIN` — override the `zellij` binary path.
- `PI_TMUX_SESSION_MAP_ZELLIJ_STATUS_DIR` — override the Zellij TWS status directory.
- `PI_TMUX_SESSION_MAP_ZELLIJ_TRIGGER_FILE` — override the Zellij TWS trigger file.

Lifecycle sidecar updates are serialized in-process, mapping and status files are written atomically, and `tmux display-message` is bounded by a short timeout so Pi lifecycle hooks do not hang indefinitely.
