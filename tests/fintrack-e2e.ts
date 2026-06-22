import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  AuthStorage,
  createAgentSession,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createWorkflowTool,
  parseWorkflowScript,
  type WorkflowSnapshot,
  type WorkflowToolInput,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
const FINTRACK_CWD = "/home/gustavo/fintrack";
const REQUIRED_MODEL_REFS = [
  "anthropic/claude-sonnet-4-6",
  "opencode/big-pickle",
  "openai-codex/gpt-5.5",
  "openai-codex/gpt-5.4-mini",
  "openai-codex/gpt-5.4",
  "anthropic/claude-opus-4-7",
  "anthropic/claude-haiku-4-5",
  "anthropic/claude-sonnet-4-5",
  "anthropic/claude-opus-4-8",
];

interface RecordedWorkflowCall {
  script: string;
  details?: WorkflowSnapshot & {
    meta?: unknown;
    result?: unknown;
    logs?: string[];
    durationMs?: number;
  };
}

test("parent Pi model generates and runs a FinTrack audit workflow", { timeout: 1000 * 60 * 20 }, async () => {
  const beforeStatus = await gitStatus(FINTRACK_CWD);
  const agentDir = getAgentDir();
  const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
  const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
  const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as {
    defaultProvider?: string;
    defaultModel?: string;
    defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    enabledModels?: string[];
  };
  const enabledModels = settings.enabledModels ?? [];
  const availableModels = new Set(modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`));
  const missing = REQUIRED_MODEL_REFS.filter((ref) => !enabledModels.includes(ref) || !availableModels.has(ref));
  assert.deepEqual(missing, [], "FinTrack e2e requires the expected Pi enabled models to be available");

  const defaultProvider = settings.defaultProvider ?? "anthropic";
  const defaultModelId = settings.defaultModel ?? "claude-opus-4-8";
  const parentModel = modelRegistry.find(defaultProvider, defaultModelId);
  assert.ok(parentModel, `default parent model is unavailable: ${defaultProvider}/${defaultModelId}`);

  const recordedCalls: RecordedWorkflowCall[] = [];
  const baseWorkflowTool = createWorkflowTool({ cwd: FINTRACK_CWD, concurrency: 4 });
  const recordingWorkflowTool: ToolDefinition<any, any> = {
    ...baseWorkflowTool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const input = params as WorkflowToolInput;
      const call: RecordedWorkflowCall = { script: input.script };
      recordedCalls.push(call);
      const result = await baseWorkflowTool.execute(toolCallId, params, signal, onUpdate, ctx);
      call.details = result.details as RecordedWorkflowCall["details"];
      return result;
    },
  };

  const { session } = await createAgentSession({
    cwd: FINTRACK_CWD,
    agentDir,
    modelRegistry,
    model: parentModel,
    thinkingLevel: settings.defaultThinkingLevel ?? "medium",
    sessionManager: SessionManager.inMemory(FINTRACK_CWD),
    settingsManager: SettingsManager.create(FINTRACK_CWD, agentDir),
    customTools: [recordingWorkflowTool],
  });

  try {
    session.setActiveToolsByName([...new Set([...session.getActiveToolNames(), "workflow"])]);
    await session.prompt(
      [
        "Use the workflow tool to explore this FinTrack project, find improvement areas and security issues, and return prioritized actionable findings with file references.",
        "You must generate the workflow script yourself through the workflow tool; do not answer with a manual audit.",
        "Make the generated workflow run at least four real project-inspection subagents plus any final synthesis you need.",
        "Use currently enabled model refs where useful, including anthropic/claude-opus-4-8, anthropic/claude-sonnet-4-6, openai-codex/gpt-5.4-mini, and anthropic/claude-haiku-4-5.",
        "Every project-inspection agent() call must include isolation: { mode: 'worktree', dirty: 'ignore', merge: 'none' } so the parent FinTrack working tree remains unchanged.",
        "Only a final synthesis agent may omit isolation, and only if it works exclusively from prior subagent results.",
        "The final workflow result must include reviewed areas, security findings or hardening gaps, prioritized improvement areas, and concrete file references.",
      ].join("\n"),
    );
  } finally {
    session.dispose();
  }

  assert.ok(recordedCalls.length > 0, "parent model did not call the workflow tool");
  const call = recordedCalls.at(-1);
  assert.ok(call);
  assert.doesNotThrow(() => parseWorkflowScript(call.script));
  assert.match(call.script, /\bagent\s*\(/, "generated workflow should call agent()");
  assert.ok(call.details, "workflow tool did not return details");
  assert.ok(call.details.agentCount >= 4, `expected at least four subagents, got ${call.details.agentCount}`);

  const agents = call.details.agents ?? [];
  assert.ok(
    agents.some((agent) => agent.model || agent.metadata?.model),
    `generated workflow did not request or resolve per-agent models. Generated script:\n${call.script}`,
  );
  assert.ok(
    agents.some((agent) => agent.isolation || agent.metadata?.worktree),
    `generated workflow did not use worktree isolation. Generated script:\n${call.script}`,
  );

  const auditText = `${JSON.stringify(call.details.result ?? "")}\n${lastAssistantText(session.messages)}`;
  assert.match(auditText, /security|hardening|vulnerab|risk/i);
  assert.match(auditText, /improvement|priority|prioritized|recommend/i);
  assert.match(auditText, /src\/[A-Za-z0-9_./-]+/);

  const afterStatus = await gitStatus(FINTRACK_CWD);
  assert.equal(afterStatus, beforeStatus, "FinTrack parent working tree changed during workflow e2e");
});

async function gitStatus(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["status", "--short"], { cwd, encoding: "utf8" });
  return stdout.trimEnd();
}

function lastAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("");
    if (text.trim()) return text;
  }
  return "";
}
