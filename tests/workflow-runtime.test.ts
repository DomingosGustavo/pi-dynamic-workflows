import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflow } from "../src/workflow.js";

const fakeAgent = {
  async run(prompt: string): Promise<string> {
    return `result:${prompt}`;
  },
};

test("runWorkflow accepts metadata without phases and records runtime phases", async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'dynamic_demo',
  description: 'Use runtime phases'
}

phase('Scan')
const scan = await agent('scan', { label: 'scan' })
return { scan }
`,
    { agent: fakeAgent },
  );

  assert.deepEqual(result.phases, ["Scan"]);
  assert.equal(result.agentCount, 1);
  assert.equal((result.result as { scan: string }).scan, "result:scan");
});

test("runWorkflow records loop-created phases without skipped conditional phases", async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'loop_demo',
  description: 'Create phases from work items',
  phases: [{ title: 'Review' }]
}

if (args.needsReview) {
  phase('Review')
  await agent('review', { label: 'review' })
}

for (const area of args.areas) {
  phase('Inspect ' + area)
  await agent('inspect ' + area, { label: 'inspect ' + area })
}

return { ok: true }
`,
    {
      args: { needsReview: false, areas: ["API", "UI"] },
      agent: fakeAgent,
    },
  );

  assert.deepEqual(result.phases, ["Inspect API", "Inspect UI"]);
  assert.equal(result.agentCount, 2);
});

test("runWorkflow rejects unawaited nested agent promises before returning details", async () => {
  let ended = 0;

  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = {
  name: 'promise_leak',
  description: 'Return an unawaited agent promise'
}

phase('Leak promise')
const scan = agent('scan', { label: 'scan' })
return { scan }
`,
        {
          agent: fakeAgent,
          onAgentEnd() {
            ended++;
          },
        },
      ),
    /workflow result must be structured-cloneable; did you forget to await agent\(\), parallel\(\), or pipeline\(\)\?.*Promise.*cloned/,
  );

  assert.equal(ended, 1);
});

test("runWorkflow rejects non-string runtime phase titles", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = {
  name: 'bad_phase',
  description: 'Use a non-string phase title'
}

phase(Promise.resolve('Scan'))
return { ok: true }
`,
        { agent: fakeAgent },
      ),
    /phase title must be a string/,
  );
});

test("runWorkflow allows prompts that mention nondeterministic API names", async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'prompt_mentions',
  description: 'Ask about Date.now(), Math.random(), and new Date() usage'
}

phase('Catalog mentions')
const scan = await agent('Catalog Date.now(), Math.random(), and new Date() usage', { label: 'scan' })
return { scan }
`,
    { agent: fakeAgent },
  );

  assert.equal(
    (result.result as { scan: string }).scan,
    "result:Catalog Date.now(), Math.random(), and new Date() usage",
  );
});

test("runWorkflow allows normal JavaScript Date and Math APIs", async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'normal_js',
  description: 'Use normal JavaScript APIs'
}

const now = Date.now()
const date = new Date(now)
const random = Math.random()
const rounded = Math.floor(random * 10)
const scan = await agent('scan at ' + date.getUTCFullYear(), { label: 'scan' })
return { nowType: typeof now, date: date instanceof Date, randomType: typeof random, rounded, scan }
`,
    { agent: fakeAgent },
  );

  assert.equal((result.result as { nowType: string }).nowType, "number");
  assert.equal((result.result as { date: boolean }).date, true);
  assert.equal((result.result as { randomType: string }).randomType, "number");
  assert.equal((result.result as { scan: string }).scan.startsWith("result:scan at "), true);
});

test("runWorkflow forwards model, thinkingLevel, isolation, and metadata", async () => {
  const calls: Array<{ prompt: string; options: any }> = [];
  const starts: unknown[] = [];
  const updates: unknown[] = [];
  const ends: unknown[] = [];
  const agent = {
    async run(prompt: string, options: any): Promise<string> {
      calls.push({ prompt, options });
      options.onUpdate?.({
        cwd: "/tmp/worktree/project",
        model: { provider: "anthropic", id: "claude-sonnet-4-6" },
        thinkingLevel: options.thinkingLevel,
        activity: {
          kind: "tool_running",
          text: "running read src/auth.ts",
          toolName: "read",
          toolArgsPreview: '{"file_path":"src/auth.ts"}',
          updatedAt: 100,
        },
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          total: 15,
          cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
        },
      });
      options.onMetadata?.({
        cwd: "/tmp/worktree/project",
        model: { provider: "anthropic", id: "claude-sonnet-4-6" },
        thinkingLevel: options.thinkingLevel,
        worktree: {
          path: "/tmp/worktree",
          cwd: "/tmp/worktree/project",
          kept: false,
          status: "",
          diff: "",
        },
      });
      return `result:${prompt}`;
    },
  };

  const result = await runWorkflow(
    `export const meta = {
  name: 'forwarding_demo',
  description: 'Forward per-agent controls'
}

phase('Review')
const review = await agent('review', {
  label: 'security review',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-6' },
  thinkingLevel: 'high',
  isolation: { mode: 'worktree', dirty: 'ignore', merge: 'none' },
})
return { review }
`,
    {
      agent: agent as any,
      onAgentStart(event) {
        starts.push(event);
      },
      onAgentUpdate(event) {
        updates.push(event);
      },
      onAgentEnd(event) {
        ends.push(event);
      },
    },
  );

  assert.equal(result.agentCount, 1);
  assert.equal(calls[0].prompt, "review");
  assert.deepEqual(calls[0].options.model, { provider: "anthropic", id: "claude-sonnet-4-6" });
  assert.equal(calls[0].options.thinkingLevel, "high");
  assert.deepEqual(calls[0].options.isolation, { mode: "worktree", dirty: "ignore", merge: "none" });
  assert.deepEqual(starts[0], {
    label: "security review",
    phase: "Review",
    prompt: "review",
    model: { provider: "anthropic", id: "claude-sonnet-4-6" },
    thinkingLevel: "high",
    isolation: { mode: "worktree", dirty: "ignore", merge: "none" },
  });
  assert.deepEqual((ends[0] as any).metadata.model, { provider: "anthropic", id: "claude-sonnet-4-6" });
  assert.equal((ends[0] as any).metadata.worktree.path, "/tmp/worktree");
  assert.equal((updates[0] as any).label, "security review");
  assert.equal((updates[0] as any).phase, "Review");
  assert.equal((updates[0] as any).metadata.activity.text, "running read src/auth.ts");
  assert.equal((updates[0] as any).metadata.usage.total, 15);
});
