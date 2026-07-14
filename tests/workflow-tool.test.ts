import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { recomputeWorkflowSnapshot } from "../src/display.js";
import { reduceWorkflowStateEvents, type WorkflowStateEvent, type WorkflowStateStore } from "../src/workflow-state.js";
import {
  createWorkflowTool,
  prepareWorkflowReview,
  runWorkflowScriptWithDisplay,
  slugWorkflowName,
} from "../src/workflow-tool.js";

test("createWorkflowTool describes phases as optional and dynamic", () => {
  const tool = createWorkflowTool();

  assert.match(tool.promptSnippet ?? "", /export const meta = \{ name, description \}/);
  assert.match(tool.promptSnippet ?? "", /resumeId/);
  assert.doesNotMatch(tool.promptSnippet ?? "", /phases: \[/);
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("meta.phases is optional metadata")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("Phase names may be conditional or built in a loop")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("live TUI shows each subagent's model")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("opencode-go/kimi-k2.7-code")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("opencode-go/deepseek-v4-flash")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("opencode-go/minimax-m3")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("opencode-go/glm-5.2")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("anthropic/claude-opus-4-8")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("openai-codex/gpt-5.5")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("thinkingLevel: 'xhigh'")));
});

test("slugWorkflowName creates stable safe slugs", () => {
  assert.equal(slugWorkflowName("Security Review!"), "security-review");
  assert.equal(slugWorkflowName("___"), "___");
  assert.equal(slugWorkflowName("   "), "workflow");
});

test("workflow tool result renderer does not echo the workflow progress panel into chat", () => {
  const tool = createWorkflowTool({ approvalMode: "auto" });
  const snapshot = recomputeWorkflowSnapshot({
    name: "render_defaults",
    phases: ["Scan"],
    logs: [],
    agentCount: 1,
    runningCount: 0,
    doneCount: 1,
    errorCount: 0,
    skippedCount: 0,
    agents: [
      {
        id: 1,
        label: "scan repo",
        phase: "Scan",
        prompt: "Scan auth code",
        status: "done",
        model: "opencode-go/kimi-k2.7-code",
        thinkingLevel: "medium",
        promptPreview: "Scan auth code",
        outputPreview: "Auth output",
        resultPreview: "Result output",
        activity: {
          kind: "tool_done",
          text: "read src/auth.ts",
          toolName: "read",
          toolArgsPreview: '{"file_path":"src/auth.ts"}',
          toolResultPreview: "auth source contents",
          updatedAt: 123,
        },
      },
    ],
  });
  const rendered = tool
    .renderResult?.(
      {
        content: [{ type: "text", text: "Workflow render_defaults completed with 1 agent(s)." }],
        details: snapshot,
      },
      { isPartial: false },
      {
        fg: (_key: string, value: string) => value,
        bold: (value: string) => value,
      } as any,
    )
    .render(160)
    .join("\n");

  assert.match(rendered ?? "", /Workflow render_defaults completed with 1 agent/);
  assert.doesNotMatch(rendered ?? "", /◆ Workflow/);
  assert.doesNotMatch(rendered ?? "", /opencode-go\/kimi-k2\.7-code/);
  assert.doesNotMatch(rendered ?? "", /\bin:/);
  assert.doesNotMatch(rendered ?? "", /\bout:/);
  assert.doesNotMatch(rendered ?? "", /\btool:/);
});

test("prepareWorkflowReview writes normalized script under the review directory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-review-"));
  try {
    const review = await prepareWorkflowReview(
      "  export const meta = { name: 'Security Review!', description: 'Review' }\nreturn {}\n  ",
      { name: "Security Review!", description: "Review" },
      cwd,
      {
        approvalMode: "interactive",
        now: new Date("2026-06-22T23:59:58.123Z"),
      },
    );

    assert.equal(review.path, join(cwd, ".pi", "workflows", "20260622T235958Z-security-review.workflow.js"));
    assert.equal(review.status, "pending");
    assert.equal(review.approved, false);
    assert.equal(review.approvalMode, "interactive");
    assert.match(review.script, /^\/\/ Pi workflow review artifact\./);
    assert.match(review.script, /full host privileges, not inside a sandbox/);
    assert.match(
      review.script,
      /export const meta = \{ name: 'Security Review!', description: 'Review' \}\nreturn \{\}\n$/,
    );
    assert.equal(await readFile(review.path, "utf8"), review.script);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("createWorkflowTool rejection returns review metadata and starts no agents", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-reject-"));
  const updates: Array<{ content: Array<{ type: "text"; text: string }>; details: any }> = [];
  const tool = createWorkflowTool({ cwd });
  const script = `
    export const meta = { name: 'needs_review', description: 'Needs approval' }
    const value = await agent('This must not run', { model: 'test/model', label: 'should not run' })
    return { value }
  `;

  try {
    const result = await tool.execute("call-1", { script }, undefined, (update) => updates.push(update), {
      cwd,
      hasUI: true,
      ui: {
        confirm: async () => false,
        setWidget() {},
        setStatus() {},
      },
    } as any);

    const details = result.details as any;
    assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /was not run/);
    assert.equal(details.agentCount, 0);
    assert.deepEqual(details.agents, []);
    assert.equal(details.review.status, "rejected");
    assert.equal(details.review.approved, false);
    assert.match(details.review.path, /\.pi\/workflows\/\d{8}T\d{6}Z-needs_review\.workflow\.js$/);
    assert.equal(await readFile(details.review.path, "utf8"), details.review.script);
    assert.ok(updates.some((update) => update.content[0]?.text.includes("Workflow ready for review")));
    assert.ok(updates.some((update) => update.content[0]?.text.includes("```js")));
    assert.ok(updates.some((update) => update.content[0]?.text.includes("should not run")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("createWorkflowTool interactive mode fails clearly without UI", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-no-ui-"));
  const tool = createWorkflowTool({ cwd });
  const script =
    "export const meta = { name: 'no_ui', description: 'No UI' }\nreturn await agent('x', { model: 'test/model', label: 'x' })";

  try {
    await assert.rejects(
      () =>
        tool.execute("call-1", { script }, undefined, undefined, {
          cwd,
          hasUI: false,
        } as any),
      /workflow approval requires an interactive UI/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runWorkflowScriptWithDisplay completes a happy path with a fake agent runner", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-display-happy-"));
  const updates: Array<{ content: Array<{ type: "text"; text: string }>; details: any }> = [];
  const meta = { name: "display_happy", description: "Run with fake agent" };
  const script = `export const meta = { name: 'display_happy', description: 'Run with fake agent' }
phase('Scan')
const scan = await agent('scan repo', { model: 'test/model', label: 'scan repo' })
return { scan }
`;
  const agent = {
    async run(prompt: string, options: any): Promise<{ answer: string }> {
      const metadata = {
        cwd,
        usage: {
          input: 2,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          total: 3,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        activity: { kind: "done", text: "done", updatedAt: 1 },
      };
      options.onUpdate?.(metadata);
      options.onMetadata?.(metadata);
      return { answer: prompt };
    },
  };

  try {
    const { result, snapshot } = await runWorkflowScriptWithDisplay(script, meta, {
      cwd,
      agent,
      onUpdate: (update) => updates.push(update),
      ctx: { hasUI: false },
    });

    assert.deepEqual(result.result, { scan: { answer: "scan repo" } });
    assert.equal(snapshot.agentCount, 1);
    assert.equal(snapshot.doneCount, 1);
    assert.equal(snapshot.usage?.total, 3);
    assert.ok(updates.some((update) => update.content[0]?.text.includes("Workflow completed")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runWorkflowScriptWithDisplay marks running agents skipped when aborted", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-display-abort-"));
  const controller = new AbortController();
  const updates: Array<{ content: Array<{ type: "text"; text: string }>; details: any }> = [];
  let rejectRun: (reason?: unknown) => void = () => {};
  const blocker = new Promise<never>((_resolve, reject) => {
    rejectRun = reject;
  });
  let started = 0;
  const agent = {
    async run(): Promise<never> {
      started++;
      if (started === 2) {
        const error = new Error("stop all work");
        error.name = "AbortError";
        controller.abort();
        rejectRun(error);
      }
      return blocker;
    },
  };
  const meta = { name: "abort_display", description: "Abort display" };
  const script = `export const meta = { name: 'abort_display', description: 'Abort display' }
const first = agent('first', { model: 'test/model', label: 'first' })
const second = agent('second', { model: 'test/model', label: 'second' })
return await Promise.all([first, second])
`;

  try {
    await assert.rejects(
      () =>
        runWorkflowScriptWithDisplay(script, meta, {
          cwd,
          agent,
          signal: controller.signal,
          concurrency: 2,
          onUpdate: (update) => updates.push(update),
          ctx: { hasUI: false },
        }),
      (error: any) => error?.name === "AbortError" && /Workflow was aborted/.test(error.message),
    );

    const finalDetails = updates.at(-1)?.details;
    assert.equal(finalDetails.skippedCount, 2);
    assert.deepEqual(
      finalDetails.agents.map((agentSnapshot: any) => agentSnapshot.status),
      ["skipped", "skipped"],
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runWorkflowScriptWithDisplay rejects scripts that never call agent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-zero-agent-"));
  const meta = { name: "zero_agent", description: "No agents" };
  const script = "export const meta = { name: 'zero_agent', description: 'No agents' }\nreturn { ok: true }";

  try {
    await assert.rejects(
      () => runWorkflowScriptWithDisplay(script, meta, { cwd, ctx: { hasUI: false } }),
      /workflow scripts must call agent\(\) at least once/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("createWorkflowTool auto-approval records auto review metadata before running", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-auto-"));
  const updates: Array<{ content: Array<{ type: "text"; text: string }>; details: any }> = [];
  const tool = createWorkflowTool({ cwd, approvalMode: "auto" });
  const script = "export const meta = { name: 'auto_mode', description: 'Auto mode' }\nreturn { ok: true }";

  try {
    await assert.rejects(
      () =>
        tool.execute("call-1", { script }, undefined, (update) => updates.push(update), {
          cwd,
          hasUI: false,
        } as any),
      /workflow scripts must call agent\(\) at least once/,
    );

    assert.ok(updates[0]?.content[0]?.text.includes("approvalMode is auto"));
    assert.equal(updates[0]?.details.review.approvalMode, "auto");
    assert.match(updates[0]?.details.review.path, /auto_mode\.workflow\.js$/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("prepareWorkflowReview writes collision-safe artifact filenames", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-collision-"));
  const now = new Date("2026-06-22T23:59:58.123Z");
  const meta = { name: "collision_demo", description: "Collision demo" };
  const script = "export const meta = { name: 'collision_demo', description: 'Collision demo' }\nreturn {}\n";

  try {
    const first = await prepareWorkflowReview(script, meta, cwd, { approvalMode: "interactive", now });
    const second = await prepareWorkflowReview(script, meta, cwd, { approvalMode: "interactive", now });

    assert.notEqual(first.path, second.path);
    assert.match(first.path, /20260622T235958Z-collision_demo\.workflow\.js$/);
    assert.match(second.path, /20260622T235958123Z-collision_demo-[a-f0-9]{8}\.workflow\.js$/);
    assert.equal(await readFile(first.path, "utf8"), first.script);
    assert.equal(await readFile(second.path, "utf8"), second.script);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow tool appends interrupted event when execution throws", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-interrupt-"));
  const events: WorkflowStateEvent[] = [];
  const store: WorkflowStateStore = {
    append(event) {
      events.push(event);
    },
    get(id) {
      return reduceWorkflowStateEvents(events).get(id);
    },
    list() {
      return [...reduceWorkflowStateEvents(events).values()];
    },
  };
  const agent = {
    async run(prompt: string, options: any) {
      options.onMetadata?.({
        cwd,
        usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1, cost: { total: 0 } },
      });
      return `done:${prompt}`;
    },
  };
  const tool = createWorkflowTool({ cwd, approvalMode: "auto", stateStore: store, agent: agent as any });
  const script = `export const meta = { name: 'interrupt_tool', description: 'Interrupt tool' }
const a = await agent('a', { model: 'test/model', label: 'a' })
throw new Error('boom')
return { a }`;

  try {
    await assert.rejects(
      () => tool.execute("call-1", { script }, undefined, undefined, { cwd, hasUI: false } as any),
      /boom/,
    );

    const created = events.find((event) => event.kind === "created");
    assert.ok(created);
    assert.ok(created?.workflowId);
    const state = store.get(created.workflowId);
    assert.equal(state?.status, "interrupted");
    assert.equal(state?.interruption?.reason, "boom");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow tool appends interrupted event and preserves original hostile error", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-hostile-error-"));
  const events: WorkflowStateEvent[] = [];
  const store: WorkflowStateStore = {
    append(event) {
      events.push(event);
    },
    get(id) {
      return reduceWorkflowStateEvents(events).get(id);
    },
    list() {
      return [...reduceWorkflowStateEvents(events).values()];
    },
  };
  const agent = {
    async run(prompt: string, options: any) {
      options.onMetadata?.({
        cwd,
        usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1, cost: { total: 0 } },
      });
      return `done:${prompt}`;
    },
  };
  const tool = createWorkflowTool({ cwd, approvalMode: "auto", stateStore: store, agent: agent as any });
  const script = `export const meta = { name: 'hostile_error_wf', description: 'Hostile error wf' }
class HostileError extends Error {
  get message() { throw new Error('evil getter') }
}
const err = new HostileError()
err.sentinel = true
const a = await agent('a', { model: 'test/model', label: 'a' })
throw err
return { a }`;

  let thrown: unknown;
  try {
    await tool.execute("call-1", { script }, undefined, undefined, { cwd, hasUI: false } as any);
    assert.fail("expected tool.execute to throw");
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error, "expected the original error to be rethrown");
  assert.equal((thrown as { sentinel?: unknown }).sentinel, true, "expected the original hostile error identity");

  const created = events.find((event) => event.kind === "created");
  assert.ok(created);
  assert.ok(created?.workflowId);
  const state = store.get(created.workflowId);
  assert.equal(state?.status, "interrupted");
  assert.match(state?.interruption?.reason ?? "", /\[object Error\]/);

  await rm(cwd, { recursive: true, force: true });
});

test("latest resume filters to paused or interrupted workflows", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-latest-"));
  const events: WorkflowStateEvent[] = [];
  const store: WorkflowStateStore = {
    append(event) {
      events.push(event);
    },
    get(id) {
      return reduceWorkflowStateEvents(events).get(id);
    },
    list() {
      return [...reduceWorkflowStateEvents(events).values()];
    },
  };
  const tool = createWorkflowTool({ cwd, approvalMode: "auto", stateStore: store });
  const pauseScript = (name: string) =>
    `export const meta = { name: '${name}', description: '${name}' }\npause('wait')`;
  const meta = { name: "latest_filter", description: "Latest filter" };

  try {
    // Running and completed workflows must be ignored by `latest`.
    events.push({
      kind: "created",
      workflowId: "wf-running",
      script: "script",
      meta,
      timestamp: 1,
    });
    events.push({
      kind: "created",
      workflowId: "wf-completed",
      script: "script",
      meta,
      timestamp: 2,
    });
    events.push({
      kind: "completed",
      workflowId: "wf-completed",
      tokensSpent: 0,
      timestamp: 3,
    });

    const paused = await tool.execute("call-paused", { script: pauseScript("paused_wf") }, undefined, undefined, {
      cwd,
      hasUI: false,
    } as any);
    await tool
      .execute(
        "call-interrupted",
        {
          script: `export const meta = { name: 'interrupted_wf', description: 'interrupted_wf' }\nthrow new Error('crash')`,
        },
        undefined,
        undefined,
        { cwd, hasUI: false } as any,
      )
      .catch(() => undefined);

    const latest = store
      .list()
      .filter((state) => state.status === "paused" || state.status === "interrupted")
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .at(-1);
    assert.equal(latest?.meta.name, "interrupted_wf");
    assert.equal(latest?.status, "interrupted");

    // Resuming via `latest` should pick the interrupted workflow.
    const resumed = await tool
      .execute("call-latest", { resumeId: "latest" }, undefined, undefined, {
        cwd,
        hasUI: false,
      } as any)
      .catch((error: unknown) => error);
    assert.ok(resumed instanceof Error, "resuming the interrupted workflow should rethrow its error");
    assert.match((resumed as Error).message, /crash/);

    const pausedId = (paused.details as any).workflowId as string;
    assert.notEqual(pausedId, latest?.id);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow tool resumes across two sequential explicit pauses and then completes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-explicit-pauses-"));
  const events: WorkflowStateEvent[] = [];
  const store: WorkflowStateStore = {
    append(event) {
      events.push(event);
    },
    get(id) {
      return reduceWorkflowStateEvents(events).get(id);
    },
    list() {
      return [...reduceWorkflowStateEvents(events).values()];
    },
  };
  const calls: string[] = [];
  const agent = {
    async run(prompt: string, options: any) {
      calls.push(prompt);
      options.onMetadata?.({
        cwd,
        usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1, cost: { total: 0 } },
      });
      return `done:${prompt}`;
    },
  };
  const tool = createWorkflowTool({ cwd, approvalMode: "auto", stateStore: store, agent: agent as any });
  const script = `export const meta = { name: 'two_pauses', description: 'Two pauses' }
if (!args.resumed) pause('first review')
if (!args.resumed) pause('second review')
const a = await agent('a', { model: 'test/model', label: 'a' })
return { a }`;

  try {
    const first = await tool.execute("call-1", { script, args: { resumed: false } }, undefined, undefined, {
      cwd,
      hasUI: false,
    } as any);
    const id = (first.details as any).resumeId as string;
    assert.match(first.content[0]?.type === "text" ? first.content[0].text : "", /paused/);
    assert.deepEqual(calls, []);
    assert.equal(store.get(id)?.pause?.key, first.details.paused?.key);

    const second = await tool.execute("call-2", { resumeId: id }, undefined, undefined, { cwd, hasUI: false } as any);
    assert.match(second.content[0]?.type === "text" ? second.content[0].text : "", /paused/);
    assert.notEqual(second.details.paused?.key, first.details.paused?.key);
    assert.deepEqual(calls, []);

    const final = await tool.execute("call-3", { resumeId: id }, undefined, undefined, { cwd, hasUI: false } as any);
    assert.match(final.content[0]?.type === "text" ? final.content[0].text : "", /completed/);
    assert.deepEqual(calls, ["a"]);
    assert.deepEqual((final.details as any).result, { a: "done:a" });
    assert.equal(store.get(id)?.status, "completed");
    assert.deepEqual(store.get(id)?.acknowledgedPauseKeys, [first.details.paused?.key, second.details.paused?.key]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow tool best-effort appends interrupted when terminal completed persistence fails", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-completed-storage-error-"));
  const events: WorkflowStateEvent[] = [];
  const appendedKinds: string[] = [];
  const storageError = new Error("disk full");
  const store: WorkflowStateStore = {
    append(event) {
      appendedKinds.push(event.kind);
      // Flaky store: only the terminal 'completed' event fails to persist.
      if (event.kind === "completed") throw storageError;
      events.push(event);
    },
    get(id) {
      return reduceWorkflowStateEvents(events).get(id);
    },
    list() {
      return [...reduceWorkflowStateEvents(events).values()];
    },
  };
  const agent = {
    async run(prompt: string, options: any) {
      options.onMetadata?.({
        cwd,
        usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1, cost: { total: 0 } },
      });
      return `done:${prompt}`;
    },
  };
  const tool = createWorkflowTool({ cwd, approvalMode: "auto", stateStore: store, agent: agent as any });
  const script = `export const meta = { name: 'completed_storage_error', description: 'Completed storage error' }
const a = await agent('a', { model: 'test/model', label: 'a' })
return { a }`;

  try {
    // The tool must reject with the ORIGINAL storage error, not the interruption.
    await assert.rejects(
      () => tool.execute("call-1", { script }, undefined, undefined, { cwd, hasUI: false } as any),
      /disk full/,
    );

    // A best-effort 'interrupted' event was still appended so the workflow is
    // not stuck in 'running' forever and can be resumed.
    assert.ok(appendedKinds.includes("interrupted"), "expected a best-effort interrupted append");
    const state = store.list()[0];
    assert.ok(state);
    assert.equal(state.status, "interrupted");
    assert.match(state.interruption?.reason ?? "", /terminal state persistence failed: disk full/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow tool best-effort appends interrupted when terminal pause persistence fails", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-terminal-storage-error-"));
  const events: WorkflowStateEvent[] = [];
  const appendedKinds: string[] = [];
  const storageError = new Error("disk full");
  const store: WorkflowStateStore = {
    append(event) {
      appendedKinds.push(event.kind);
      if (event.kind === "paused") throw storageError;
      events.push(event);
    },
    get(id) {
      return reduceWorkflowStateEvents(events).get(id);
    },
    list() {
      return [...reduceWorkflowStateEvents(events).values()];
    },
  };
  const agent = {
    async run(prompt: string, options: any) {
      options.onMetadata?.({
        cwd,
        usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1, cost: { total: 0 } },
      });
      return `done:${prompt}`;
    },
  };
  const tool = createWorkflowTool({ cwd, approvalMode: "auto", stateStore: store, agent: agent as any });
  const script = `export const meta = { name: 'storage_error', description: 'Storage error' }
await agent('a', { model: 'test/model', label: 'a' })
pause('checkpoint')`;

  try {
    await assert.rejects(
      () => tool.execute("call-1", { script }, undefined, undefined, { cwd, hasUI: false } as any),
      /disk full/,
    );

    assert.ok(appendedKinds.includes("interrupted"), "expected a best-effort interrupted append");
    const state = store.list()[0];
    assert.ok(state);
    assert.equal(state.status, "interrupted");
    assert.match(state.interruption?.reason ?? "", /terminal state persistence failed: disk full/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow tool surfaces the original error when stateStore.get throws during the catch path", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-get-throw-"));
  const events: WorkflowStateEvent[] = [];
  const appendedKinds: string[] = [];
  const getError = new Error("store get failed");
  const store: WorkflowStateStore = {
    append(event) {
      appendedKinds.push(event.kind);
      events.push(event);
    },
    get() {
      throw getError;
    },
    list() {
      return [...reduceWorkflowStateEvents(events).values()];
    },
  };
  const agent = {
    async run(prompt: string, options: any) {
      options.onMetadata?.({
        cwd,
        usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1, cost: { total: 0 } },
      });
      return `done:${prompt}`;
    },
  };
  const tool = createWorkflowTool({ cwd, approvalMode: "auto", stateStore: store, agent: agent as any });
  const script = `export const meta = { name: 'get_throw', description: 'Store get throws' }
await agent('a', { model: 'test/model', label: 'a' })
throw new Error('boom')`;

  try {
    await assert.rejects(
      () => tool.execute("call-1", { script }, undefined, undefined, { cwd, hasUI: false } as any),
      /boom/,
    );

    assert.ok(appendedKinds.includes("interrupted"), "expected a best-effort interrupted append");
    const state = store.list()[0];
    assert.ok(state);
    assert.equal(state.status, "interrupted");
    assert.equal(state.interruption?.reason, "boom");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow tool executes sequentially to avoid sibling resume races", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-seq-"));
  const events: WorkflowStateEvent[] = [];
  const store: WorkflowStateStore = {
    append(event) {
      events.push(event);
    },
    get(id) {
      return reduceWorkflowStateEvents(events).get(id);
    },
    list() {
      return [...reduceWorkflowStateEvents(events).values()];
    },
  };
  let running = 0;
  let maxRunning = 0;
  const agent = {
    async run(prompt: string, options: any) {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await delay(20);
      options.onMetadata?.({
        cwd,
        usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1, cost: { total: 0 } },
      });
      running--;
      return `done:${prompt}`;
    },
  };
  const tool = createWorkflowTool({ cwd, approvalMode: "auto", stateStore: store, agent: agent as any });
  const script = `export const meta = { name: 'seq', description: 'Sequential' }
await agent('x', { model: 'test/model', label: 'x' })
return { ok: true }`;

  try {
    const [a, b] = await Promise.all([
      tool.execute("call-1", { script }, undefined, undefined, { cwd, hasUI: false } as any),
      tool.execute("call-2", { script }, undefined, undefined, { cwd, hasUI: false } as any),
    ]);
    assert.ok(a);
    assert.ok(b);
    assert.equal(maxRunning, 1, `expected sequential execution, but ${maxRunning} agents ran concurrently`);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
