import type { WorkflowAgentRunMetadata } from "./options.js";
import type { WorkflowMeta } from "./workflow.js";

export const WORKFLOW_SESSION_ENTRY_TYPE = "pi-dynamic-workflow-state";

export interface WorkflowCompletedCheckpoint {
  label: string;
  result: unknown;
  metadata?: WorkflowAgentRunMetadata;
  /** Deterministic SHA-256 fingerprint of the normalized replay-relevant invocation. */
  fingerprint: string;
}

export interface PersistedWorkflowState {
  id: string;
  script: string;
  args?: unknown;
  meta: WorkflowMeta;
  tokensSpent: number;
  status: "running" | "paused" | "interrupted" | "completed";
  completed: Record<string, WorkflowCompletedCheckpoint>;
  /** Cumulative keys of explicit pauses that have been acknowledged across this workflow's lifetime. */
  acknowledgedPauseKeys?: string[];
  pause?: { reason: string; data?: unknown; key?: string };
  interruption?: { reason: string; tokensSpent: number };
  createdAt: number;
  updatedAt: number;
}

export type WorkflowStateEvent =
  | {
      kind: "created";
      workflowId: string;
      script: string;
      args?: unknown;
      meta: WorkflowMeta;
      timestamp: number;
    }
  | {
      kind: "agent_completed";
      workflowId: string;
      checkpoint: WorkflowCompletedCheckpoint;
      tokensSpent: number;
      timestamp: number;
    }
  | {
      kind: "paused";
      workflowId: string;
      reason: string;
      data?: unknown;
      key?: string;
      tokensSpent: number;
      timestamp: number;
    }
  | {
      kind: "interrupted";
      workflowId: string;
      reason: string;
      tokensSpent: number;
      timestamp: number;
    }
  | {
      kind: "resumed";
      workflowId: string;
      timestamp: number;
    }
  | {
      kind: "completed";
      workflowId: string;
      tokensSpent: number;
      timestamp: number;
    };

export interface WorkflowStateStore {
  append(event: WorkflowStateEvent): void | Promise<void>;
  get(workflowId: string): PersistedWorkflowState | undefined;
  list(): PersistedWorkflowState[];
}

/** Rebuild branch-local workflow state from append-only Pi custom entries. */
export function reduceWorkflowStateEvents(events: readonly WorkflowStateEvent[]): Map<string, PersistedWorkflowState> {
  const states = new Map<string, PersistedWorkflowState>();
  for (const event of events) {
    if (!event || typeof event !== "object" || typeof event.workflowId !== "string") continue;
    if (event.kind === "created") {
      states.set(event.workflowId, {
        id: event.workflowId,
        script: event.script,
        args: event.args,
        meta: event.meta,
        tokensSpent: 0,
        status: "running",
        completed: Object.create(null),
        acknowledgedPauseKeys: [],
        createdAt: event.timestamp,
        updatedAt: event.timestamp,
      });
      continue;
    }
    const state = states.get(event.workflowId);
    if (!state) continue;
    state.updatedAt = event.timestamp;
    switch (event.kind) {
      case "agent_completed":
        state.completed[event.checkpoint.label] = event.checkpoint;
        state.tokensSpent = Math.max(state.tokensSpent, event.tokensSpent);
        break;
      case "paused":
        state.status = "paused";
        state.pause = { reason: event.reason, data: event.data, key: event.key };
        state.tokensSpent = Math.max(state.tokensSpent, event.tokensSpent);
        if (event.key) {
          if (!state.acknowledgedPauseKeys) state.acknowledgedPauseKeys = [];
          if (!state.acknowledgedPauseKeys.includes(event.key)) {
            state.acknowledgedPauseKeys.push(event.key);
          }
        }
        break;
      case "interrupted":
        state.status = "interrupted";
        state.interruption = { reason: event.reason, tokensSpent: event.tokensSpent };
        state.tokensSpent = Math.max(state.tokensSpent, event.tokensSpent);
        break;
      case "resumed":
        state.status = "running";
        state.pause = undefined;
        state.interruption = undefined;
        // acknowledgedPauseKeys intentionally preserved across resumes.
        break;
      case "completed":
        state.status = "completed";
        state.pause = undefined;
        state.interruption = undefined;
        state.tokensSpent = Math.max(state.tokensSpent, event.tokensSpent);
        break;
    }
  }
  return states;
}

export function isWorkflowStateEvent(value: unknown): value is WorkflowStateEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as { kind?: unknown; workflowId?: unknown };
  return (
    typeof event.workflowId === "string" &&
    (event.kind === "created" ||
      event.kind === "agent_completed" ||
      event.kind === "paused" ||
      event.kind === "interrupted" ||
      event.kind === "resumed" ||
      event.kind === "completed")
  );
}
