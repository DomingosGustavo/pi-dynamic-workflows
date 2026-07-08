import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
// Opt-in, portable e2e target. Point PI_E2E_REPO (preferred) or FINTRACK_CWD at
// an existing repository to run the FinTrack audit workflow; otherwise the test
// self-skips with a clean pass so CI and other machines are not tied to a
// hardcoded local path.
const E2E_REPO = process.env.PI_E2E_REPO ?? process.env.FINTRACK_CWD ?? "";
const FINTRACK_CWD = E2E_REPO;
const PREFERRED_WORKHORSE_REFS = [
  "opencode-go/kimi-k2.7-code",
  "opencode-go/deepseek-v4-flash",
  "opencode-go/qwen3.7-max",
  "opencode-go/minimax-m3",
  "opencode-go/mimo-v2.5-pro",
];
const FALLBACK_WORKHORSE_REFS = [
  "opencode-go/kimi-k2.6",
  "opencode-go/deepseek-v4-flash",
  "opencode-go/qwen3.7-max",
  "opencode-go/minimax-m2.7",
  "opencode-go/mimo-v2.5-pro",
];

interface RecordedWorkflowCall {
  script: string;
  details?: WorkflowSnapshot & {
    meta?: unknown;
    result?: unknown;
    logs?: string[];
    durationMs?: number;
    review?: {
      path: string;
      script: string;
      approved: boolean;
      approvalMode: string;
      status: string;
    };
  };
}

test("parent Pi model generates and runs a FinTrack audit workflow", { timeout: 1000 * 60 * 20 }, async (t) => {
  if (!FINTRACK_CWD || !existsSync(FINTRACK_CWD)) {
    t.skip("set PI_E2E_REPO (or FINTRACK_CWD) to an existing repository path to run the FinTrack audit e2e");
    return;
  }

  const beforeStatus = await gitStatus(FINTRACK_CWD);
  const reviewDir = await mkdtemp(join(tmpdir(), "fintrack-workflow-reviews-"));
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
  const workhorseRefs = uniqueRefs(
    [...PREFERRED_WORKHORSE_REFS, ...FALLBACK_WORKHORSE_REFS].filter((ref) => availableModels.has(ref)),
  ).slice(0, 5);
  assert.ok(
    workhorseRefs.length >= 4,
    `FinTrack e2e requires at least four runnable workhorse refs; got ${workhorseRefs}`,
  );
  const unsupportedEnabledRefs = enabledModels.filter((ref) => !availableModels.has(ref));
  assert.ok(
    enabledModels.length > 0,
    `FinTrack e2e expected Pi settings to have enabled models; unsupported configured refs: ${unsupportedEnabledRefs.join(", ")}`,
  );

  const defaultProvider = settings.defaultProvider ?? "anthropic";
  const defaultModelId = settings.defaultModel ?? "claude-opus-4-8";
  const parentModel =
    modelRegistry.find(defaultProvider, defaultModelId) ??
    modelRegistry.find("anthropic", "claude-sonnet-4-6") ??
    modelRegistry.find("anthropic", "claude-opus-4-8");
  assert.ok(
    parentModel,
    `no runnable parent model is available; configured default is ${defaultProvider}/${defaultModelId}`,
  );

  const recordedCalls: RecordedWorkflowCall[] = [];
  const baseWorkflowTool = createWorkflowTool({
    cwd: FINTRACK_CWD,
    concurrency: 4,
    approvalMode: "auto",
    reviewDir,
  });
  const recordingWorkflowTool: ToolDefinition<any, any> = {
    ...baseWorkflowTool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const input = params as WorkflowToolInput;
      const call: RecordedWorkflowCall = { script: input.script };
      recordedCalls.push(call);
      const agentCallCount = (input.script.match(/\bagent\s*\(/g) ?? []).length;
      if (agentCallCount !== 4) {
        throw new Error(
          `FinTrack e2e generated workflow must call exactly four agent() subagents, got ${agentCallCount}`,
        );
      }
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
        "Generate a compact bounded workflow that finishes quickly: exactly four parallel project-inspection subagents total, with no additional synthesis or judge subagent.",
        "The workflow script should synthesize by returning a plain JSON-serializable object containing the four concise reports plus prioritized security and improvement fields derived from those reports.",
        `Use currently supported open-weight workhorse model refs where useful, including these runnable refs from this Pi registry: ${workhorseRefs.join(", ")}.`,
        `Keep every subagent tiny: inspect only ${E2E_REPO}, read at most 4 files per inspection agent, and make each agent return at most 8 bullets.`,
        "Do not run broad filesystem scans such as `find /`, do not run package-manager commands, do not run tests/builds, do not install dependencies, and do not access network resources.",
        `Prefer project-local commands only: \`pwd\`, \`git status --short\`, \`rg --files ${E2E_REPO} | head\`, \`rg -n ... ${E2E_REPO}/src | head\`, and targeted \`sed -n\`/\`cat\` for files under ${E2E_REPO}.`,
        "Every agent() call must include isolation: { mode: 'worktree', dirty: 'ignore', merge: 'none' } so the parent FinTrack working tree remains unchanged.",
        "No agent should write files; the workflow must return the final audit data as its result only.",
        "This test harness auto-approves workflow execution, but the tool must still record review path/script metadata.",
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
  assert.ok(call.details.review, "workflow tool did not return review metadata");
  assert.equal(call.details.review.status, "auto");
  assert.equal(call.details.review.approved, true);
  assert.equal(call.details.review.approvalMode, "auto");
  assert.ok(
    call.details.review.path.startsWith(reviewDir),
    `review path was outside test review dir: ${call.details.review.path}`,
  );
  assert.equal(await readFile(call.details.review.path, "utf8"), call.details.review.script);
  assert.equal(call.details.review.script.trim(), call.script.trim());
  assert.equal(call.details.agentCount, 4, `expected exactly four subagents, got ${call.details.agentCount}`);

  const agents = call.details.agents ?? [];
  assert.ok(
    agents.some((agent) => agent.model || agent.metadata?.model),
    `generated workflow did not request or resolve per-agent models. Generated script:\n${call.script}`,
  );
  assert.ok(
    agents.some((agent) => modelRefText(agent.model ?? agent.metadata?.model).startsWith("opencode-go/")),
    `generated workflow did not use a runnable opencode-go workhorse/judge. Generated script:\n${call.script}`,
  );
  assert.ok(
    agents.some((agent) => agent.isolation || agent.metadata?.worktree),
    `generated workflow did not use worktree isolation. Generated script:\n${call.script}`,
  );
  assert.ok(
    agents.every((agent) => agent.isolation || agent.metadata?.worktree),
    `every generated subagent must use worktree isolation. Generated script:\n${call.script}`,
  );

  const auditText = `${JSON.stringify(call.details.result ?? "")}\n${lastAssistantText(session.messages)}`;
  assert.match(auditText, /security|hardening|vulnerab|risk/i);
  assert.match(auditText, /improvement|priority|prioritized|recommend/i);
  assert.match(auditText, /src\/[A-Za-z0-9_./-]+/);

  const afterStatus = await gitStatus(FINTRACK_CWD);
  assert.equal(afterStatus, beforeStatus, "FinTrack parent working tree changed during workflow e2e");
  await rm(reviewDir, { recursive: true, force: true });
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

function uniqueRefs(refs: string[]): string[] {
  return [...new Set(refs)];
}

function modelRefText(model: unknown): string {
  if (!model) return "";
  if (typeof model === "string") return model;
  if (typeof model !== "object") return "";
  const value = model as { provider?: string; id?: string };
  if (value.provider && value.id) return `${value.provider}/${value.id}`;
  return value.id ?? value.provider ?? "";
}
