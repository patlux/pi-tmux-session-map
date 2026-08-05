import { join } from "node:path";

import { cleanupSupersededSessionMappings, ensureDirectory, writeAtomic } from "./atomic-write.ts";
import { mappingFileName, paneIdMappingFileName } from "./pane-key.ts";
import { sessionFileMatches } from "./session-file.ts";
import { buildSessionMapping, serializeSessionMapping } from "./session-mapping.ts";
import type { PaneInfo, SessionInfo } from "./status.ts";

export type MappingPublication = {
  keyFileName: string;
  paneIdFileName: string;
};

export async function publishSessionMapping(
  stateDir: string,
  info: PaneInfo,
  session: SessionInfo,
  sessionId: string,
  nowMs = Date.now(),
): Promise<MappingPublication | undefined> {
  if (
    session.sessionFile === null
    || info.backend !== "tmux"
    || info.tmuxServerPid === null
    || !(await sessionFileMatches(session.sessionFile, sessionId))
  ) {
    return undefined;
  }
  const keyFileName = mappingFileName(info.paneKey);
  const paneIdFileName = paneIdMappingFileName(info.paneId);
  const mapping = buildSessionMapping(
    info.paneKey,
    info.paneId,
    info.tmuxServerPid,
    session.sessionFile,
    sessionId,
    session.cwd,
    session.sessionName,
    nowMs,
  );
  const serialized = serializeSessionMapping(mapping);
  await ensureDirectory(stateDir);
  // Publish both current identities before removing stale names. A crash can
  // leave duplicates, but never a gap; the next reconciliation removes them.
  await writeAtomic(join(stateDir, keyFileName), serialized, 0o600);
  await writeAtomic(join(stateDir, paneIdFileName), serialized, 0o600);
  await cleanupSupersededSessionMappings(
    stateDir,
    [keyFileName, paneIdFileName],
    session.sessionFile,
    { paneId: info.paneId, tmuxServerPid: info.tmuxServerPid },
  );
  return { keyFileName, paneIdFileName };
}
