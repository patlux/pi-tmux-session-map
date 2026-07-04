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

That key is stable across tmux server restarts (unlike pane ids like `%42`), which is exactly what tmux-resurrect restores. Characters outside `[A-Za-z0-9._-]` are replaced with `_`.

It writes two sidecars:

```text
~/.local/state/pi/tmux-sessions/<session_name>_<window_index>.<pane_index>.session
~/.config/tws/pi-status/<session_name>_<window_index>.<pane_index>.json
```

The `.session` file contains the active Pi session file path. It is written on `session_start`, `session_info_changed`, `agent_start`, and `agent_end` when the current Pi session has a backing session file.

The `.json` file contains tws work state (`idle`, `working`, `done`, `shutdown`) plus pane/session metadata and is written on Pi lifecycle events. The extension touches `~/.config/tws/agent.trigger` after status writes so tws refreshes within one poll tick.

Mappings are intentionally **not** removed on shutdown — they must survive `tmux kill-server` so resurrect can use them. Every Pi start in a pane overwrites that pane's mapping, so stale entries self-heal.

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

# Keep in sync with sanitizeKey() in src/domain/pane-key.ts.
sanitized="$(printf '%s' "$key" | LC_ALL=C tr -c 'A-Za-z0-9._-' '_')"
map="$state_dir/$sanitized.session"

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
- Multibyte characters in tmux session names sanitize slightly differently in the shell wrapper (`tr` works on bytes) than in the extension (per character). Stick to ASCII session names or adjust the wrapper.

## License

MIT
