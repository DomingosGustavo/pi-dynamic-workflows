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
import type { WorkflowApprovalMode, WorkflowReviewMetadata } from "./options.js";
import { parseWorkflowScript, runWorkflow, type WorkflowMeta, type WorkflowRunResult } from "./workflow.js";

const workflowToolSchema = Type.Object({
  script: Type.String({
    description: [
      "Required raw JavaScript workflow script, with no Markdown fences.",
      "First statement: export const meta = { name: 'short_snake_case', description: 'non-empty description' }. meta.phases is optional documentation; live progress is driven by phase(title).",
      "Use phase('Name'), agent(prompt, opts), parallel(arrayOfFunctions), pipeline(items, ...stages), log(message), args, and budget. The workflow must call agent() at least once.",
      "parallel() requires functions, not promises: await parallel(items.map(item => () => agent(...))).",
    ].join(" "),
  }),
  args: Type.Optional(
    Type.Any({ description: "Optional JSON value exposed to the workflow script as global `args`." }),
  ),
});

export type WorkflowToolInput = {
  script: string;
  args?: unknown;
};

const workflowDisplayOptions = {
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
} as const;

export interface WorkflowToolOptions {
  cwd?: string;
  concurrency?: number;
  approvalMode?: WorkflowApprovalMode;
  reviewDir?: string;
}

export function createWorkflowTool(options: WorkflowToolOptions = {}): ToolDefinition<typeof workflowToolSchema, any> {
  return defineTool({
    name: "workflow",
    label: "Workflow",
    description: [
      "Execute trusted JavaScript workflow orchestration that coordinates multiple subagents with agent(), parallel(), and pipeline().",
      "script is required raw JavaScript. It must start with export const meta = { name, description } and must call agent() at least once; phases are optional metadata.",
    ].join(" "),
    promptSnippet:
      "Run a trusted JavaScript workflow. Required script header: export const meta = { name: 'short_snake_case', description: 'non-empty description' }. Use phase(title) at runtime to create progress groups.",
    promptGuidelines: [
      "Use workflow only when the user explicitly asks for a workflow, workflows, fan-out, or multi-agent orchestration.",
      "For workflow, always pass one raw JavaScript string in the required script parameter; do not include Markdown fences or prose around the script.",
      "For workflow, the script's first statement must be `export const meta = { name: 'short_snake_case', description: 'non-empty human description' }`; meta.name and meta.description are required non-empty strings, and meta.phases is optional metadata for a stable upfront outline.",
      "For workflow, write plain JavaScript after the meta export. Do not use TypeScript syntax, imports, require(), or fs. Workflow JavaScript is trusted orchestration code under Pi's normal tool/session trust model.",
      "For workflow, available globals are agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), args, cwd, process.cwd(), and budget. Every workflow must call agent() at least once; do not use workflow only to declare phases or return a static object.",
      "For workflow, agent options may include model, thinkingLevel, and isolation. Prefer enabled model refs such as provider/id when the task benefits from different model strengths.",
      "For workflow, dynamically choose the workflow shape, phase names, number of agents, and model assignments from the user's goal and repository context; do not reuse a fixed template when the task calls for a different decomposition.",
      "For workflow, default high-volume workhorse inspection/classification to opencode-go/deepseek-v4-flash when available; use opencode-go/kimi-k2.7-code or opencode-go/minimax-m3 for cheap agentic implementation, exploration, and synthesis.",
      "For workflow, high-stakes review or judging should use independent judge agents with opencode-go/glm-5.2 as the lower-cost reasoning judge and either anthropic/claude-opus-4-8 or an enabled GPT 5.5 ref such as openai-codex/gpt-5.5 as the frontier judge, all with thinkingLevel: 'xhigh', then synthesize after comparing judgments.",
      "For workflow, use isolation: { mode: 'worktree', dirty: 'ignore', merge: 'none' } for read-only project audits when subagents should not touch the parent working tree.",
      "For workflow, when the user asks for a project audit, security review, or improvement review, put worktree isolation on every project-inspection agent; reserve non-isolated agents only for pure synthesis that does not inspect or mutate files.",
      "For workflow, the live TUI shows each subagent's model, thinking level, current activity, and token/cost usage when available; full prompt, output, and tool metadata stays in details for inspection. Use short unique labels and explicit model/thinkingLevel options so the running workflow remains easy to follow.",
      "For workflow, call phase(title) when a new group of work starts. Phase names may be conditional or built in a loop; do not predeclare speculative phases just in case.",
      "For workflow, prefer it for decomposable work: repository inspection, independent research/checks, multi-perspective review, or fan-out/fan-in synthesis. Do not use it for a single quick file read/edit or when ordinary tools are enough.",
      "For workflow, parallel() takes functions, not promises: use `await parallel(items.map(item => () => agent('...', { label: '...' })))`, never `await parallel(items.map(item => agent(...)))`. Results are returned in input order.",
      "For workflow, pipeline(items, ...stages) runs each item through stages sequentially, while different items may run concurrently. Each stage receives (previousValue, originalItem, index).",
      "For workflow, every agent() call should include a unique short label option, 2-5 words, such as { label: 'repo inventory' } or { label: 'source modules' }; unique labels make live status and error reporting readable.",
      "For workflow, failed agent(), parallel(), or pipeline() branches return null and log the failure unless the workflow is aborted. Check for nulls before synthesizing conclusions.",
      "For workflow, include a final synthesis/assertion agent when combining multiple subagent results; return a compact JSON-serializable value with ok/verdict plus the important outputs.",
      "For workflow, if agent() needs machine-readable output, pass a plain JSON Schema via opts.schema; agent() will return the validated object. Use JSON Schema syntax, not TypeScript or TypeBox constructors.",
      "For workflow, do not assume the parent assistant has repository code context inside subagents; include enough task context and relevant paths in each agent prompt.",
    ],
    parameters: workflowToolSchema,
    prepareArguments(args) {
      return normalizeWorkflowToolArgs(args);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const script = normalizeWorkflowScript(params.script);
      const parsed = parseWorkflowScript(script);
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

      if (signal?.aborted) throw new Error("Workflow was aborted");

      if (approvalMode === "interactive") {
        if (!ctx.hasUI) {
          throw new Error(
            "workflow approval requires an interactive UI; pass approvalMode: 'auto' only for trusted automation",
          );
        }
        const approved = await ctx.ui.confirm(
          "Run workflow?",
          [
            `Review file: ${review.path}`,
            "",
            `Run workflow "${parsed.meta.name}" now?`,
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

      let snapshot: WorkflowSnapshot = { ...createWorkflowSnapshot(parsed.meta), review };
      const display = createToolUpdateWorkflowDisplay(onUpdate, ctx, workflowDisplayOptions);

      const update = () => {
        snapshot = recomputeWorkflowSnapshot(snapshot);
        snapshot.review = review;
        display.update(snapshot);
      };

      const recordPhase = (title: string | undefined) => {
        if (!title) return;
        if (!snapshot.phases.includes(title)) snapshot.phases.push(title);
      };

      let result: WorkflowRunResult;
      try {
        result = await runWorkflow(script, {
          cwd,
          args: params.args,
          signal,
          concurrency: options.concurrency,
          session: {
            modelRegistry: ctx.modelRegistry,
            model: ctx.model,
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
            if (signal?.aborted) throw new Error("Workflow was aborted");
            recordPhase(event.phase);
            snapshot.agents.push({
              id: snapshot.agents.length + 1,
              label: event.label,
              phase: event.phase,
              prompt: event.prompt,
              status: "running",
              model: event.model,
              thinkingLevel: event.thinkingLevel,
              isolation: event.isolation,
              promptPreview: preview(event.prompt, workflowDisplayOptions.previewWidth),
              activity: { kind: "starting", text: "starting", updatedAt: Date.now() },
            });
            update();
          },
          onAgentUpdate(event) {
            const agent = findSnapshotAgent(snapshot, event.label, "running");
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
            const agent = findSnapshotAgent(snapshot, event.label, "running");
            if (agent) {
              agent.status = event.result === null ? "error" : "done";
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
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          for (const agent of snapshot.agents) {
            if (agent.status === "running") {
              agent.status = "skipped";
              agent.error = "aborted";
            }
          }
          snapshot = recomputeWorkflowSnapshot(snapshot);
          display.complete(snapshot);
          throw new Error("Workflow was aborted");
        }
        throw error;
      }

      if (result.agentCount === 0) {
        throw new Error(
          "workflow scripts must call agent() at least once; this workflow declared phases but did not run any subagents",
        );
      }

      snapshot.result = result.result;
      snapshot.durationMs = result.durationMs;
      snapshot.review = review;
      snapshot = recomputeWorkflowSnapshot(snapshot);
      display.complete(snapshot);

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
          phases: result.phases,
          logs: result.logs,
          result: result.result,
          durationMs: result.durationMs,
          review,
        },
      };
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
  if (!args || typeof args !== "object") throw new Error("workflow requires an object argument with a script string");
  const value = args as Record<string, unknown>;
  if (typeof value.script !== "string") throw new Error("workflow requires `script` to be a string");
  return { ...value, script: normalizeWorkflowScript(value.script) } as WorkflowToolInput;
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
  const reviewScript = normalized.endsWith("\n") ? normalized : `${normalized}\n`;
  const dir = resolveWorkflowReviewDir(cwd, options.reviewDir);
  await mkdir(dir, { recursive: true });
  const path = join(
    dir,
    `${formatReviewTimestamp(options.now ?? new Date())}-${slugWorkflowName(meta.name)}.workflow.js`,
  );
  await writeFile(path, reviewScript, "utf8");
  return {
    path,
    script: reviewScript,
    approved: false,
    approvalMode: options.approvalMode,
    status: "pending",
  };
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

function renderWorkflowReviewText(meta: WorkflowMeta, review: WorkflowReviewMetadata): string {
  return [
    "Workflow ready for review",
    `File: ${review.path}`,
    "",
    "```js",
    review.script.trimEnd(),
    "```",
    "",
    review.approvalMode === "auto"
      ? "approvalMode is auto; trusted automation will run this workflow after review metadata is recorded."
      : "Approve the confirmation prompt to run this workflow.",
    `Workflow: ${meta.name}`,
  ].join("\n");
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\babort(?:ed)?\b/i.test(error.message);
}

function findSnapshotAgent(snapshot: WorkflowSnapshot, label: string, status?: "running") {
  return [...snapshot.agents].reverse().find((agent) => {
    if (agent.label !== label) return false;
    return status ? agent.status === status : true;
  });
}
