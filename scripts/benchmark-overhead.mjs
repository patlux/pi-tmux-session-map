import { chmod, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "pi-tmux-session-map-bench-"));
const stateDir = join(root, "state");
const twsDir = join(root, "tws");
const statusDir = join(twsDir, "pi-status");
const ackDir = join(root, "ack");
const backend = process.env.BENCH_BACKEND === "zellij" ? "zellij" : "tmux";
const callsFile = join(root, "mux-calls.jsonl");
const fakeMux = join(root, backend);
const sessionFile = join(root, "session.jsonl");

await writeFile(sessionFile, "{}\n");
await writeFile(
  fakeMux,
  backend === "tmux"
    ? `#!/bin/sh\nprintf '%s\\n' "$*" >> "$PI_TMUX_SESSION_MAP_BENCH_CALLS"\nprintf 'bench:1.0\\tbench\\t1\\t0\\n'\n`
    : `#!/bin/sh\nprintf '%s\\n' "$*" >> "$PI_TMUX_SESSION_MAP_BENCH_CALLS"\nprintf '[{"id":1,"is_plugin":false,"tab_position":1}]\\n'\n`,
);
await chmod(fakeMux, 0o755);

Object.assign(process.env, {
  PI_TMUX_SESSION_MAP_TMUX_BIN: fakeMux,
  PI_TMUX_SESSION_MAP_ZELLIJ_BIN: fakeMux,
  PI_TMUX_SESSION_MAP_STATE_DIR: stateDir,
  PI_TMUX_SESSION_MAP_TWS_CONFIG_DIR: twsDir,
  PI_TMUX_SESSION_MAP_TWS_STATUS_DIR: statusDir,
  PI_TMUX_SESSION_MAP_TWS_TRIGGER_FILE: join(twsDir, "agent.trigger"),
  PI_TMUX_SESSION_MAP_ZELLIJ_STATUS_DIR: statusDir,
  PI_TMUX_SESSION_MAP_ZELLIJ_TRIGGER_FILE: join(twsDir, "agent.trigger"),
  PI_TMUX_SESSION_MAP_BENCH_CALLS: callsFile,
  PI_TMUX_RESTORE_TOKEN: "restore-token",
  PI_TMUX_EXPECTED_PANE: "bench:1.0",
  PI_TMUX_EXPECTED_SESSION_ID: "session-id",
  PI_TMUX_EXPECTED_SESSION_FILE: sessionFile,
  PI_TMUX_RESTORE_ACK_DIR: ackDir,
});
if (backend === "tmux") {
  process.env.TMUX = join(root, "tmux.sock");
  process.env.TMUX_PANE = "%1";
  delete process.env.ZELLIJ;
  delete process.env.ZELLIJ_SESSION_NAME;
  delete process.env.ZELLIJ_PANE_ID;
} else {
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  process.env.ZELLIJ = "1";
  process.env.ZELLIJ_SESSION_NAME = "bench";
  process.env.ZELLIJ_PANE_ID = "1";
}

const beforeImport = process.memoryUsage();
const importStarted = process.hrtime.bigint();
const { default: extension } = await import("../src/index.ts");
const importElapsedMs = Number(process.hrtime.bigint() - importStarted) / 1e6;
const afterImport = process.memoryUsage();

const handlers = new Map();
extension({
  on(event, handler) {
    handlers.set(event, handler);
  },
});

const context = {
  cwd: root,
  sessionManager: {
    getSessionFile: () => sessionFile,
    getSessionName: () => "Optimize overhead",
    getSessionId: () => "session-id",
  },
};

async function snapshot() {
  const result = new Map();
  for (const dir of [stateDir, statusDir, twsDir, ackDir]) {
    let entries;
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      const info = await stat(path, { bigint: true });
      if (!info.isFile()) {
        continue;
      }
      result.set(path, `${info.ino}:${info.mtimeNs}:${info.size}:${await readFile(path, "utf8")}`);
    }
  }
  return result;
}

function mutations(before, after) {
  let count = 0;
  for (const [path, value] of after) {
    if (before.get(path) !== value) {
      count += 1;
    }
  }
  return count;
}

async function invoke(event, payload) {
  const handler = handlers.get(event);
  if (!handler) {
    throw new Error(`missing ${event} handler`);
  }
  const before = await snapshot();
  await handler(payload, context);
  const after = await snapshot();
  return mutations(before, after);
}

const phases = {};
phases.startup = await invoke("session_start", { reason: "resume" });
phases.namingUnchanged = await invoke("session_info_changed", { name: "Optimize overhead" });
phases.agentStart = await invoke("agent_start", {});
phases.agentEnd = await invoke("agent_end", {
  messages: [{ role: "assistant", stopReason: "stop" }],
});
phases.settlement = await invoke("agent_settled", {});
phases.shutdown = await invoke("session_shutdown", {});

const muxCalls = (await readFile(callsFile, "utf8")).trim().split("\n").filter(Boolean);
const baseline = backend === "tmux"
  ? {
      muxSubprocesses: 7,
      filesystemArtifactMutations: {
        startup: 4,
        namingUnchanged: 3,
        agentStart: 3,
        agentEnd: 3,
        settlement: 3,
        shutdown: 0,
      },
    }
  : {
      muxSubprocesses: 6,
      filesystemArtifactMutations: {
        startup: 2,
        namingUnchanged: 2,
        agentStart: 2,
        agentEnd: 2,
        settlement: 2,
        shutdown: 0,
      },
    };

console.log(JSON.stringify({
  backend,
  baselineWithoutCaching: baseline,
  import: {
    elapsedMs: importElapsedMs,
    rssDelta: afterImport.rss - beforeImport.rss,
    heapUsedDelta: afterImport.heapUsed - beforeImport.heapUsed,
    moduleLoadList: process.moduleLoadList.length,
  },
  muxSubprocesses: muxCalls.length,
  filesystemArtifactMutations: phases,
  totalFilesystemArtifactMutations: Object.values(phases).reduce((sum, value) => sum + value, 0),
}, null, 2));
