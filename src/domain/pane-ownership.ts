export type PaneOwnershipEvidence = {
  mode: string;
  stdinIsTty: boolean;
  subagentChild: boolean;
};

export function paneOwnershipEvidence(
  mode: string,
  stdinIsTty: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): PaneOwnershipEvidence {
  return {
    mode,
    stdinIsTty: stdinIsTty === true,
    subagentChild: env.PI_SUBAGENT_CHILD === "1",
  };
}

export function ownsInteractivePane(evidence: PaneOwnershipEvidence): boolean {
  return evidence.mode === "tui"
    && evidence.stdinIsTty
    && !evidence.subagentChild;
}
