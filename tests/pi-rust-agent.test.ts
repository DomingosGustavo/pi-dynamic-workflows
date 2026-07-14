import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { isPiRustAvailable, PiRustWorkflowAgent } from "../src/pi-rust-agent.js";
import { runWorkflow } from "../src/workflow.js";

interface FakePiRustOptions {
  text?: string;
  error?: string;
  exitCode?: number;
  delayMs?: number;
}

test("pi-rust runner returns final assistant text and reports usage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rust-agent-"));
  try {
    const binary = await writeFakePiRust(dir, { text: "final answer" });
    let metadata: any;
    const result = await new PiRustWorkflowAgent({ binary }).run("say hi", {
      onMetadata(value) {
        metadata = value;
      },
    });

    assert.equal(result, "final answer");
    assert.ok(metadata.usage.total > 0);
    assert.equal(metadata.activity.kind, "done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pi-rust runner validates fenced final JSON for schema runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rust-schema-"));
  try {
    const binary = await writeFakePiRust(dir, { text: '```json\n{"ok":true}\n```' });
    const schema = Type.Object({ ok: Type.Boolean() });
    const result = await new PiRustWorkflowAgent({ binary }).run("return json", { schema });

    assert.deepEqual(result, { ok: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pi-rust runner rejects schema runs with validation errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rust-invalid-schema-"));
  try {
    const binary = await writeFakePiRust(dir, { text: '```json\n{"ok":"no"}\n```' });
    const schema = Type.Object({ ok: Type.Boolean() });

    await assert.rejects(
      () => new PiRustWorkflowAgent({ binary }).run("return json", { schema }),
      /schema validation/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pi-rust runner rejects non-zero exits and agent_end errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rust-fail-"));
  try {
    const binary = await writeFakePiRust(dir, { text: "bad", error: "model exploded", exitCode: 1 });

    await assert.rejects(
      () => new PiRustWorkflowAgent({ binary }).run("fail"),
      /pi-rust subagent failed: model exploded/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pi-rust runner aborts the child process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rust-abort-"));
  try {
    const binary = await writeFakePiRust(dir, { delayMs: 30_000 });
    const controller = new AbortController();
    const promise = new PiRustWorkflowAgent({ binary }).run("wait", { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);

    await assert.rejects(promise, (error: any) => error?.name === "AbortError");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pi-rust runner rejects custom in-process tools", async () => {
  const agent = new PiRustWorkflowAgent({ binary: "/nonexistent/pi-rust" });

  await assert.rejects(() => agent.run("tool", { tools: [{} as any] }), /does not support custom in-process tools/);
});

test("isPiRustAvailable checks nonexistent and executable binaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rust-available-"));
  try {
    const binary = await writeFakePiRust(dir, { text: "ok" });

    assert.equal(isPiRustAvailable("definitely-not-a-pi-rust-binary-name"), false);
    assert.equal(isPiRustAvailable(binary), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runWorkflow honors explicit agent injection when runner is pi-rust", async () => {
  const script = [
    "export const meta = { name: 'runner_injection', description: 'runner injection' }",
    "phase('Task')",
    "return await agent('hello', { label: 'hello', model: 'test/model' })",
  ].join("\n");
  let called = false;

  const result = await runWorkflow(script, {
    runner: "pi-rust",
    agent: {
      async run(prompt: string) {
        called = true;
        assert.equal(prompt, "hello");
        return "injected";
      },
    },
  });

  assert.equal(called, true);
  assert.equal(result.result, "injected");
});

async function writeFakePiRust(dir: string, options: FakePiRustOptions): Promise<string> {
  const binary = join(dir, "pi-rust");
  const script = `#!/usr/bin/env node
const config = ${JSON.stringify(options)};
const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0.001 } };
const message = { role: "assistant", content: [{ type: "text", text: config.text ?? "ok" }], usage };
console.log(JSON.stringify({ type: "agent_start", sessionId: "fake" }));
if (config.delayMs) {
  setTimeout(() => {}, config.delayMs);
} else {
  console.log(JSON.stringify({ type: "turn_start", sessionId: "fake" }));
  console.log(JSON.stringify({ type: "message_end", message }));
  console.log(JSON.stringify({ type: "agent_end", sessionId: "fake", messages: [message], ...(config.error ? { error: config.error } : {}) }));
  if (config.exitCode) console.error("fake pi-rust failure");
  process.exit(config.exitCode ?? 0);
}
`;
  await writeFile(binary, script, "utf8");
  await chmod(binary, 0o755);
  return binary;
}
