import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  createToolUpdateWorkflowDisplay,
  createWorkflowSnapshot,
  preview,
  recomputeWorkflowSnapshot,
  type WorkflowSnapshot,
} from "./display.js";
import type { WorkflowModelCatalog } from "./model-selection.js";
import type { WorkflowApprovalMode, WorkflowReviewMetadata } from "./options.js";
import {
  parseWorkflowScript,
  runWorkflow,
  type WorkflowMeta,
  type WorkflowRunOptions,
  type WorkflowRunResult,
} from "./workflow.js";
import type { WorkflowCompletedCheckpoint, WorkflowStateStore } from "./workflow-state.js";

const workflowToolSchema = Type.Object({
  script: Type.Optional(
    Type.String({
      description: [
        "Required raw JavaScript workflow script, with no Markdown fences.",
        "First statement: export const meta = { name: 'short_snake_case', description: 'non-empty description' }. meta.phases is optional documentation; live progress is driven by phase(title).",
        "Use phase('Name'), pause(reason, data), agent(prompt, opts), parallel(arrayOfFunctions), pipeline(items, ...stages), log(message), and args. The workflow must call agent() at least once unless it pauses.",
        "parallel() requires functions, not promises: await parallel(items.map(item => () => agent(...))).",
      ].join(" "),
    }),
  ),
  resumeId: Type.Optional(
    Type.String({
      description:
        "Resume by id, or use 'latest' for the newest paused/interrupted workflow on the active Pi session branch. Omit script.",
    }),
  ),
  args: Type.Optional(
    Type.Any({ description: "Optional JSON value exposed to the workflow script as global `args`." }),
  ),
});

export type WorkflowToolInput = {
  script?: string;
  resumeId?: string;
  args?: unknown;
};

const workflowDisplayOptions: WorkflowDisplayRunOptions = {
  key: "workflow",
  clearWidgetOnComplete: true,
  maxAgents: 6,
  maxLogs: 2,
  showResultPreviews: false,
  showModel: true,
  showUsage: true,
  showActivity: true,
  showPreviews: false,
  previewWidth: 104,
};

export interface WorkflowDisplayRunOptions {
  key: string;
  clearWidgetOnComplete: boolean;
  maxAgents: number;
  maxLogs: number;
  showResultPreviews: boolean;
  showModel: boolean;
  showUsage: boolean;
  showActivity: boolean;
  showPreviews: boolean;
  previewWidth: number;
}

export function defaultWorkflowDisplayOptions(key: string): WorkflowDisplayRunOptions {
  return { ...workflowDisplayOptions, key };
}

export interface RunWorkflowScriptOptions {
  cwd: string;
  args?: unknown;
  concurrency?: number;
  modelCatalog?: WorkflowModelCatalog;
  resume?: WorkflowRunOptions["resume"];
  onAgentCheckpoint?: WorkflowRunOptions["onAgentCheckpoint"];
  signal?: AbortSignal;
  review?: WorkflowReviewMetadata;
  displayOptions?: WorkflowDisplayRunOptions;
  /** Injectable agent runner (tests). Defaults to a real WorkflowAgent. */
  agent?: WorkflowRunOptions["agent"];
  onUpdate?: Parameters<typeof createToolUpdateWorkflowDisplay>[0];
  ctx: {
    modelRegistry?: unknown;
    model?: unknown;
    ui?: unknown;
    hasUI?: boolean;
  };
}

/**
 * Run a parsed workflow script with the shared live TUI wiring (snapshot,
 * widget/tool-update display, per-agent telemetry). Used by both the
 * `workflow` tool (after approval) and the `subagent` tool (no approval).
 */
export async function runWorkflowScriptWithDisplay(
  script: string,
  meta: WorkflowMeta,
  options: RunWorkflowScriptOptions,
): Promise<{ result: WorkflowRunResult; snapshot: WorkflowSnapshot }> {
  const displayOptions = options.displayOptions ?? workflowDisplayOptions;
  const review = options.review;
  const signal = options.signal;
  let snapshot: WorkflowSnapshot = { ...createWorkflowSnapshot(meta), review };
  const display = createToolUpdateWorkflowDisplay(options.onUpdate, options.ctx as any, displayOptions);

  const update = () => {
    snapshot = recomputeWorkflowSnapshot(snapshot);
    snapshot.review = review;
    display.update(snapshot);
  };

  const recordPhase = (title: string | undefined) => {
    if (!title) return;
    if (!snapshot.phases.includes(title)) snapshot.phases.push(title);
  };

  try {
    const result = await runWorkflow(script, {
      cwd: options.cwd,
      args: options.args,
      signal,
      agent: options.agent,
      concurrency: options.concurrency,
      modelCatalog: options.modelCatalog,
      resume: options.resume,
      onAgentCheckpoint: options.onAgentCheckpoint,
      session: {
        modelRegistry: (options.ctx as any).modelRegistry,
        model: (options.ctx as any).model,
      },
      onLog(message) {
        snapshot.logs.push(message);
        update();
      },
      onPhase(title) {
        snapshot.currentPhase = title;
        recordPhase(title);
        update();
      },
      onAgentStart(event) {
        if (signal?.aborted) throw createAbortError("Workflow was aborted");
        recordPhase(event.phase);
        snapshot.agents.push({
          id: event.id,
          label: event.label,
          phase: event.phase,
          prompt: event.prompt,
          status: "running",
          model: event.model,
          thinkingLevel: event.thinkingLevel,
          isolation: event.isolation,
          promptPreview: preview(event.prompt, displayOptions.previewWidth),
          activity: { kind: "starting", text: "starting", updatedAt: Date.now() },
        });
        update();
      },
      onAgentUpdate(event) {
        const agent = findSnapshotAgent(snapshot, event.id, "running");
        if (agent) {
          agent.metadata = event.metadata;
          agent.activity = event.metadata.activity;
          agent.usage = event.metadata.usage;
          agent.contextUsage = event.metadata.contextUsage;
          agent.promptPreview = event.metadata.promptPreview ?? agent.promptPreview;
          agent.outputPreview = event.metadata.outputPreview ?? agent.outputPreview;
        }
        update();
      },
      onAgentEnd(event) {
        const agent = findSnapshotAgent(snapshot, event.id, "running");
        const error = (event.metadata as { error?: { message: string } } | undefined)?.error;
        if (agent) {
          agent.status = error ? "error" : "done";
          agent.error = error?.message;
          agent.resultPreview = preview(event.result);
          agent.metadata = event.metadata;
          agent.activity = event.metadata?.activity ?? {
            kind: agent.status === "done" ? "done" : "error",
            text: agent.status === "done" ? "done" : "error",
            updatedAt: Date.now(),
          };
          agent.usage = event.metadata?.usage;
          agent.contextUsage = event.metadata?.contextUsage;
          agent.promptPreview = event.metadata?.promptPreview ?? agent.promptPreview;
          agent.outputPreview = event.metadata?.outputPreview ?? agent.resultPreview;
        }
        update();
      },
    });

    if (result.agentCount === 0 && !result.paused) {
      throw new Error(
        "workflow scripts must call agent() at least once; this workflow declared phases but did not run any subagents",
      );
    }

    snapshot.result = result.result;
    snapshot.durationMs = result.durationMs;
    snapshot.review = review;
    snapshot = recomputeWorkflowSnapshot(snapshot);
    if (result.paused) display.clear();
    else display.complete(snapshot);

    return { result, snapshot };
  } catch (error) {
    if (isAbortError(error)) {
      for (const agent of snapshot.agents) {
        if (agent.status === "running") {
          agent.status = "skipped";
          agent.error = "aborted";
        }
      }
      snapshot = recomputeWorkflowSnapshot(snapshot);
      try {
        display.complete(snapshot);
      } catch {
        // A UI cleanup failure must not replace the abort signal.
      }
      throw createAbortError("Workflow was aborted");
    }
    // Non-abort failures (invalid return values or runtime errors) used to bypass complete(), leaving the last progress widget in
    // Pi's TUI indefinitely. Clear it while preserving the original error.
    try {
      display.clear();
    } catch {
      // A UI cleanup failure must not replace the workflow's actual error.
    }
    throw error;
  }
}

export interface WorkflowToolOptions {
  cwd?: string;
  concurrency?: number;
  stateStore?: WorkflowStateStore;
  /** Injectable agent runner for tests and embedded runtimes. */
  agent?: RunWorkflowScriptOptions["agent"];
  /** Override the bundled deterministic job-to-model routing catalog. */
  modelCatalog?: WorkflowModelCatalog;
  approvalMode?: WorkflowApprovalMode;
  reviewDir?: string;
}

export function createWorkflowTool(options: WorkflowToolOptions = {}): ToolDefinition<typeof workflowToolSchema, any> {
  // Serialize workflow tool executions in one Pi runtime so sibling resume
  // operations cannot race on the shared session state store.
  let executionLock: Promise<unknown> = Promise.resolve();

  return defineTool({
    name: "workflow",
    label: "Workflow",
    description: [
      "Execute or resume trusted JavaScript workflow orchestration with session-backed checkpoints.",
      "Pass script for a new workflow or resumeId for a paused/interrupted workflow on the active Pi session branch.",
    ].join(" "),
    promptSnippet:
      "Run or resume a trusted workflow. New scripts start with export const meta = { name, description }. Resume with resumeId (or 'latest'); completed uniquely-labeled agents are reused.",
    promptGuidelines: [
      "Use workflow when the user explicitly asks for a workflow, fan-out, or multi-agent orchestration, or when the task clearly decomposes into multiple agents (audits, multi-file changes, implement-then-review, fan-out research).",
      "For workflow, always pass one raw JavaScript string in the required script parameter; do not include Markdown fences or prose around the script.",
      "For workflow, the script's first statement must be `export const meta = { name: 'short_snake_case', description: 'non-empty human description' }`; meta.name and meta.description are required non-empty strings, and meta.phases is optional metadata for a stable upfront outline.",
      "For workflow, write plain JavaScript after the meta export. Do not use TypeScript syntax or static import/export statements after the meta export. Workflow JavaScript is trusted orchestration code with full host privileges under Pi's normal tool/session trust model; approval is not a sandbox.",
      "For workflow, available globals are agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), pause(reason, data), log(message), args, cwd, process.cwd(), Every completed workflow must call agent() at least once; an explicit cooperative pause may occur before an agent.",
      "For workflow, use pause(reason, data?) at safe phase boundaries when the user should review progress or the workflow should be resumed later.",
      "For workflow resume, call the workflow tool with resumeId. The runtime replays the saved script and reuses completed agents by their unique stable labels, so all agent labels must be unique and deterministic.",
      "For workflow, agent options require either model or job and may also include thinkingLevel and isolation. job is a plain work-type string, for example job: 'implementation'; an explicit model always wins when both are provided.",
      "For workflow, bundled job work types are inspection, classification, research, summarization, implementation, exploration, synthesis, planning, review, security-review, judge, and architecture; candidates are tried in order against enabled Pi models.",
      "For workflow, dynamically choose the workflow shape, phase names, number of agents, and model assignments from the user's goal and repository context; do not reuse a fixed template when the task calls for a different decomposition.",
      "For workflow, default high-volume workhorse inspection/classification to opencode-go/deepseek-v4-flash when available; use opencode-go/kimi-k2.7-code or opencode-go/minimax-m3 for cheap agentic implementation, exploration, and synthesis.",
      "For workflow, high-stakes review or judging should use independent judge agents: combine a routed frontier judge (for example openai-codex/gpt-5.6-sol or anthropic/claude-fable-5) with opencode-go/glm-5.2, anthropic/claude-opus-4-8, or openai-codex/gpt-5.5 as an independent perspective; use thinkingLevel: 'xhigh' where maximum independent scrutiny is justified, then synthesize after comparing judgments.",
      "For workflow, never let the same subagent implement and then review its own work. Use a separate reviewer agent, preferably a different model, and pass the implementer's structured output into the reviewer's prompt; the reviewer starts fresh, which removes confirmation bias.",
      "For workflow, use isolation: { mode: 'worktree', dirty: 'ignore', merge: 'none' } for read-only project audits when subagents should not touch the parent working tree.",
      "For workflow, when the user asks for a project audit, security review, or improvement review, put worktree isolation on every project-inspection agent; reserve non-isolated agents only for pure synthesis that does not inspect or mutate files.",
      "For workflow, when multiple agents modify files in parallel, ensure disjoint write ownership: each agent writes to a non-overlapping set of files or directories, never the same file. If two tasks affect the same file, sequence them so the second sees the first's changes, or use worktree isolation with dirty: 'patch' and merge: 'none'.",
      "For workflow, the live TUI shows each subagent's model, thinking level, current activity, and token/cost usage when available; full prompt, output, and tool metadata stays in details for inspection. Use short unique labels and explicit model/thinkingLevel options so the running workflow remains easy to follow.",
      "For workflow, call phase(title) when a new group of work starts. Phase names may be conditional or built in a loop; do not predeclare speculative phases just in case.",
      "For workflow, prefer it for decomposable work: repository inspection, independent research/checks, multi-perspective review, or fan-out/fan-in synthesis. Do not use it for a single quick file read/edit or when ordinary tools are enough.",
      "For workflow, give each subagent one focused responsibility sized to one logical sub-task describable in one or two sentences. If a prompt contains two independent action verbs (e.g. find bugs and fix them) or multiple distinct concerns, split it into separate agents.",
      "For workflow, parallel() takes functions, not promises: use `await parallel(items.map(item => () => agent('...', { label: '...' })))`, never `await parallel(items.map(item => agent(...)))`. Results are returned in input order.",
      "For workflow, pipeline(items, ...stages) runs each item through stages sequentially, while different items may run concurrently. Each stage receives (previousValue, originalItem, index).",
      "For workflow, choose parallel() + await as a barrier only when the next phase needs the complete result set (synthesis, dedup, merge, ranking); choose pipeline() when each item flows through the same ordered stages and items can advance independently.",
      "For workflow, bound every loop: iterate over a known array or a pre-fetched count, never while(true) or unbounded recursion. Condition-driven loops (e.g. review-fix until passing) need a maximum-rounds cap and a dry-streak break when a round produces no new results.",
      "For workflow, every agent() call should include a unique short label option, 2-5 words, such as { label: 'repo inventory' } or { label: 'source modules' }; unique labels make live status and error reporting readable.",
      "For workflow, failed agent(), parallel(), or pipeline() branches return null and log the failure unless the workflow is aborted. Check for nulls before synthesizing conclusions. After parallel() or pipeline(), drop nulls with results.filter(Boolean), log which labeled branches failed, and mention those gaps in the synthesis agent's prompt so the final output acknowledges missing coverage instead of silently omitting it.",
      "For workflow, include a final synthesis/assertion agent when combining multiple subagent results; return a compact JSON-serializable value with ok/verdict plus the important outputs.",
      "For workflow, if agent() needs machine-readable output, pass a plain JSON Schema via opts.schema; agent() will return the validated object. Use JSON Schema syntax, not TypeScript or TypeBox constructors.",
      "For workflow, when one agent's output feeds another agent's prompt, put opts.schema on the producing agent so the hand-off is a validated JSON object with named fields; embed those fields (or the JSON.stringify of the object) in the downstream prompt instead of raw free text.",
      "For workflow, each subagent starts with an empty conversation: the parent assistant's prior turns, tool outputs, and file reads are not inherited. Write self-contained prompts that include every file path, relevant snippet, prior finding, and instruction the agent needs.",
    ],
    parameters: workflowToolSchema,
    prepareArguments(args) {
      return normalizeWorkflowToolArgs(args);
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const run = async () => {
        let persisted = false;
        let workflowId = "";
        let workflowSucceeded = false;
        let terminalPersisted = false;
        let workflowResult: WorkflowRunResult | undefined;
        try {
          const saved = params.resumeId
            ? params.resumeId === "latest"
              ? options.stateStore
                  ?.list()
                  .filter((state) => state.status === "paused" || state.status === "interrupted")
                  .sort((a, b) => a.updatedAt - b.updatedAt)
                  .at(-1)
              : options.stateStore?.get(params.resumeId)
            : undefined;
          if (params.resumeId && !options.stateStore) throw new Error("workflow resume requires a session state store");
          if (params.resumeId && !saved) {
            throw new Error(`Paused or interrupted workflow "${params.resumeId}" was not found on this session branch`);
          }
          if (saved?.status === "completed") throw new Error(`Workflow "${saved.id}" is already completed`);

          const script = normalizeWorkflowScript(saved?.script ?? params.script ?? "");
          const runArgs = saved ? saved.args : params.args;
          const parsed = parseWorkflowScript(script);
          workflowId = saved?.id ?? `${slugWorkflowName(parsed.meta.name)}-${toolCallId || randomUUID()}`;
          const cwd = options.cwd ?? ctx.cwd;
          const approvalMode = options.approvalMode ?? "interactive";
          let review = await prepareWorkflowReview(script, parsed.meta, cwd, {
            approvalMode,
            reviewDir: options.reviewDir,
          });
          onUpdate?.({
            content: [{ type: "text", text: renderWorkflowReviewText(parsed.meta, review) }],
            details: {
              name: parsed.meta.name,
              meta: parsed.meta,
              review,
            },
          });

          if (signal?.aborted) throw createAbortError("Workflow was aborted");

          if (approvalMode === "interactive") {
            if (!ctx.hasUI) {
              throw new Error(
                "workflow approval requires an interactive UI; pass approvalMode: 'auto' only for trusted automation",
              );
            }
            const approved = await ctx.ui.confirm(
              saved ? "Resume workflow?" : "Run workflow?",
              [
                `Review file: ${review.path}`,
                "",
                `${saved ? "Resume" : "Run"} workflow "${parsed.meta.name}" now?`,
                "This trusted JavaScript runs with full host privileges; approval is not a sandbox.",
                "Rejecting leaves the review file in place and starts no agents.",
              ].join("\n"),
              signal ? { signal } : undefined,
            );
            review = approved
              ? { ...review, approved: true, status: "approved" }
              : { ...review, approved: false, status: "rejected" };
            if (!approved) {
              const snapshot = recomputeWorkflowSnapshot({
                ...createWorkflowSnapshot(parsed.meta),
                review,
              });
              return {
                content: [
                  {
                    type: "text",
                    text: `Workflow ${parsed.meta.name} was not run. Review file: ${review.path}`,
                  },
                ],
                details: {
                  ...snapshot,
                  meta: parsed.meta,
                  review,
                  phases: [],
                  logs: [],
                },
              };
            }
          } else {
            review = { ...review, approved: true, status: "auto" };
          }

          if (saved) {
            await options.stateStore?.append({
              kind: "resumed",
              workflowId,
              timestamp: Date.now(),
            });
          } else {
            await options.stateStore?.append({
              kind: "created",
              workflowId,
              script,
              args: runArgs,
              meta: parsed.meta,
              timestamp: Date.now(),
            });
          }
          persisted = true;

          const { result, snapshot } = await runWorkflowScriptWithDisplay(script, parsed.meta, {
            cwd,
            args: runArgs,
            concurrency: options.concurrency,
            agent: options.agent,
            modelCatalog: options.modelCatalog,
            resume: saved
              ? {
                  workflowId,
                  tokensSpent: saved.tokensSpent,
                  completed: saved.completed,
                  acknowledgedPauseKeys: saved.acknowledgedPauseKeys ?? [],
                }
              : { workflowId, tokensSpent: 0, completed: {} },
            async onAgentCheckpoint(checkpoint: WorkflowCompletedCheckpoint, tokensSpent: number) {
              await options.stateStore?.append({
                kind: "agent_completed",
                workflowId,
                checkpoint,
                tokensSpent,
                timestamp: Date.now(),
              });
            },
            signal,
            review,
            onUpdate,
            ctx,
          });
          workflowResult = result;

          workflowSucceeded = true;
          if (result.paused) {
            await options.stateStore?.append({
              kind: "paused",
              workflowId,
              reason: result.paused.reason,
              data: result.paused.data,
              key: result.paused.key,
              tokensSpent: result.tokensSpent,
              timestamp: Date.now(),
            });
            terminalPersisted = true;
            return {
              content: [
                {
                  type: "text",
                  text: `Workflow ${result.meta.name} paused. Resume id: ${workflowId}\nReason: ${result.paused.reason}`,
                },
              ],
              details: {
                ...snapshot,
                meta: result.meta,
                paused: result.paused,
                resumeId: workflowId,
                phases: result.phases,
                logs: result.logs,
                agentRecords: result.agents,
                review,
              },
            };
          }

          await options.stateStore?.append({
            kind: "completed",
            workflowId,
            tokensSpent: result.tokensSpent,
            timestamp: Date.now(),
          });
          terminalPersisted = true;
          return {
            content: [
              {
                type: "text",
                text: `Workflow ${result.meta.name} completed with ${result.agentCount} agent(s).\n\nResult:\n${JSON.stringify(result.result, null, 2)}`,
              },
            ],
            details: {
              ...snapshot,
              meta: result.meta,
              workflowId,
              phases: result.phases,
              logs: result.logs,
              result: result.result,
              durationMs: result.durationMs,
              agentRecords: result.agents,
              review,
            },
          };
        } catch (error) {
          // Always best-effort append an interrupted event once the workflow was
          // persisted, so the state store never stays stuck in 'running' (which
          // would make the workflow unresumable via resumeId or 'latest'). When
          // the workflow succeeded but persisting the terminal paused/completed
          // event failed, record that the terminal state persistence failed
          // while still rethrowing the ORIGINAL error below.
          if (persisted) {
            let tokensSpent: number | undefined;
            try {
              tokensSpent = options.stateStore?.get(workflowId)?.tokensSpent;
            } catch {
              // The store may be flaky while we are already handling a failure.
              // Fall back to the last known tokens spent from the workflow run,
              // or zero if the workflow never produced a result.
              tokensSpent = workflowResult?.tokensSpent ?? 0;
            }
            let reason: string;
            try {
              reason =
                workflowSucceeded && !terminalPersisted
                  ? `terminal state persistence failed: ${sanitizeInterruptionReason(error)}`
                  : sanitizeInterruptionReason(error);
            } catch {
              // The thrown value is hostile (e.g. a throwing getter or
              // toString). Use a safe fallback so the interrupted event is
              // still appended and the original error is rethrown below.
              reason = "interrupted";
            }
            try {
              await options.stateStore?.append({
                kind: "interrupted",
                workflowId,
                reason,
                tokensSpent: tokensSpent ?? 0,
                timestamp: Date.now(),
              });
            } catch {
              // Interruption persistence is best-effort; if the terminal append
              // already failed the retry may also fail. Preserve the workflow's
              // original failure rather than masking it.
            }
          }
          throw error;
        }
      };
      executionLock = executionLock.then(run, run);
      return executionLock as Promise<any>;
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("workflow")), 0, 0);
    },
    renderResult(result, _renderOptions, theme) {
      const text = result.content?.[0];
      return new Text(text?.type === "text" ? text.text : theme.fg("muted", "workflow"), 0, 0);
    },
  });
}

function normalizeWorkflowToolArgs(args: unknown): WorkflowToolInput {
  if (!args || typeof args !== "object") throw new Error("workflow requires an object argument");
  const value = args as Record<string, unknown>;
  const hasScript = typeof value.script === "string";
  const hasResume = typeof value.resumeId === "string" && value.resumeId.trim().length > 0;
  if (hasScript === hasResume) throw new Error("workflow requires exactly one of `script` or `resumeId`");
  if (value.args !== undefined && hasResume)
    throw new Error("workflow resume uses the saved args; do not pass args again");
  return {
    ...value,
    script: hasScript ? normalizeWorkflowScript(value.script as string) : undefined,
    resumeId: hasResume ? (value.resumeId as string).trim() : undefined,
  } as WorkflowToolInput;
}

function normalizeWorkflowScript(script: string): string {
  let text = script.trim();
  const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) text = fence[1].trim();
  return text;
}

export async function prepareWorkflowReview(
  script: string,
  meta: WorkflowMeta,
  cwd: string,
  options: {
    approvalMode: WorkflowApprovalMode;
    reviewDir?: string;
    now?: Date;
  },
): Promise<WorkflowReviewMetadata> {
  const normalized = normalizeWorkflowScript(script);
  const scriptBody = normalized.endsWith("\n") ? normalized : `${normalized}\n`;
  const reviewScript = `${workflowReviewHeader()}${scriptBody}`;
  const dir = resolveWorkflowReviewDir(cwd, options.reviewDir);
  await mkdir(dir, { recursive: true });
  const path = await writeWorkflowReviewFile(dir, options.now ?? new Date(), slugWorkflowName(meta.name), reviewScript);
  return {
    path,
    script: reviewScript,
    approved: false,
    approvalMode: options.approvalMode,
    status: "pending",
  };
}

function workflowReviewHeader(): string {
  return [
    "// Pi workflow review artifact.",
    "// TRUST: this trusted JavaScript runs with full host privileges, not inside a sandbox.",
    "// globalThis, Function, dynamic import(), and host APIs may be reachable.",
    "",
  ].join("\n");
}

async function writeWorkflowReviewFile(dir: string, now: Date, slug: string, script: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    const path = join(dir, workflowReviewFilename(now, slug, attempt));
    try {
      await writeFile(path, script, { encoding: "utf8", flag: "wx" });
      return path;
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

function workflowReviewFilename(now: Date, slug: string, attempt: number): string {
  if (attempt === 0) return `${formatReviewTimestamp(now)}-${slug}.workflow.js`;
  return `${formatReviewTimestampWithMilliseconds(now)}-${slug}-${randomUUID().slice(0, 8)}.workflow.js`;
}

function isFileExistsError(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { code?: unknown }).code === "EEXIST";
}

function resolveWorkflowReviewDir(cwd: string, reviewDir?: string): string {
  if (!reviewDir) return join(cwd, ".pi", "workflows");
  return isAbsolute(reviewDir) ? reviewDir : resolve(cwd, reviewDir);
}

export function slugWorkflowName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80)
      .replace(/-+$/g, "") || "workflow"
  );
}

function formatReviewTimestamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function formatReviewTimestampWithMilliseconds(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.(\d{3})Z$/, "$1Z");
}

function renderWorkflowReviewText(meta: WorkflowMeta, review: WorkflowReviewMetadata): string {
  return [
    "Workflow ready for review",
    `File: ${review.path}`,
    "",
    "```js",
    review.script.trimEnd(),
    "```",
    "",
    "Trust: this script runs as trusted JavaScript with full host privileges; approval is not a sandbox.",
    review.approvalMode === "auto"
      ? "approvalMode is auto; trusted automation will run this workflow after review metadata is recorded."
      : "Approve the confirmation prompt to run this workflow.",
    `Workflow: ${meta.name}`,
  ].join("\n");
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError";
}

function safeStringifyInterruptionReason(error: unknown): string {
  try {
    if (error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError") {
      return "aborted";
    }
  } catch {
    // Hostile `name` getter; fall through to a safe stringification.
  }

  try {
    if (error instanceof Error) {
      return String(error.message);
    }
    return String(error);
  } catch {
    try {
      return Object.prototype.toString.call(error);
    } catch {
      return "interrupted";
    }
  }
}

function sanitizeInterruptionReason(error: unknown): string {
  const raw = safeStringifyInterruptionReason(error);
  const sanitized = raw.replace(/[\r\n]+/g, " ").slice(0, 200);
  return sanitized || "interrupted";
}

function findSnapshotAgent(snapshot: WorkflowSnapshot, id: number, status?: "running") {
  return snapshot.agents.find((agent) => {
    if (agent.id !== id) return false;
    return status ? agent.status === status : true;
  });
}
