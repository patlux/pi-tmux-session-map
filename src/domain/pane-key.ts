import { homedir } from "node:os";
import { join } from "node:path";

/** tmux format string that yields a pane key stable across tmux server restarts. */
export const PANE_KEY_FORMAT = "#{session_name}:#{window_index}.#{pane_index}";

/**
 * Default state directory for pane -> session-file mappings.
 *
 * One plain-text file per pane; the first line is the absolute path of the
 * Pi session file that ran in that pane.
 */
export function defaultStateDir(): string {
  return join(homedir(), ".local", "state", "pi", "tmux-sessions");
}

/**
 * Sanitize a pane key for use as a file name.
 *
 * Keep in sync with consumers that resolve the mapping from shell, e.g. a
 * `pi-tmux-resume` wrapper using `tr -c 'A-Za-z0-9._-' '_'`.
 */
export function sanitizeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** File name of the mapping file for a raw pane key. */
export function mappingFileName(key: string): string {
  return `${sanitizeKey(key)}.session`;
}

/** File name of the tws status file for a raw pane key. */
export function statusFileName(key: string): string {
  return `${sanitizeKey(key)}.json`;
}

/** Normalize raw `tmux display-message` output into a pane key, if usable. */
export function normalizePaneKey(stdout: string): string | undefined {
  const key = stdout.trim();
  return key === "" ? undefined : key;
}
