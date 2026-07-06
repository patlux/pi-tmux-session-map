# pi-tmux-session-map

A [pi](https://pi.dev) extension that records which Pi session runs in which tmux pane, so tmux-resurrect can restore the **exact** session after a tmux server restart — instead of blindly continuing the newest session for the pane's working directory.

It also writes [tws](https://github.com/ytaskiran/tws)-compatible Pi work-status sidecar files so tws can show a live spinner while Pi is working and a checkmark after Pi finishes.

## Problem

`pi --continue` resumes the most recent session for the current directory. When tmux-resurrect restores panes with a blanket `pi --continue`, every pane in the same directory gets the same (newest) session — the wrong one for all but one pane.

## How it works

The extension resolves a stable tmux pane key:

```
#{session_name}:#{window_index}.#{pane_index}
```

That key is stable across tmux server restarts (unlike pane ids like `%42`), which is exactly what tmux-resurrect restores. File names use a readable sanitized prefix plus a 12-character SHA-256 suffix so different pane keys cannot collide and very long tmux session names stay below filesystem filename limits.

It writes two sidecars:

```text
~/.local/state/pi/tmux-sessions/<sanitized-pane-key>-<sha256-12>.session
~/.config/tws/pi-status/<sanitized-pane-key>-<sha256-12>.json
```

The `.session` file contains the active Pi session file path. It is written on `session_start`, `session_info_changed`, `agent_start`, and `agent_end` when the current Pi session has a backing session file.

The `.json` file contains tws work state (`idle`, `working`, `done`, `shutdown`) plus pane/session metadata and is written on Pi lifecycle events. The extension touches `~/.config/tws/agent.trigger` after status writes so tws refreshes within one poll tick.

Mappings are intentionally **not** removed on shutdown — they must survive `tmux kill-server` so resurrect can use them. Every Pi start in a pane overwrites that pane's mapping, so stale entries self-heal. Very old mapping files and interrupted atomic-write temp files are cleaned up opportunistically on session start.

## Install

```sh
pi install git:github.com/patlux/pi-tmux-session-map
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

The session mapping is written only when:

- Pi runs inside tmux (`$TMUX` and `$TMUX_PANE` set)
- the current session has a backing session file (not `--no-session`)

The tws status file is written for any Pi session inside tmux, even when the session file is not available yet; `session_file` is `null` until Pi creates one.

If the recorded session file no longer exists, the wrapper falls back to `pi --continue` for the pane's working directory.

## Caveats

- Pane keys use window/pane *indexes*: if you reorder windows or panes between save and restore, a mapping can point at a sibling pane's session. It self-heals on the next Pi start.

## License

MIT

## Configuration

Optional environment variables for hardening or local integration:

- `PI_TMUX_SESSION_MAP_STATE_DIR` — override the mapping directory.
- `PI_TMUX_SESSION_MAP_TWS_CONFIG_DIR` — override the tws config directory.
- `PI_TMUX_SESSION_MAP_TWS_STATUS_DIR` — override only the tws status directory.
- `PI_TMUX_SESSION_MAP_TWS_TRIGGER_FILE` — override the tws trigger file.
- `PI_TMUX_SESSION_MAP_TMUX_BIN` — override the `tmux` binary path.

Lifecycle sidecar updates are serialized in-process, mapping and status files are written atomically, and `tmux display-message` is bounded by a short timeout so Pi lifecycle hooks do not hang indefinitely.
