// One-shot editor text for the next Pi in a tmux pane. TWS sets the pane
// option before it types `pi` into a new pane; the Pi that starts there takes
// the text into its editor, so TWS never waits for Pi or types into it.

/** tmux pane option with the text for the editor of the next Pi in that pane. */
export const EDITOR_PREFILL_OPTION = "@pi-editor-prefill";

/** Runs tmux with the arguments and resolves to its stdout. */
export type TmuxRunner = (args: readonly string[]) => Promise<string>;

/**
 * Read the pane's prefill and clear it. Resolves to null when the pane has
 * none. A failure rejects before the text is returned: a prefill that stays
 * set would reach the next Pi started in the same pane as well.
 */
export async function takeEditorPrefill(tmux: TmuxRunner, paneId: string): Promise<string | null> {
  // `-q` keeps an unset option silent; `-v` prints the bare value.
  const output = await tmux(["show-options", "-p", "-q", "-v", "-t", paneId, EDITOR_PREFILL_OPTION]);
  const text = output.endsWith("\n") ? output.slice(0, -1) : output;
  if (text.length === 0) {
    return null;
  }
  await tmux(["set-option", "-p", "-u", "-t", paneId, EDITOR_PREFILL_OPTION]);
  return text;
}

/**
 * Pi accepts keys while it starts, so the editor can already hold text typed
 * after TWS focused the pane. The prefill goes in front of it.
 */
export function prefilledEditorText(prefill: string, typed: string): string {
  return prefill + typed;
}
