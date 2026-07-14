import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildDelegationPromptAppend,
  buildParallelSubagentScript,
  buildSubagentScript,
  createSubagentTool,
  DELEGATION_PROMPT_APPEND,
  DELEGATION_PROMPT_MARKER,
  resolveSubagentTasks,
} from "../src/subagent-tool.js";
import { parseWorkflowScript, runWorkflow } from "../src/workflow.js";

test("delegation prompt append is concise and names both tools", () => {
  assert.ok(DELEGATION_PROMPT_APPEND.includes("subagent"));
  assert.ok(DELEGATION_PROMPT_APPEND.includes("workflow"));
  assert.ok(DELEGATION_PROMPT_APPEND.includes("self-contained"));
  assert.ok(DELEGATION_PROMPT_APPEND.includes(DELEGATION_PROMPT_MARKER), "append carries idempotency marker");
  assert.ok(!DELEGATION_PROMPT_APPEND.includes("stronger"), "append stays model-agnostic");
  assert.ok(DELEGATION_PROMPT_APPEND.split("\n").length < 15, "prompt append must stay short");
  assert.ok(DELEGATION_PROMPT_APPEND.length < 1400, "prompt append must stay small");
});

test("buildDelegationPromptAppend is active-tool-aware", () => {
  const subagentOnly = buildDelegationPromptAppend({ subagent: true, workflow: false });
  assert.ok(subagentOnly.includes("- subagent:"));
  assert.ok(!subagentOnly.includes("- workflow:"));

  const workflowOnly = buildDelegationPromptAppend({ subagent: false, workflow: true });
  assert.ok(!workflowOnly.includes("- subagent:"));
  assert.ok(workflowOnly.includes("- workflow:"));

  assert.equal(buildDelegationPromptAppend({ subagent: false, workflow: false }), "");
});

test("subagent tool exposes model-selection prompt guidelines that name the tool", () => {
  const tool = createSubagentTool();
  assert.equal(tool.name, "subagent");
  assert.ok(tool.promptSnippet?.includes("no approval"));
  assert.ok(tool.promptSnippet?.includes("model"));
  for (const guideline of tool.promptGuidelines ?? []) {
    assert.ok(/\bsubagent\b/i.test(guideline), `guideline must name subagent: ${guideline}`);
  }
  const modelGuideline = tool.promptGuidelines?.find((line) => line.includes("deepseek-v4-flash"));
  assert.ok(modelGuideline, "guidelines include the shared model-selection table");
  assert.ok(modelGuideline?.includes("opencode-go/kimi-k2.7-code"));
  assert.ok(modelGuideline?.includes("opencode-go/glm-5.2"));
  assert.ok(modelGuideline?.includes("anthropic/claude-opus-4-8"));
  assert.ok(modelGuideline?.includes("openai-codex/gpt-5.5"));
});

test("buildSubagentScript emits a valid single-agent workflow script", () => {
  const script = buildSubagentScript({
    name: "subagent_fix_tests",
    description: "Subagent: fix tests",
    label: "fix tests",
    model: "opencode-go/kimi-k2.7-code",
    thinkingLevel: "medium",
  });

  const parsed = parseWorkflowScript(script);
  assert.equal(parsed.meta.name, "subagent_fix_tests");
  assert.equal(parsed.meta.description, "Subagent: fix tests");
  assert.ok(script.includes("await agent(args.task"));
  assert.ok(script.includes('model: "opencode-go/kimi-k2.7-code"'));
  assert.ok(script.includes('thinkingLevel: "medium"'));
});

test("buildSubagentScript omits thinkingLevel when not given and survives hostile labels", () => {
  const script = buildSubagentScript({
    name: "subagent_x",
    description: 'Subagent: quote " and \\ tricks\n',
    label: 'quote " and \\ tricks',
    model: "a/b",
  });

  const parsed = parseWorkflowScript(script);
  assert.equal(parsed.meta.name, "subagent_x");
  assert.ok(!script.includes("thinkingLevel"));
});

test("subagent script runs through the workflow runtime with the task in args", async () => {
  const script = buildSubagentScript({
    name: "subagent_echo",
    description: "Subagent: echo",
    label: "echo",
    model: "test/model",
    thinkingLevel: "high",
  });

  const calls: Array<{ prompt: string; options: any }> = [];
  const result = await runWorkflow(script, {
    args: { task: "Do the narrow thing in src/a.ts" },
    agent: {
      async run(prompt: string, options: any) {
        calls.push({ prompt, options });
        return "done answer";
      },
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, "Do the narrow thing in src/a.ts");
  assert.equal(calls[0].options.label, "echo");
  assert.equal(calls[0].options.model, "test/model");
  assert.equal(calls[0].options.thinkingLevel, "high");
  assert.deepEqual(result.result, { output: "done answer" });
  assert.deepEqual(result.phases, ["Task"]);
  assert.equal(result.agentCount, 1);
});

test("subagent tool runs without approval, writes an auto-approved artifact, and surfaces agent failure", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagent-tool-"));
  const widgetKeys: string[] = [];
  try {
    const tool = createSubagentTool({ cwd });
    // ctx has no ui.confirm: proves no approval prompt is required. The fake
    // model ref cannot resolve, so the single agent fails and the tool must
    // surface that as an error instead of returning empty output.
    await assert.rejects(
      () =>
        tool.execute(
          "call-1",
          {
            task: "Summarize src/index.ts exports",
            model: "opencode-go/kimi-k2.7-code",
            thinkingLevel: "low",
            label: "summarize exports",
          },
          undefined,
          undefined,
          {
            cwd: "/ignored",
            hasUI: true,
            ui: {
              setWidget(key: string) {
                widgetKeys.push(key);
              },
              setStatus() {},
            },
            modelRegistry: undefined,
            model: undefined,
          } as any,
        ),
      /subagent "summarize exports" failed/,
    );

    // The auto-approved artifact was written before the run started.
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(join(cwd, ".pi", "workflows"));
    assert.equal(files.length, 1);
    assert.match(files[0], /^\d{8}T\d{6}Z-subagent_summarize_exports\.workflow\.js$/);
    const persisted = await readFile(join(cwd, ".pi", "workflows", files[0]), "utf8");
    assert.ok(persisted.includes("await agent(args.task"));

    // TUI parity: the shared display path rendered under the subagent widget key.
    assert.ok(widgetKeys.length > 0, "widget updates were rendered");
    assert.ok(
      widgetKeys.every((key) => key === "subagent"),
      `all widget updates use the subagent key: ${widgetKeys.join(",")}`,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("subagent success returns output text and auto-approved review metadata in details", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagent-success-"));
  try {
    const tool = createSubagentTool({
      cwd,
      agent: {
        async run(prompt: string, options: any) {
          assert.equal(prompt, "Do the task");
          assert.equal(options.model, "opencode-go/kimi-k2.7-code");
          return "the answer";
        },
      },
    });

    const result = await tool.execute(
      "call-1",
      { task: "Do the task", model: "opencode-go/kimi-k2.7-code", label: "do task" },
      undefined,
      undefined,
      { cwd, hasUI: false } as any,
    );

    assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", "the answer");
    const details = result.details as any;
    assert.equal(details.review.approved, true);
    assert.equal(details.review.status, "auto");
    assert.equal(details.review.approvalMode, "auto");
    assert.equal(details.agentCount, 1);
    assert.equal(details.doneCount, 1);
    assert.deepEqual(details.result, { output: "the answer" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("subagent and workflow share the same frontier model-selection guidance", async () => {
  const { createWorkflowTool } = await import("../src/workflow-tool.js");
  const subagent = createSubagentTool();
  const workflow = createWorkflowTool();
  const subagentModels = subagent.promptGuidelines?.find((line) => line.includes("deepseek-v4-flash"));
  const workflowJudges = workflow.promptGuidelines?.find((line) => line.includes("claude-opus-4-8"));
  assert.ok(subagentModels?.includes("thinkingLevel 'xhigh'"));
  assert.ok(workflowJudges?.includes("thinkingLevel: 'xhigh'"));
  for (const ref of ["opencode-go/glm-5.2", "anthropic/claude-opus-4-8", "openai-codex/gpt-5.5"]) {
    assert.ok(subagentModels?.includes(ref), `subagent guidance includes ${ref}`);
    assert.ok(workflowJudges?.includes(ref), `workflow guidance includes ${ref}`);
  }
});

test("buildParallelSubagentScript emits a valid multi-agent workflow script", () => {
  const script = buildParallelSubagentScript({ name: "subagent_fan_out", description: "Subagent: fan out" });
  const parsed = parseWorkflowScript(script);
  assert.equal(parsed.meta.name, "subagent_fan_out");
  assert.ok(script.includes("await parallel("));
  assert.ok(script.includes("args.tasks"));
});

test("resolveSubagentTasks applies defaults, overrides, and fallback labels", () => {
  const resolved = resolveSubagentTasks(
    [
      { task: "a" },
      { task: "b", model: "x/y", thinkingLevel: "high", label: "custom label" },
      { task: "c", label: "  " },
    ],
    { model: "default/model", thinkingLevel: "low" },
  );
  assert.deepEqual(resolved[0], {
    task: "a",
    options: { label: "task 1", model: "default/model", thinkingLevel: "low" },
  });
  assert.deepEqual(resolved[1], { task: "b", options: { label: "custom label", model: "x/y", thinkingLevel: "high" } });
  assert.deepEqual(resolved[2], {
    task: "c",
    options: { label: "task 3", model: "default/model", thinkingLevel: "low" },
  });

  const noThinking = resolveSubagentTasks([{ task: "a" }], { model: "m/n" });
  assert.ok(!("thinkingLevel" in noThinking[0].options));
});

test("parallel subagent script runs tasks through the workflow runtime with per-task options", async () => {
  const script = buildParallelSubagentScript({ name: "subagent_fan_out", description: "Subagent: fan out" });
  const tasks = resolveSubagentTasks(
    [
      { task: "first task", label: "first" },
      { task: "second task", model: "other/model", thinkingLevel: "high" },
    ],
    { model: "base/model", thinkingLevel: "low" },
  );

  const calls: Array<{ prompt: string; options: any }> = [];
  const result = await runWorkflow(script, {
    args: { tasks },
    agent: {
      async run(prompt: string, options: any) {
        calls.push({ prompt, options });
        return `answer for ${prompt}`;
      },
    },
  });

  assert.equal(calls.length, 2);
  const first = calls.find((call) => call.prompt === "first task");
  const second = calls.find((call) => call.prompt === "second task");
  assert.equal(first?.options.label, "first");
  assert.equal(first?.options.model, "base/model");
  assert.equal(first?.options.thinkingLevel, "low");
  assert.equal(second?.options.label, "task 2");
  assert.equal(second?.options.model, "other/model");
  assert.equal(second?.options.thinkingLevel, "high");
  assert.deepEqual(result.result, { outputs: ["answer for first task", "answer for second task"] });
  assert.equal(result.agentCount, 2);
});

test("subagent tool with tasks returns labeled sections in task order", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagent-parallel-"));
  try {
    const tool = createSubagentTool({
      cwd,
      agent: {
        async run(prompt: string) {
          return `out:${prompt}`;
        },
      },
    });

    const result = await tool.execute(
      "call-1",
      {
        tasks: [{ task: "alpha", label: "alpha check" }, { task: "beta" }],
        model: "opencode-go/kimi-k2.7-code",
        label: "fan out checks",
      },
      undefined,
      undefined,
      { cwd, hasUI: false } as any,
    );

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    assert.ok(text.indexOf("## alpha check\n\nout:alpha") < text.indexOf("## task 2\n\nout:beta"));
    const details = result.details as any;
    assert.equal(details.agentCount, 2);
    assert.equal(details.review.status, "auto");

    // Artifact was written like the single-task path.
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(join(cwd, ".pi", "workflows"));
    assert.equal(files.length, 1);
    assert.match(files[0], /^\d{8}T\d{6}Z-subagent_fan_out_checks\.workflow\.js$/);
    const persisted = await readFile(join(cwd, ".pi", "workflows", files[0]), "utf8");
    assert.ok(persisted.includes("await parallel("));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("subagent tool with tasks surfaces partial failure inline and rejects when all fail", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagent-parallel-fail-"));
  try {
    const tool = createSubagentTool({
      cwd,
      agent: {
        async run(prompt: string) {
          if (prompt.includes("bad")) throw new Error("boom");
          return `ok:${prompt}`;
        },
      },
    });

    const partial = await tool.execute(
      "call-1",
      {
        tasks: [
          { task: "good one", label: "good" },
          { task: "bad one", label: "bad" },
        ],
        model: "a/b",
      },
      undefined,
      undefined,
      { cwd, hasUI: false } as any,
    );
    const text = partial.content[0]?.type === "text" ? partial.content[0].text : "";
    assert.ok(text.includes("## good\n\nok:good one"));
    assert.ok(text.includes("## bad\n\nFAILED: boom"));

    await assert.rejects(
      () =>
        tool.execute(
          "call-2",
          { tasks: [{ task: "bad a" }, { task: "bad b" }], model: "a/b", label: "all fail" },
          undefined,
          undefined,
          { cwd, hasUI: false } as any,
        ),
      /all 2 parallel tasks failed/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("subagent tool validates task/tasks input shapes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagent-validate-"));
  try {
    const tool = createSubagentTool({ cwd });
    const ctx = { cwd, hasUI: false } as any;
    await assert.rejects(
      () => tool.execute("c1", { task: "x", tasks: [{ task: "y" }], model: "a/b" }, undefined, undefined, ctx),
      /either task or tasks, not both/,
    );
    await assert.rejects(
      () => tool.execute("c2", { tasks: [], model: "a/b" }, undefined, undefined, ctx),
      /at least one task/,
    );
    await assert.rejects(
      () => tool.execute("c3", { model: "a/b" }, undefined, undefined, ctx),
      /requires task or tasks/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("subagent tool aborts before starting when signal is already aborted", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagent-abort-"));
  try {
    const tool = createSubagentTool({ cwd });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () =>
        tool.execute("call-1", { task: "x", model: "a/b" }, controller.signal, undefined, { cwd, hasUI: false } as any),
      /aborted/i,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
