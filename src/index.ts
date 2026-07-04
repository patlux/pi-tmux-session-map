import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  PANE_KEY_FORMAT,
  defaultStateDir,
  mappingFileName,
  normalizePaneKey,
} from "./domain/pane-key.ts";

const execFileAsync = promisify(execFile);
const stateDir = defaultStateDir();

async function resolvePaneKey(): Promise<string | undefined> {
  const pane = process.env.TMUX_PANE;
  if (!process.env.TMUX || !pane) {
    return undefined;
  }
  try {
    const { stdout } = await execFileAsync("tmux", [
      "display-message",
      "-p",
      "-t",
      pane,
      PANE_KEY_FORMAT,
    ]);
    return normalizePaneKey(stdout);
  } catch {
    return undefined;
  }
}

/**
 * Maps each tmux pane (session:window.pane) to the Pi session file running in
 * it, so tmux-resurrect can restore the exact session (e.g. via a
 * `pi-tmux-resume` wrapper) instead of blindly continuing the newest session
 * of the pane's working directory.
 */
export default function tmuxSessionMap(pi: ExtensionAPI) {
  const update = async (ctx: ExtensionContext) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) {
      return;
    }
    const key = await resolvePaneKey();
    if (!key) {
      return;
    }
    try {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      await writeFile(join(stateDir, mappingFileName(key)), sessionFile + "\n", {
        mode: 0o600,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("pi-tmux-session-map: failed to write state: " + message);
    }
  };

  // Intentionally no cleanup on session_shutdown: the mapping must survive a
  // tmux server restart so resurrect can restore the exact session.
  pi.on("session_start", async (_event, ctx) => {
    await update(ctx);
  });
  pi.on("session_info_changed", async (_event, ctx) => {
    await update(ctx);
  });
  // Covers sessions whose file only exists after the first agent turn.
  pi.on("agent_end", async (_event, ctx) => {
    await update(ctx);
  });
}
