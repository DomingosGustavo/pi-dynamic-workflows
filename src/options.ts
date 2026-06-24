export type WorkflowModelRef =
  | string
  | {
      provider?: string;
      id?: string;
    };

export type WorkflowThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

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
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
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
  worktree?: WorkflowWorktreeMetadata;
  usage?: WorkflowTokenUsage;
  contextUsage?: WorkflowContextUsage;
  activity?: WorkflowAgentActivity;
  promptPreview?: string;
  outputPreview?: string;
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
