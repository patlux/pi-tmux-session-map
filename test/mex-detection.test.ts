import assert from "node:assert/strict";
import { test } from "node:test";

import { resolvePaneInfo } from "../src/index.ts";

const BACKEND_ENV_KEYS = [
  "TMUX",
  "TMUX_PANE",
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  "ZELLIJ_PANE_ID",
  "MEX_SESSION",
] as const;

function withCleanBackendEnv<T>(env: Partial<Record<string, string>>, run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of BACKEND_ENV_KEYS) {
    previous.set(key, process.env[key]);
  }
  for (const key of BACKEND_ENV_KEYS) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      continue;
    }
    process.env[key] = value;
  }
  return run().finally(() => {
    for (const key of BACKEND_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

test("resolvePaneInfo detects immutable mex id from MEX_SESSION", async () => {
  const info = await withCleanBackendEnv({ MEX_SESSION: "19fb891d9de001" }, () => resolvePaneInfo());
  assert.deepEqual(info, {
    backend: "mex",
    paneKey: "mex:19fb891d9de001",
    paneId: "19fb891d9de001",
    sessionName: "19fb891d9de001",
    windowIndex: 0,
    paneIndex: 0,
  });
});

test("resolvePaneInfo ignores MEX_SESSION when a tmux pane env is present", async () => {
  const info = await withCleanBackendEnv({ MEX_SESSION: "twm_personal_infra_main", TMUX_PANE: "%42" }, () =>
    resolvePaneInfo()
  );
  assert.equal(info, undefined);
});

test("resolvePaneInfo returns undefined without any backend env", async () => {
  const info = await withCleanBackendEnv({}, () => resolvePaneInfo());
  assert.equal(info, undefined);
});
