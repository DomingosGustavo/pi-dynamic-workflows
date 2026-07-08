import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
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
    /workflow result must be JSON-serializable; did you forget to await agent\(\), parallel\(\), or pipeline\(\)\?.*Promise.*cloned/,
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
    id: 1,
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

test("runWorkflow rejects promise-vs-thunk misuse of parallel", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = {
  name: 'bad_parallel',
  description: 'Pass promises to parallel instead of thunks'
}

await parallel([agent('scan', { label: 'scan' })])
return { ok: true }
`,
        { agent: fakeAgent },
      ),
    /parallel\(\) expects an array of functions, not promises/,
  );
});

test("runWorkflow turns throwing pipeline stages into null branches and logs", async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'pipeline_failures',
  description: 'Handle throwing pipeline stages'
}

const values = await pipeline(
  [1, 2, 3],
  (value) => {
    if (value === 2) throw new Error('bad item ' + value)
    return value * 2
  },
  (value) => value + 1,
)
const sink = await agent('sink', { label: 'sink' })
return { values, sink }
`,
    { agent: fakeAgent },
  );

  assert.deepEqual((result.result as { values: unknown[] }).values, [3, null, 7]);
  assert.match(result.logs.join("\n"), /pipeline\[1\] failed: bad item 2/);
});

test("runWorkflow records structured agent errors and returns null branches", async () => {
  const agent = {
    async run(_prompt: string, options: any): Promise<string> {
      options.onMetadata?.({ cwd: "/tmp/failing-agent" });
      const error = new Error("runner exploded");
      error.name = "RunnerFailure";
      throw error;
    },
  };

  const result = await runWorkflow(
    `export const meta = {
  name: 'agent_failure',
  description: 'Record failed agent branches'
}

const value = await agent('fail please', { label: 'broken' })
return { value }
`,
    { agent },
  );

  assert.deepEqual(result.result, { value: null });
  assert.equal(result.agents[0]?.status, "error");
  assert.equal(result.agents[0]?.result, null);
  assert.equal(result.agents[0]?.error?.name, "RunnerFailure");
  assert.equal(result.agents[0]?.error?.message, "runner exploded");
  assert.equal(result.agents[0]?.metadata?.error?.name, "RunnerFailure");
  assert.equal(result.agents[0]?.metadata?.error?.message, "runner exploded");
  assert.match(result.logs.join("\n"), /agent broken failed: runner exploded/);
});

test("runWorkflow rethrows AbortError from agent runners", async () => {
  const agent = {
    async run(): Promise<never> {
      const error = new Error("stop now");
      error.name = "AbortError";
      throw error;
    },
  };

  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = {
  name: 'abort_rethrow',
  description: 'Rethrow aborts'
}

return await agent('abort', { label: 'abort' })
`,
        { agent },
      ),
    (error: any) => error?.name === "AbortError" && /stop now/.test(error.message),
  );
});

test("runWorkflow preserves parallel result order under low concurrency", async () => {
  const agent = {
    async run(prompt: string): Promise<string> {
      await delay(prompt === "a" ? 30 : prompt === "b" ? 5 : 10);
      return prompt.toUpperCase();
    },
  };

  const result = await runWorkflow(
    `export const meta = {
  name: 'parallel_order',
  description: 'Keep input order'
}

const results = await parallel(['a', 'b', 'c'].map((item) => () => agent(item, { label: item })))
return results
`,
    { agent, concurrency: 2 },
  );

  assert.deepEqual(result.result, ["A", "B", "C"]);
});

test("runWorkflow limiter never exceeds the configured concurrency under races", async () => {
  let active = 0;
  let maxActive = 0;
  const agent = {
    async run(prompt: string): Promise<string> {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(5);
      active--;
      return prompt;
    },
  };

  const result = await runWorkflow(
    `export const meta = {
  name: 'limiter_race',
  description: 'Bound concurrent agents'
}

const items = Array.from({ length: 25 }, (_, index) => index)
const results = await parallel(items.map((index) => () => agent('task ' + index, { label: 'task ' + index })))
return { count: results.length }
`,
    { agent, concurrency: 3 },
  );

  assert.equal((result.result as { count: number }).count, 25);
  assert.equal(result.agentCount, 25);
  assert.equal(maxActive <= 3, true, `max active agents was ${maxActive}`);
});

test("runWorkflow awaits unawaited agent calls at script return and logs a warning", async () => {
  let ended = false;
  const agent = {
    async run(prompt: string): Promise<string> {
      await delay(5);
      return `done:${prompt}`;
    },
  };

  const result = await runWorkflow(
    `export const meta = {
  name: 'unawaited_agent',
  description: 'Await unawaited agents after return'
}

agent('background', { label: 'background' })
return { ok: true }
`,
    {
      agent,
      onAgentEnd() {
        ended = true;
      },
    },
  );

  assert.deepEqual(result.result, { ok: true });
  assert.equal(ended, true);
  assert.equal(result.agentCount, 1);
  assert.match(result.logs.join("\n"), /awaited 1 unawaited agent\(\) call/);
});

test("runWorkflow rejects BigInt workflow results as non-JSON-serializable", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = {
  name: 'bigint_result',
  description: 'Reject bigint result'
}

await agent('x', { label: 'x' })
return { value: 1n }
`,
        { agent: fakeAgent },
      ),
    /workflow result must be JSON-serializable; JSON\.stringify failed.*BigInt/,
  );
});

test("runWorkflow rejects cyclic workflow results as non-JSON-serializable", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = {
  name: 'cyclic_result',
  description: 'Reject cyclic result'
}

await agent('x', { label: 'x' })
const value = { ok: true }
value.self = value
return value
`,
        { agent: fakeAgent },
      ),
    /workflow result must be JSON-serializable; JSON\.stringify failed.*circular/i,
  );
});
