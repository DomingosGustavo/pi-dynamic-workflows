import assert from "node:assert/strict";
import test from "node:test";
import { reduceWorkflowStateEvents, type WorkflowStateEvent } from "../src/workflow-state.js";

const meta = { name: "resume_demo", description: "Resume demo" };

test("reduceWorkflowStateEvents rebuilds append-only paused workflow checkpoints", () => {
  const events: WorkflowStateEvent[] = [
    {
      kind: "created",
      workflowId: "wf-1",
      script: "script",
      args: { target: "src" },
      meta,
      timestamp: 1,
    },
    {
      kind: "agent_completed",
      workflowId: "wf-1",
      checkpoint: { label: "inventory", result: { files: 3 }, fingerprint: "fp-inventory" },
      tokensSpent: 12,
      timestamp: 2,
    },
    {
      kind: "paused",
      workflowId: "wf-1",
      reason: "Legacy unkeyed pause",
      data: { nextAgent: "review" },
      tokensSpent: 12,
      timestamp: 3,
    },
  ];

  const state = reduceWorkflowStateEvents(events).get("wf-1");
  assert.equal(state?.status, "paused");
  assert.equal(state?.tokensSpent, 12);
  assert.deepEqual(state?.completed.inventory.result, { files: 3 });
  assert.deepEqual(state?.pause, { reason: "Legacy unkeyed pause", data: { nextAgent: "review" }, key: undefined });
});

test("resume and completion update the same workflow lineage", () => {
  const events: WorkflowStateEvent[] = [
    {
      kind: "created",
      workflowId: "wf-1",
      script: "script",
      meta,
      timestamp: 1,
    },
    {
      kind: "paused",
      workflowId: "wf-1",
      reason: "pause",
      tokensSpent: 8,
      timestamp: 2,
    },
    { kind: "resumed", workflowId: "wf-1", timestamp: 3 },
    {
      kind: "agent_completed",
      workflowId: "wf-1",
      checkpoint: { label: "review", result: "ok", fingerprint: "fp-review" },
      tokensSpent: 15,
      timestamp: 4,
    },
    { kind: "completed", workflowId: "wf-1", tokensSpent: 15, timestamp: 5 },
  ];

  const state = reduceWorkflowStateEvents(events).get("wf-1");
  assert.equal(state?.status, "completed");
  assert.equal(state?.tokensSpent, 15);
  assert.equal(state?.completed.review.result, "ok");
});

test("reduceWorkflowStateEvents preserves explicit pause keys", () => {
  const events: WorkflowStateEvent[] = [
    {
      kind: "created",
      workflowId: "wf-key",
      script: "script",
      meta,
      timestamp: 1,
    },
    {
      kind: "paused",
      workflowId: "wf-key",
      reason: "review",
      data: { stage: 1 },
      key: "pause-1-abc123",
      tokensSpent: 0,
      timestamp: 2,
    },
  ];

  const state = reduceWorkflowStateEvents(events).get("wf-key");
  assert.equal(state?.pause?.key, "pause-1-abc123");
});

test("reduceWorkflowStateEvents records interrupted state and tokens", () => {
  const events: WorkflowStateEvent[] = [
    {
      kind: "created",
      workflowId: "wf-interrupt",
      script: "script",
      meta,
      timestamp: 1,
    },
    {
      kind: "agent_completed",
      workflowId: "wf-interrupt",
      checkpoint: { label: "first", result: "ok", fingerprint: "fp1" },
      tokensSpent: 12,
      timestamp: 2,
    },
    {
      kind: "interrupted",
      workflowId: "wf-interrupt",
      reason: "aborted",
      tokensSpent: 12,
      timestamp: 3,
    },
  ];

  const state = reduceWorkflowStateEvents(events).get("wf-interrupt");
  assert.equal(state?.status, "interrupted");
  assert.equal(state?.interruption?.reason, "aborted");
  assert.equal(state?.interruption?.tokensSpent, 12);
});

test("reduceWorkflowStateEvents clears interruption on resume", () => {
  const events: WorkflowStateEvent[] = [
    {
      kind: "created",
      workflowId: "wf-resume-interrupt",
      script: "script",
      meta,
      timestamp: 1,
    },
    {
      kind: "interrupted",
      workflowId: "wf-resume-interrupt",
      reason: "aborted",
      tokensSpent: 0,
      timestamp: 2,
    },
    { kind: "resumed", workflowId: "wf-resume-interrupt", timestamp: 3 },
  ];

  const state = reduceWorkflowStateEvents(events).get("wf-resume-interrupt");
  assert.equal(state?.status, "running");
  assert.equal(state?.interruption, undefined);
});

test("reduceWorkflowStateEvents accumulates explicit pause keys and preserves them across unkeyed pauses and resumes", () => {
  const events: WorkflowStateEvent[] = [
    {
      kind: "created",
      workflowId: "wf-keys",
      script: "script",
      meta,
      timestamp: 1,
    },
    {
      kind: "paused",
      workflowId: "wf-keys",
      reason: "review",
      key: "pause-1-aaa",
      tokensSpent: 2,
      timestamp: 2,
    },
    { kind: "resumed", workflowId: "wf-keys", timestamp: 3 },
    {
      kind: "paused",
      workflowId: "wf-keys",
      reason: "Legacy unkeyed pause",
      tokensSpent: 10,
      timestamp: 4,
    },
    { kind: "resumed", workflowId: "wf-keys", timestamp: 5 },
    {
      kind: "paused",
      workflowId: "wf-keys",
      reason: "review",
      key: "pause-2-bbb",
      tokensSpent: 12,
      timestamp: 6,
    },
  ];

  const state = reduceWorkflowStateEvents(events).get("wf-keys");
  assert.deepEqual(state?.acknowledgedPauseKeys, ["pause-1-aaa", "pause-2-bbb"]);
  assert.equal(state?.pause?.key, "pause-2-bbb");
});
