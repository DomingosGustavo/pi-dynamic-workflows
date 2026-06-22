import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkflowModel } from "../src/agent.js";

const models = [
  { provider: "anthropic", id: "claude-sonnet-4-6" },
  { provider: "openai-codex", id: "gpt-5.4-mini" },
  { provider: "opencode", id: "gpt-5.4-mini" },
] as any[];

const registry = {
  find(provider: string, id: string) {
    return models.find((model) => model.provider === provider && model.id === id);
  },
  getAll() {
    return models;
  },
};

test("resolveWorkflowModel resolves provider/id strings", () => {
  const model = resolveWorkflowModel(registry as any, "anthropic/claude-sonnet-4-6");

  assert.equal(model?.provider, "anthropic");
  assert.equal(model?.id, "claude-sonnet-4-6");
});

test("resolveWorkflowModel resolves provider/id objects", () => {
  const model = resolveWorkflowModel(registry as any, { provider: "openai-codex", id: "gpt-5.4-mini" });

  assert.equal(model?.provider, "openai-codex");
  assert.equal(model?.id, "gpt-5.4-mini");
});

test("resolveWorkflowModel resolves unambiguous bare ids", () => {
  const model = resolveWorkflowModel(registry as any, "claude-sonnet-4-6");

  assert.equal(model?.provider, "anthropic");
});

test("resolveWorkflowModel rejects ambiguous bare ids", () => {
  assert.throws(
    () => resolveWorkflowModel(registry as any, "gpt-5.4-mini"),
    /Ambiguous workflow agent model "gpt-5\.4-mini"/,
  );
});

test("resolveWorkflowModel rejects unknown models", () => {
  assert.throws(() => resolveWorkflowModel(registry as any, "anthropic/nope"), /Unknown workflow agent model/);
  assert.throws(() => resolveWorkflowModel(registry as any, "nope"), /Unknown workflow agent model/);
  assert.throws(() => resolveWorkflowModel(registry as any, { provider: "anthropic" }), /must include provider and id/);
});
