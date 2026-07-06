import { createHash } from "node:crypto";
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
  let result = "";
  for (const byte of Buffer.from(key, "utf8")) {
    const isDigit = byte >= 0x30 && byte <= 0x39;
    const isUpper = byte >= 0x41 && byte <= 0x5a;
    const isLower = byte >= 0x61 && byte <= 0x7a;
    const isPunctuation = byte === 0x2e || byte === 0x5f || byte === 0x2d;
    result += isDigit || isUpper || isLower || isPunctuation ? String.fromCharCode(byte) : "_";
  }
  return result;
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

export function keyFileStem(key: string): string {
  const sanitized = sanitizeKey(key).slice(0, 120).replace(/^\.+$/, "_");
  const prefix = sanitized === "" ? "pane" : sanitized;
  return `${prefix}-${hashKey(key)}`;
}

/** File name of the mapping file for a raw pane key. */
export function mappingFileName(key: string): string {
  return `${keyFileStem(key)}.session`;
}

/** File name of the tws status file for a raw pane key. */
export function statusFileName(key: string): string {
  return `${keyFileStem(key)}.json`;
}

/** Normalize raw `tmux display-message` output into a pane key, if usable. */
export function normalizePaneKey(stdout: string): string | undefined {
  const key = stdout.trim();
  return key === "" ? undefined : key;
}
