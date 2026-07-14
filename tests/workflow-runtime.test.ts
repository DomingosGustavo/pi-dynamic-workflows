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
const scan = await agent('scan', { model: 'test/model', label: 'scan' })
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
  await agent('review', { model: 'test/model', label: 'review' })
}

for (const area of args.areas) {
  phase('Inspect ' + area)
  await agent('inspect ' + area, { model: 'test/model', label: 'inspect ' + area })
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
const scan = agent('scan', { model: 'test/model', label: 'scan' })
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
const scan = await agent('Catalog Date.now(), Math.random(), and new Date() usage', { model: 'test/model', label: 'scan' })
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
const scan = await agent('scan at ' + date.getUTCFullYear(), { model: 'test/model', label: 'scan' })
return { nowType: typeof now, date: date instanceof Date, randomType: typeof random, rounded, scan }
`,
    { agent: fakeAgent },
  );

  assert.equal((result.result as { nowType: string }).nowType, "number");
  assert.equal((result.result as { date: boolean }).date, true);
  assert.equal((result.result as { randomType: string }).randomType, "number");
  assert.equal((result.result as { scan: string }).scan.startsWith("result:scan at "), true);
});

test("runWorkflow forwards deterministic model-routing job hints", async () => {
  let received: any;
  const result = await runWorkflow(
    `export const meta = { name: 'job_hint', description: 'Route by job' }
const output = await agent('inspect', {
  label: 'routed inspection',
  job: 'inspection',
})
return { output }`,
    {
      agent: {
        async run(_prompt: string, options: any) {
          received = options.job;
          return "ok";
        },
      } as any,
    },
  );

  assert.equal((result.result as any).output, "ok");
  assert.equal(received, "inspection");
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

await parallel([agent('scan', { model: 'test/model', label: 'scan' })])
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
const sink = await agent('sink', { model: 'test/model', label: 'sink' })
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

const value = await agent('fail please', { model: 'test/model', label: 'broken' })
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

return await agent('abort', { model: 'test/model', label: 'abort' })
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

const results = await parallel(['a', 'b', 'c'].map((item) => () => agent(item, { model: 'test/model', label: item })))
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
const results = await parallel(items.map((index) => () => agent('task ' + index, { model: 'test/model', label: 'task ' + index })))
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

agent('background', { model: 'test/model', label: 'background' })
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

await agent('x', { model: 'test/model', label: 'x' })
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

await agent('x', { model: 'test/model', label: 'x' })
const value = { ok: true }
value.self = value
return value
`,
        { agent: fakeAgent },
      ),
    /workflow result must be JSON-serializable; JSON\.stringify failed.*circular/i,
  );
});

test("explicit pause returns cooperative pause data without running agents", async () => {
  const result = await runWorkflow(
    `export const meta = { name: 'manual_pause', description: 'Pause safely' }
pause('Await user review', { checkpoint: 'design' })`,
    { agent: fakeAgent },
  );

  assert.equal(result.paused?.reason, "Await user review");
  assert.deepEqual(result.paused?.data, { checkpoint: "design" });
  assert.ok(result.paused?.key, "explicit pause must have a deterministic key");
  assert.equal(result.agentCount, 0);
  assert.equal(result.result, null);
});

test("workflow agent labels must be unique for unambiguous replay", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'duplicate_labels', description: 'Reject ambiguous checkpoints' }
await agent('one', { model: 'test/model', label: 'same' })
await agent('two', { model: 'test/model', label: 'same' })
return { ok: true }`,
        { agent: fakeAgent },
      ),
    /Duplicate workflow agent label "same"/,
  );
});

test("own-key labels like __proto__, constructor, and toString are safe", async () => {
  const result = await runWorkflow(
    `export const meta = { name: 'own_key_labels', description: 'Own-key labels' }
const a = await agent('a', { model: 'test/model', label: '__proto__' })
const b = await agent('b', { model: 'test/model', label: 'constructor' })
const c = await agent('c', { model: 'test/model', label: 'toString' })
return { a, b, c }
`,
    { agent: fakeAgent },
  );

  assert.deepEqual(result.result, { a: "result:a", b: "result:b", c: "result:c" });
  assert.deepEqual(
    result.agents.map((agent) => agent.label),
    ["__proto__", "constructor", "toString"],
  );
});

test("duplicate labels fail reliably inside parallel", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'parallel_dup', description: 'Parallel duplicate labels' }
await parallel([
  () => agent('first', { model: 'test/model', label: 'shared' }),
  () => agent('second', { model: 'test/model', label: 'shared' }),
])
return { ok: true }`,
        { agent: fakeAgent, concurrency: 2 },
      ),
    /Duplicate workflow agent label "shared"/,
  );
});

test("checkpoint replay rejects legacy checkpoints missing a fingerprint", async () => {
  const checkpoints: any[] = [];
  const script = `export const meta = { name: 'legacy_reject', description: 'Reject legacy checkpoint' }
const first = await agent('first task', { model: 'test/model', label: 'first' })
return { first }`;

  await runWorkflow(script, {
    agent: fakeAgent,
    async onAgentCheckpoint(checkpoint, tokensSpent) {
      checkpoints.push({ checkpoint, tokensSpent });
    },
  });

  const legacy = {
    model: "test/model",
    label: checkpoints[0].checkpoint.label,
    result: checkpoints[0].checkpoint.result,
  };
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: fakeAgent,
        resume: { workflowId: "legacy-1", tokensSpent: 0, completed: { first: legacy } },
      }),
    /checkpoint is missing a fingerprint/,
  );
});

test("checkpoint replay rejects fingerprint mismatches", async () => {
  const checkpoints: any[] = [];
  const script = `export const meta = { name: 'fp_mismatch', description: 'Fingerprint mismatch' }
const first = await agent('first task', { model: 'test/model', label: 'first' })
return { first }`;

  await runWorkflow(script, {
    agent: fakeAgent,
    async onAgentCheckpoint(checkpoint, tokensSpent) {
      checkpoints.push({ checkpoint, tokensSpent });
    },
  });

  const tampered = { ...checkpoints[0].checkpoint, fingerprint: "deadbeef" };
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: fakeAgent,
        resume: { workflowId: "fp-1", tokensSpent: 0, completed: { first: tampered } },
      }),
    /fingerprint mismatch/,
  );
});

test("fingerprint mismatches propagate through parallel instead of becoming null branches", async () => {
  const script = `export const meta = { name: 'parallel_fp_mismatch', description: 'Parallel fingerprint mismatch' }
const results = await parallel([() => agent('first task', { model: 'test/model', label: 'first' })])
return results`;

  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: fakeAgent,
        resume: {
          workflowId: "parallel-fp-1",
          tokensSpent: 0,
          completed: { first: { model: "test/model", label: "first", result: "stale", fingerprint: "deadbeef" } },
        },
      }),
    /fingerprint mismatch/,
  );
});

test("explicit pause resumes past an already-recorded pause", async () => {
  const script = `export const meta = { name: 'explicit_resume', description: 'Resume past pause' }
pause('Await review', { stage: 'design' })
const first = await agent('first task', { model: 'test/model', label: 'first' })
return { first }`;

  const first = await runWorkflow(script, { agent: fakeAgent });
  assert.equal(first.paused?.reason, "Await review");
  assert.ok(first.paused?.key);
  const pauseKey = first.paused?.key;
  assert.ok(pauseKey);

  const resumed = await runWorkflow(script, {
    agent: fakeAgent,
    resume: {
      workflowId: "explicit-resume-1",
      tokensSpent: 0,
      completed: {},
      acknowledgedPauseKeys: [pauseKey],
    },
  });

  assert.equal(resumed.paused, undefined);
  assert.deepEqual(resumed.result, { first: "result:first task" });
});

test("checkpoint persistence errors propagate as infrastructure errors", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'persist_fail', description: 'Persist fails' }
const first = await agent('first', { model: 'test/model', label: 'first' })
return { first }`,
        {
          agent: fakeAgent,
          async onAgentCheckpoint() {
            throw new Error("persistent store unreachable");
          },
        },
      ),
    /persistent store unreachable/,
  );
});

test("checkpoint persistence errors propagate through parallel instead of becoming null branches", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'parallel_persist_fail', description: 'Parallel persistence failure' }
const results = await parallel([() => agent('first', { model: 'test/model', label: 'first' })])
return results`,
        {
          agent: fakeAgent,
          async onAgentCheckpoint() {
            throw new Error("parallel store unreachable");
          },
        },
      ),
    /parallel store unreachable/,
  );
});

test("unawaited checkpoint persistence error is propagated after script returns", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'unawaited_ckpt', description: 'Unawaited checkpoint' }
agent('background', { model: 'test/model', label: 'background' })
return { ok: true }`,
        {
          agent: fakeAgent,
          async onAgentCheckpoint() {
            throw new Error("checkpoint persistence failed");
          },
        },
      ),
    /checkpoint persistence failed/,
  );
  // Give the unawaited agent promise's rejection handler time to run so
  // node:test does not report it as post-test asynchronous activity.
  await delay(10);
});

test("unawaited fingerprint mismatch pause signal is propagated after script returns", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'unawaited_fp', description: 'Unawaited fingerprint' }
agent('background', { model: 'test/model', label: 'background' })
return { ok: true }`,
        {
          agent: fakeAgent,
          resume: {
            workflowId: "unawaited-fp-1",
            tokensSpent: 0,
            completed: {
              background: {
                label: "background",
                result: "stale",
                fingerprint: "deadbeef",
              },
            },
          },
        },
      ),
    /fingerprint mismatch/,
  );
  await delay(10);
});

test("agent requires an explicit model or known job work type synchronously", async () => {
  const missing = `export const meta = { name: 'missing_model', description: 'Missing model' }
return await agent('inspect', { label: 'inspect' })`;
  await assert.rejects(
    runWorkflow(missing),
    /agent "inspect" must specify an explicit model or a job work type \(one of: architecture, classification, exploration, implementation, inspection, judge, planning, research, review, security-review, summarization, synthesis\)/,
  );

  const unknown = `export const meta = { name: 'unknown_job', description: 'Unknown job' }
return await agent('inspect', { label: 'inspect', job: 'nope' })`;
  await assert.rejects(
    runWorkflow(unknown),
    /Unknown workflow job type "nope"\. Known types: architecture, classification, exploration, implementation, inspection, judge, planning, research, review, security-review, summarization, synthesis/,
  );
});

test("agent without model or job inside parallel rejects the whole workflow", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'parallel_missing_model', description: 'Missing model in parallel' }
await parallel([() => agent('inspect', { label: 'inspect' })])
return { ok: true }`,
        { agent: fakeAgent },
      ),
    /agent "inspect" must specify an explicit model or a job work type/,
  );
});

test("unknown job inside pipeline rejects the whole workflow", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'pipeline_unknown_job', description: 'Unknown job in pipeline' }
await pipeline([1], () => agent('inspect', { label: 'inspect', job: 'nope' }))
return { ok: true }`,
        { agent: fakeAgent },
      ),
    /Unknown workflow job type "nope"/,
  );
});

test("agent with an explicit model but an unknown job type rejects the workflow", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'model_unknown_job', description: 'Model plus unknown job' }
return await agent('inspect', { model: 'test/model', label: 'inspect', job: 'nope' })`,
        { agent: fakeAgent },
      ),
    /Unknown workflow job type "nope"/,
  );
});

test("prototype-key job types like toString are rejected as unknown jobs", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'proto_job', description: 'Prototype job' }
return await agent('inspect', { label: 'inspect', job: 'toString' })`,
        { agent: fakeAgent },
      ),
    /Unknown workflow job type "toString"/,
  );
});

test("changing an agent's job string across resume invalidates the checkpoint fingerprint", async () => {
  const checkpoints: any[] = [];
  const script = (job: string) =>
    `export const meta = { name: 'job_fp', description: 'Job fingerprint' }
const first = await agent('first task', { model: 'test/model', label: 'first', job: '${job}' })
return { first }`;

  await runWorkflow(script("inspection"), {
    agent: fakeAgent,
    async onAgentCheckpoint(checkpoint, tokensSpent) {
      checkpoints.push({ checkpoint, tokensSpent });
    },
  });

  await assert.rejects(
    () =>
      runWorkflow(script("research"), {
        agent: fakeAgent,
        resume: {
          workflowId: "job-fp-1",
          tokensSpent: 0,
          completed: { first: checkpoints[0].checkpoint },
        },
      }),
    /fingerprint mismatch/,
  );
});

test("content-identical pause resumes across three cycles using occurrence keys", async () => {
  const script = `export const meta = { name: 'triple_pause', description: 'Repeated identical pause' }
pause('same review', { stage: 'x' })
pause('same review', { stage: 'x' })
const first = await agent('first task', { model: 'test/model', label: 'first' })
return { first }`;

  // Cycle 1: run -> pause at occurrence 1 (key K1).
  const first = await runWorkflow(script, { agent: fakeAgent });
  assert.equal(first.paused?.reason, "same review");
  const k1 = first.paused?.key ?? "";
  assert.match(k1, /^pause-[a-f0-9]{16}-1$/);

  // Cycle 2: resume acknowledging K1 -> pause again at occurrence 2 (key K2 != K1).
  const second = await runWorkflow(script, {
    agent: fakeAgent,
    resume: {
      workflowId: "triple-pause-1",
      tokensSpent: 0,
      completed: {},
      acknowledgedPauseKeys: [k1],
    },
  });
  assert.equal(second.paused?.reason, "same review");
  const k2 = second.paused?.key ?? "";
  assert.match(k2, /^pause-[a-f0-9]{16}-2$/);
  assert.notEqual(k1, k2);

  // Cycle 3: resume acknowledging K1 + K2 -> completes past both pauses.
  const third = await runWorkflow(script, {
    agent: fakeAgent,
    resume: {
      workflowId: "triple-pause-1",
      tokensSpent: 0,
      completed: {},
      acknowledgedPauseKeys: [k1, k2],
    },
  });
  assert.equal(third.paused, undefined);
  assert.deepEqual(third.result, { first: "result:first task" });
});

test("identical explicit pauses use occurrence keys and resume skips only the acknowledged occurrence", async () => {
  const script = `export const meta = { name: 'repeat_pause', description: 'Repeated pause' }
pause('same', { value: 1 })
pause('same', { value: 1 })`;
  const first = await runWorkflow(script);
  assert.match(first.paused?.key ?? "", /^pause-[a-f0-9]{16}-1$/);
  const second = await runWorkflow(script, {
    resume: {
      workflowId: "repeat",
      tokensSpent: 0,
      completed: {},
      acknowledgedPauseKeys: [first.paused?.key ?? ""],
    },
  });
  assert.equal(second.paused?.reason, "same");
  assert.match(second.paused?.key ?? "", /^pause-[a-f0-9]{16}-2$/);
  assert.notEqual(first.paused?.key, second.paused?.key);
});

test("parallel distinct pauses retain content keys when branch timing reverses", async () => {
  const script = (
    leftDelay: number,
    rightDelay: number,
  ) => `export const meta = { name: 'parallel_pause', description: 'Parallel pauses' }
await parallel([
  async () => { await new Promise(resolve => setTimeout(resolve, ${leftDelay})); pause('left', { branch: 'left' }) },
  async () => { await new Promise(resolve => setTimeout(resolve, ${rightDelay})); pause('right', { branch: 'right' }) },
])`;
  const first = await runWorkflow(script(0, 10));
  assert.equal(first.paused?.reason, "left");
  const resumed = await runWorkflow(script(10, 0), {
    resume: {
      workflowId: "parallel",
      tokensSpent: 0,
      completed: {},
      acknowledgedPauseKeys: [first.paused?.key ?? ""],
    },
  });
  assert.equal(resumed.paused?.reason, "right");
  assert.match(resumed.paused?.key ?? "", /^pause-[a-f0-9]{16}-1$/);
});
