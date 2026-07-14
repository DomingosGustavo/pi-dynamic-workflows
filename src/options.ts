export type WorkflowModelRef =
  | string
  | {
      provider?: string;
      id?: string;
    };

export type WorkflowThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * Isolate an agent in a temporary Git worktree.
 *
 * dirty: 'patch' copies untracked files and applies `git diff --binary HEAD`.
 * It does not distinctly reproduce deletions vs staged-index state, and
 * deleted-then-recreated paths can be double-applied by the untracked copy plus
 * HEAD diff. Patch mode is supported only when baseRef is HEAD.
 */
export type WorktreeIsolation =
  | "none"
  | "worktree"
  | {
      mode: "worktree";
      baseRef?: string;
      rootDir?: string;
      branch?: string;
      keep?: boolean | "onError";
      dirty?: "fail" | "ignore" | "patch";
      merge?: "none";
    };

export interface WorkflowWorktreeMetadata {
  path: string;
  cwd: string;
  kept: boolean;
  status: string;
  diff: string;
  error?: string;
}

export interface WorkflowCostUsage {
  // Per-bucket costs are optional: session-stats-derived usage only knows the
  // aggregate `total`, so the breakdown is left undefined (unknown) rather than
  // reported as a misleading zero for each component.
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total: number;
}

export interface WorkflowTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: WorkflowCostUsage;
  turns?: number;
}

export interface WorkflowContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export type WorkflowAgentActivityKind =
  | "queued"
  | "starting"
  | "thinking"
  | "responding"
  | "tool_calling"
  | "tool_running"
  | "tool_done"
  | "waiting"
  | "done"
  | "error";

export interface WorkflowAgentActivity {
  kind: WorkflowAgentActivityKind;
  text: string;
  toolName?: string;
  toolArgsPreview?: string;
  toolResultPreview?: string;
  preview?: string;
  updatedAt: number;
}

export interface WorkflowAgentRunMetadata {
  cwd: string;
  model?: {
    provider: string;
    id: string;
  };
  thinkingLevel?: WorkflowThinkingLevel;
  modelSelection?: {
    job: string;
    considered: string[];
    reason: string;
  };
  worktree?: WorkflowWorktreeMetadata;
  usage?: WorkflowTokenUsage;
  contextUsage?: WorkflowContextUsage;
  activity?: WorkflowAgentActivity;
  promptPreview?: string;
  outputPreview?: string;
  /** Structured error attached by the runtime when a subagent run fails. */
  error?: { name: string; message: string; stack?: string };
}

export type WorkflowApprovalMode = "interactive" | "auto";

export type WorkflowReviewStatus = "pending" | "approved" | "rejected" | "auto";

export interface WorkflowReviewMetadata {
  path: string;
  script: string;
  approved: boolean;
  approvalMode: WorkflowApprovalMode;
  status: WorkflowReviewStatus;
}
