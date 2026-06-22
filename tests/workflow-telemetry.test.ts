import assert from "node:assert/strict";
import test from "node:test";
import { activityFromSessionEvent, usageFromMessages, workflowTelemetryFromSessionEvent } from "../src/telemetry.js";

test("activityFromSessionEvent summarizes tool execution safely", () => {
  const activity = activityFromSessionEvent(
    {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "read",
      args: { file_path: "src/auth.ts", offset: 1 },
    } as any,
    42,
  );

  assert.deepEqual(activity, {
    kind: "tool_running",
    text: "running read src/auth.ts",
    toolName: "read",
    toolArgsPreview: '{"file_path":"src/auth.ts","offset":1}',
    updatedAt: 42,
  });
});

test("activityFromSessionEvent summarizes streaming assistant activity", () => {
  const activity = activityFromSessionEvent(
    {
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "Checking src/auth.ts",
        partial: { role: "assistant", content: [{ type: "text", text: "Checking src/auth.ts" }] },
      },
    } as any,
    99,
  );

  assert.equal(activity?.kind, "responding");
  assert.equal(activity?.text, "responding");
  assert.equal(activity?.preview, "Checking src/auth.ts");
  assert.equal(activity?.updatedAt, 99);
});

test("workflowTelemetryFromSessionEvent extracts output preview and usage", () => {
  const update = workflowTelemetryFromSessionEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Review complete for src/server.ts." }],
      usage: {
        input: 1200,
        output: 300,
        cacheRead: 100,
        cacheWrite: 50,
        totalTokens: 1650,
        cost: { input: 0.002, output: 0.003, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0053 },
      },
    },
  } as any);

  assert.equal(update.outputPreview, "Review complete for src/server.ts.");
  assert.deepEqual(update.usage, {
    input: 1200,
    output: 300,
    cacheRead: 100,
    cacheWrite: 50,
    total: 1650,
    cost: { input: 0.002, output: 0.003, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0053 },
    turns: 1,
  });
});

test("usageFromMessages sums assistant token and cost usage", () => {
  const usage = usageFromMessages([
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [],
      usage: {
        input: 10,
        output: 20,
        cacheRead: 3,
        cacheWrite: 4,
        totalTokens: 37,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 },
      },
    },
    {
      role: "assistant",
      content: [],
      usage: {
        input: 5,
        output: 6,
        cacheRead: 0,
        cacheWrite: 1,
        totalTokens: 12,
        cost: { input: 0.05, output: 0.06, cacheRead: 0, cacheWrite: 0.01, total: 0.12 },
      },
    },
  ]);

  assert.deepEqual(usage, {
    input: 15,
    output: 26,
    cacheRead: 3,
    cacheWrite: 5,
    total: 49,
    cost: { input: 0.15000000000000002, output: 0.26, cacheRead: 0.03, cacheWrite: 0.05, total: 0.49 },
    turns: 2,
  });
});
