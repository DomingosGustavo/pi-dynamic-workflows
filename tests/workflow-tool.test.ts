import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recomputeWorkflowSnapshot } from "../src/display.js";
import { createWorkflowTool, prepareWorkflowReview, slugWorkflowName } from "../src/workflow-tool.js";

test("createWorkflowTool describes phases as optional and dynamic", () => {
  const tool = createWorkflowTool();

  assert.match(tool.promptSnippet ?? "", /export const meta = \{ name: 'short_snake_case', description:/);
  assert.doesNotMatch(tool.promptSnippet ?? "", /phases: \[/);
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("meta.phases is optional metadata")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("Phase names may be conditional or built in a loop")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("live TUI shows each subagent's model")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("opencode-go/kimi-k2.7-code")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("opencode-go/deepseek-v4-flash")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("opencode-go/qwen3.7-max")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("opencode-go/minimax-m3")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("opencode-go/mimo-v2.5-pro")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("opencode-go/glm-5.2")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("anthropic/claude-opus-4-8")));
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
    assert.equal(review.script, "export const meta = { name: 'Security Review!', description: 'Review' }\nreturn {}\n");
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
    const value = await agent('This must not run', { label: 'should not run' })
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
  const script = "export const meta = { name: 'no_ui', description: 'No UI' }\nreturn await agent('x', { label: 'x' })";

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
