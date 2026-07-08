import assert from "node:assert/strict";
import test from "node:test";
import {
  createToolUpdateWorkflowDisplay,
  createWorkflowSnapshot,
  recomputeWorkflowSnapshot,
  renderWorkflowLines,
  renderWorkflowText,
  type WorkflowAgentSnapshot,
  type WorkflowSnapshot,
} from "../src/display.js";

function snapshot(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  return recomputeWorkflowSnapshot({
    name: "demo_workflow",
    phases: [],
    logs: [],
    agents: [],
    agentCount: 0,
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
    skippedCount: 0,
    ...overrides,
  });
}

function agent(overrides: Partial<WorkflowAgentSnapshot> = {}): WorkflowAgentSnapshot {
  return {
    id: 1,
    label: "scan repo",
    phase: "Scan",
    prompt: "Scan the repo",
    status: "done",
    ...overrides,
  };
}

test("createWorkflowSnapshot does not pre-render declared phases", () => {
  const value = createWorkflowSnapshot({
    name: "demo_workflow",
    description: "A useful workflow",
    phases: [{ title: "Scan" }, { title: "Review" }],
  });

  assert.deepEqual(value.phases, []);
});

test("renderWorkflowLines hides empty phase rows", () => {
  const lines = renderWorkflowLines(
    snapshot({
      phases: ["Scan", "Review"],
      agents: [agent()],
    }),
  );

  assert.ok(lines.some((line) => line.includes("Scan 1/1")));
  assert.ok(!lines.some((line) => line.includes("Review 0/0")));
});

test("renderWorkflowLines keeps the current empty phase visible", () => {
  const lines = renderWorkflowLines(
    snapshot({
      phases: ["Scan"],
      currentPhase: "Scan",
    }),
  );

  assert.ok(lines.some((line) => line.includes("▶ Scan 0/0")));
});

test("renderWorkflowLines groups agents by phase even when the phase was not pre-recorded", () => {
  const lines = renderWorkflowLines(
    snapshot({
      phases: ["Scan"],
      agents: [agent({ id: 2, label: "review diff", phase: "Review" })],
    }),
  );

  assert.ok(lines.some((line) => line.includes("Review 1/1")));
  assert.ok(!lines.some((line) => line.trim() === "Unphased"));
});

test("renderWorkflowLines renders runtime-created phases from the phase list", () => {
  const lines = renderWorkflowLines(
    snapshot({
      phases: ["Inspect API"],
      agents: [agent({ label: "inspect api", phase: "Inspect API" })],
    }),
  );

  assert.ok(lines.some((line) => line.includes("Inspect API 1/1")));
});

test("renderWorkflowText respects log limits", () => {
  const text = renderWorkflowText(
    snapshot({
      logs: ["first", "second", "third"],
    }),
    true,
    { maxLogs: 1 },
  );

  assert.doesNotMatch(text, /log: first/);
  assert.doesNotMatch(text, /log: second/);
  assert.match(text, /log: third/);
});

test("renderWorkflowLines separates logs from progress", () => {
  const lines = renderWorkflowLines(
    snapshot({
      agents: [agent()],
      logs: ["finished scan"],
    }),
  );

  const logIndex = lines.findIndex((line) => line.includes("log: finished scan"));
  assert.ok(logIndex > 0);
  assert.equal(lines[logIndex - 1], "");
});

test("renderWorkflowLines shows rich model, effort, activity, previews, and usage", () => {
  const lines = renderWorkflowLines(
    snapshot({
      agents: [
        agent({
          status: "running",
          model: "anthropic/claude-sonnet-4-6",
          thinkingLevel: "high",
          activity: {
            kind: "tool_running",
            text: "running read src/auth.ts",
            toolName: "read",
            toolArgsPreview: '{"file_path":"src/auth.ts"}',
            updatedAt: 123,
          },
          promptPreview: "Audit authentication and authorization surfaces.",
          outputPreview: "Found a hardening gap in src/auth.ts.",
          usage: {
            input: 1000,
            output: 250,
            cacheRead: 100,
            cacheWrite: 0,
            total: 1350,
            cost: { input: 0.004, output: 0.008, cacheRead: 0.0001, cacheWrite: 0, total: 0.0121 },
            turns: 1,
          },
        }),
      ],
    }),
    { showModel: true, showUsage: true, showActivity: true, showPreviews: true },
  );

  const text = lines.join("\n");
  assert.match(text, /demo_workflow .*1\.4k tok/);
  assert.match(text, /anthropic\/claude-sonnet-4-6/);
  assert.match(text, /high/);
  assert.match(text, /running read src\/auth\.ts/);
  assert.match(text, /1\.4k tok in 1\.0k out 250 cacheR 100 \$0\.0121/);
  assert.match(text, /in: Audit authentication/);
  assert.match(text, /tool: read args: \{"file_path":"src\/auth\.ts"\}/);
  assert.match(text, /out: Found a hardening gap in src\/auth\.ts\./);
});

test("renderWorkflowLines keeps preview metadata out of the default inline view", () => {
  const value = snapshot({
    agents: [
      agent({
        status: "done",
        model: "anthropic/claude-sonnet-4-6",
        thinkingLevel: "medium",
        activity: {
          kind: "tool_done",
          text: "read src/auth.ts",
          toolName: "read",
          toolArgsPreview: '{"file_path":"src/auth.ts"}',
          toolResultPreview: "auth source contents",
          updatedAt: 123,
        },
        metadata: {
          cwd: "/repo",
          promptPreview: "Inspect auth",
          outputPreview: "Auth output",
        },
        promptPreview: "Inspect auth",
        outputPreview: "Auth output",
        resultPreview: "Result preview",
      }),
    ],
  });
  const text = renderWorkflowLines(value, { showModel: true, showActivity: true, showUsage: true }).join("\n");

  assert.match(text, /anthropic\/claude-sonnet-4-6/);
  assert.match(text, /medium/);
  assert.match(text, /read src\/auth\.ts/);
  assert.doesNotMatch(text, /\bin:/);
  assert.doesNotMatch(text, /\bout:/);
  assert.doesNotMatch(text, /\btool:/);
  assert.equal(value.agents[0]?.metadata?.promptPreview, "Inspect auth");
  assert.equal(value.agents[0]?.metadata?.outputPreview, "Auth output");
  assert.equal(value.agents[0]?.activity?.toolResultPreview, "auth source contents");
});

test("renderWorkflowLines has readable rich fallbacks for missing metadata", () => {
  const text = renderWorkflowLines(
    snapshot({
      agents: [agent({ status: "running", model: undefined, thinkingLevel: undefined })],
    }),
    { showModel: true, showUsage: true, showActivity: true },
  ).join("\n");

  assert.match(text, /model default/);
  assert.match(text, /effort default/);
  assert.match(text, /running/);
  assert.match(text, /tokens pending/);
  assert.doesNotMatch(text, /undefined/);
});

test("tool update display defaults to widget-only updates when UI is available", () => {
  const updates: unknown[] = [];
  const widgets: Array<{ key: string; value: string[] | undefined }> = [];
  const display = createToolUpdateWorkflowDisplay((update) => updates.push(update), {
    hasUI: true,
    ui: {
      setWidget: (key: string, value: string[] | undefined) => widgets.push({ key, value }),
      setStatus() {},
    },
  } as any);

  display.update(snapshot({ agents: [agent({ status: "running" })] }));

  assert.equal(updates.length, 0);
  assert.equal(widgets.length, 1);
  assert.equal(widgets[0]?.key, "workflow");
  assert.ok(widgets[0]?.value?.join("\n").includes("Workflow: demo_workflow"));
});

test("tool update display can clear the widget when the workflow completes", () => {
  const widgets: Array<{ key: string; value: string[] | undefined }> = [];
  const display = createToolUpdateWorkflowDisplay(
    undefined,
    {
      hasUI: true,
      ui: {
        setWidget: (key: string, value: string[] | undefined) => widgets.push({ key, value }),
        setStatus() {},
      },
    } as any,
    { clearWidgetOnComplete: true },
  );

  display.update(snapshot({ agents: [agent({ status: "running" })] }));
  display.complete(snapshot({ agents: [agent({ status: "done" })] }));

  assert.equal(widgets.at(-1)?.key, "workflow");
  assert.equal(widgets.at(-1)?.value, undefined);
});
