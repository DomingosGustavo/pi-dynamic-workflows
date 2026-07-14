import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { WorkflowThinkingLevel } from "./options.js";
import type { WorkflowMeta } from "./workflow.js";
import {
  defaultWorkflowDisplayOptions,
  prepareWorkflowReview,
  type RunWorkflowScriptOptions,
  runWorkflowScriptWithDisplay,
  slugWorkflowName,
} from "./workflow-tool.js";

/** Unique idempotency marker for the delegation system-prompt append. */
export const DELEGATION_PROMPT_MARKER = "<!-- pi-dynamic-workflows:delegation -->";

/**
 * Build concise delegation guidance for the system prompt, listing only the
 * delegation tools that are actually active. Written to work across Claude,
 * GPT, and open-weight models: short imperative rules, no provider-specific
 * phrasing, tools referenced by exact name.
 */
export function buildDelegationPromptAppend(tools: { subagent?: boolean; workflow?: boolean } = {}): string {
  const subagent = tools.subagent ?? true;
  const workflow = tools.workflow ?? true;
  if (!subagent && !workflow) return "";
  const lines = [
    DELEGATION_PROMPT_MARKER,
    "## Delegation",
    "",
    "You can delegate work. Every delegated prompt must be self-contained (file paths, context, expected output) because subagents do not see this conversation.",
    "",
  ];
  if (subagent) {
    lines.push(
      "- subagent: run one narrow, focused task on one agent with no approval step, or fan out several independent tasks in parallel via `tasks`. You choose the model and thinking level to match the kind of work.",
    );
  }
  if (workflow) {
    lines.push(
      "- workflow: script multi-agent orchestration (phases, parallel fan-out, implement-then-review) for decomposable work such as audits, multi-file changes, and fan-out research.",
    );
  }
  lines.push("", "Do trivial reads and single-file edits yourself.");
  if (subagent) lines[lines.length - 1] += " Use subagent for one self-contained multi-step task.";
  if (workflow) lines[lines.length - 1] += " Use workflow when several agents or an independent reviewer would help.";
  return lines.join("\n");
}

/** Default delegation guidance with both tools active. */
export const DELEGATION_PROMPT_APPEND = buildDelegationPromptAppend();

const thinkingLevelSchema = (description: string) =>
  Type.Unsafe<WorkflowThinkingLevel>({
    type: "string",
    enum: ["off", "minimal", "low", "medium", "high", "xhigh"],
    description,
  });

const subagentTaskSchema = Type.Object({
  task: Type.String({
    description:
      "Self-contained task prompt for this parallel subagent. Include every file path, code snippet, constraint, and the expected output format.",
  }),
  model: Type.Optional(
    Type.String({ description: "Model ref (provider/id) override for this task; defaults to the top-level model." }),
  ),
  thinkingLevel: Type.Optional(
    thinkingLevelSchema("Thinking level override for this task; defaults to the top-level thinkingLevel."),
  ),
  label: Type.Optional(Type.String({ description: "Short unique label for this task in progress display." })),
});

const subagentToolSchema = Type.Object({
  task: Type.Optional(
    Type.String({
      description:
        "Self-contained task prompt for a single subagent. Include every file path, code snippet, constraint, and the expected output format; the subagent cannot see the parent conversation. Provide either task or tasks.",
    }),
  ),
  tasks: Type.Optional(
    Type.Array(subagentTaskSchema, {
      description:
        "Independent self-contained tasks to run as parallel subagents (use instead of task). Each task may override model/thinkingLevel; only use for tasks that do not depend on each other.",
    }),
  ),
  model: Type.String({
    description:
      "Model ref (provider/id) for the subagent, chosen to match the kind of work per the model-selection guidelines. Acts as the default for every entry in tasks.",
  }),
  thinkingLevel: Type.Optional(
    thinkingLevelSchema(
      "Thinking level for the subagent. Scale with the depth of reasoning the work requires. Default for every entry in tasks.",
    ),
  ),
  label: Type.Optional(Type.String({ description: "Short 2-5 word label for progress display." })),
});

export interface SubagentTaskInput {
  task: string;
  model?: string;
  thinkingLevel?: WorkflowThinkingLevel;
  label?: string;
}

export interface SubagentToolInput {
  task?: string;
  tasks?: SubagentTaskInput[];
  model: string;
  thinkingLevel?: WorkflowThinkingLevel;
  label?: string;
}

export interface SubagentToolOptions {
  cwd?: string;
  concurrency?: number;
  reviewDir?: string;
  /** Injectable agent runner (tests). Defaults to a real WorkflowAgent. */
  agent?: RunWorkflowScriptOptions["agent"];
}

/**
 * Generate the single-agent workflow script that backs a subagent run. The
 * task prompt is passed via `args.task` so it never needs escaping inside the
 * generated JavaScript.
 */
export function buildSubagentScript(input: {
  name: string;
  description: string;
  label: string;
  model: string;
  thinkingLevel?: WorkflowThinkingLevel;
}): string {
  const agentOptions = [
    `label: ${JSON.stringify(input.label)}`,
    `model: ${JSON.stringify(input.model)}`,
    ...(input.thinkingLevel ? [`thinkingLevel: ${JSON.stringify(input.thinkingLevel)}`] : []),
  ];
  return [
    `export const meta = { name: ${JSON.stringify(input.name)}, description: ${JSON.stringify(input.description)} }`,
    "",
    "phase('Task')",
    "const output = await agent(args.task, {",
    ...agentOptions.map((line) => `  ${line},`),
    "})",
    "return { output }",
    "",
  ].join("\n");
}

/**
 * Generate the multi-agent workflow script that backs a parallel subagent run.
 * The fully resolved tasks (prompt + per-agent options) are passed via
 * `args.tasks` so nothing task-specific needs escaping inside the generated
 * JavaScript; outputs come back in task order (parallel() preserves order).
 */
export function buildParallelSubagentScript(input: { name: string; description: string }): string {
  return [
    `export const meta = { name: ${JSON.stringify(input.name)}, description: ${JSON.stringify(input.description)} }`,
    "",
    "phase('Tasks')",
    "const outputs = await parallel(args.tasks.map((t) => () => agent(t.task, t.options)))",
    "return { outputs }",
    "",
  ].join("\n");
}

/** Resolved per-task agent invocation passed to the parallel script via args. */
export interface ResolvedSubagentTask {
  task: string;
  options: {
    label: string;
    model: string;
    thinkingLevel?: WorkflowThinkingLevel;
  };
}

/**
 * Resolve the tasks array against the top-level model/thinkingLevel defaults
 * and assign unique fallback labels so progress display and error mapping
 * stay readable.
 */
export function resolveSubagentTasks(
  tasks: SubagentTaskInput[],
  defaults: { model: string; thinkingLevel?: WorkflowThinkingLevel },
): ResolvedSubagentTask[] {
  return tasks.map((task, index) => {
    const thinkingLevel = task.thinkingLevel ?? defaults.thinkingLevel;
    return {
      task: task.task,
      options: {
        label: task.label?.trim() || `task ${index + 1}`,
        model: task.model?.trim() || defaults.model,
        ...(thinkingLevel ? { thinkingLevel } : {}),
      },
    };
  });
}

export function createSubagentTool(options: SubagentToolOptions = {}): ToolDefinition<typeof subagentToolSchema, any> {
  return defineTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate narrow, self-contained tasks to subagents. Runs immediately with no approval prompt.",
      "Pass task for a single subagent, or tasks for several independent subagents running in parallel.",
      "You choose the model (provider/id) and thinkingLevel to match the kind of work; entries in tasks may override them.",
      "Each subagent starts fresh with the standard coding tools in the current project; every task prompt must be self-contained.",
    ].join(" "),
    promptSnippet:
      "Delegate narrow self-contained tasks to subagents (no approval): task for one agent, tasks for independent parallel agents. Choose model and thinkingLevel per the model-selection guidelines.",
    promptGuidelines: [
      "Use subagent for one narrow, focused, self-contained task that would take you many steps; use subagent with tasks to fan out several independent such tasks in parallel; use workflow instead when coordinating dependent stages, phases, or an independent reviewer.",
      "subagent tasks entries must be independent of each other: no task may rely on another task's output or edits. If tasks depend on each other, use workflow or sequential subagent calls.",
      "subagent task prompts must be self-contained: include file paths, relevant snippets, constraints, and the expected output; the subagent does not see this conversation.",
      "For subagent, choose the model by the kind of work: inspection, classification, research, and summarization default to opencode-go/deepseek-v4-flash; implementation and exploration prefer opencode-go/kimi-k2.7-code, then opencode-go/minimax-m3, then openai-codex/gpt-5.6-sol; synthesis and planning prefer opencode-go/minimax-m3 or openai-codex/gpt-5.6-sol; review prefers openai-codex/gpt-5.6-sol high, opencode-go/glm-5.2 thinkingLevel 'xhigh', or openai-codex/gpt-5.5 high; security-review prefers openai-codex/gpt-5.6-sol high, anthropic/claude-opus-4-8 thinkingLevel 'xhigh', or opencode-go/glm-5.2 thinkingLevel 'xhigh'; judge and architecture prefer openai-codex/gpt-5.6-sol high, anthropic/claude-fable-5 high, or openai-codex/gpt-5.5 thinkingLevel 'xhigh'.",
      "For subagent, scale thinkingLevel with the depth of reasoning the work requires: 'low' or 'medium' for routine inspection, research, and implementation; 'high' or 'xhigh' for subtle review, security analysis, judging, or architecture.",
      "subagent needs no user approval and starts immediately; do not ask the user for permission before calling it.",
      "subagent gives each run a short unique label, 2-5 words, so live progress stays readable.",
    ],
    parameters: subagentToolSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const cwd = options.cwd ?? ctx.cwd;
      if (params.task !== undefined && params.tasks !== undefined) {
        throw new Error("subagent accepts either task or tasks, not both");
      }
      const parallelTasks = params.tasks;
      if (parallelTasks !== undefined && parallelTasks.length === 0) {
        throw new Error("subagent tasks must contain at least one task");
      }
      if (params.task === undefined && parallelTasks === undefined) {
        throw new Error("subagent requires task or tasks");
      }
      const isParallel = parallelTasks !== undefined;
      const label = params.label?.trim() || (isParallel ? "parallel subagents" : "subagent task");
      const name = `subagent_${slugWorkflowName(label).replace(/-/g, "_")}`;
      const meta: WorkflowMeta = {
        name,
        description: `Subagent: ${label}`,
      };
      const resolvedTasks = isParallel
        ? resolveSubagentTasks(parallelTasks, { model: params.model, thinkingLevel: params.thinkingLevel })
        : undefined;
      const script = resolvedTasks
        ? buildParallelSubagentScript({ name, description: meta.description })
        : buildSubagentScript({
            name,
            description: meta.description,
            label,
            model: params.model,
            thinkingLevel: params.thinkingLevel,
          });

      // TODO(subagent-direct-path): this round-trips one delegation through script
      // building + acorn parse + AsyncFunction eval. A shared single-agent path
      // (call WorkflowAgent directly while still writing the artifact/review trail)
      // would avoid the eval, but reusing runWorkflowScriptWithDisplay's snapshot,
      // telemetry, phase and TUI wiring for one agent is not a contained change; it
      // would duplicate that display plumbing. Deferred.
      //
      // Same artifact trail as workflow, but auto-approved: the generated
      // one-agent script is written to .pi/workflows for inspection.
      const pendingReview = await prepareWorkflowReview(script, meta, cwd, {
        approvalMode: "auto",
        reviewDir: options.reviewDir,
      });
      const review = { ...pendingReview, approved: true, status: "auto" as const };

      if (signal?.aborted) {
        const abortError = new Error("Subagent was aborted");
        abortError.name = "AbortError";
        throw abortError;
      }

      const { result, snapshot } = await runWorkflowScriptWithDisplay(script, meta, {
        cwd,
        args: resolvedTasks ? { tasks: resolvedTasks } : { task: params.task },
        concurrency: options.concurrency,
        signal,
        review,
        agent: options.agent,
        displayOptions: defaultWorkflowDisplayOptions("subagent"),
        onUpdate,
        ctx,
      });

      const details = {
        ...snapshot,
        meta,
        review,
        result: result.result,
        durationMs: result.durationMs,
        logs: result.logs,
        phases: result.phases,
      };

      if (resolvedTasks) {
        const outputs = (result.result as { outputs?: unknown[] } | null)?.outputs ?? [];
        // parallel() preserves input order and maps each failed agent() to null;
        // the structured error lives on the matching agent record. Agents are
        // queued (and recorded) in task order, so index alignment holds; label
        // match is checked first in case that ever changes.
        const findFailure = (index: number) => {
          const wanted = resolvedTasks[index].options.label;
          const record =
            result.agents.find((agentRecord) => agentRecord.status === "error" && agentRecord.label === wanted) ??
            (result.agents[index]?.status === "error" ? result.agents[index] : undefined);
          return record?.error ?? record?.metadata?.error;
        };
        const sections: string[] = [];
        let failures = 0;
        for (let index = 0; index < resolvedTasks.length; index++) {
          const taskLabel = resolvedTasks[index].options.label;
          const output = outputs[index];
          if (output === null || output === undefined) {
            failures++;
            const failure = findFailure(index);
            if (failure?.name === "AbortError") {
              const abortError = new Error(`subagent "${label}" was aborted`);
              abortError.name = "AbortError";
              throw abortError;
            }
            sections.push(`## ${taskLabel}\n\nFAILED${failure ? `: ${failure.message}` : " without output"}`);
          } else {
            const text = typeof output === "string" && output.trim() ? output : JSON.stringify(output, null, 2);
            sections.push(`## ${taskLabel}\n\n${text}`);
          }
        }
        if (failures === resolvedTasks.length) {
          throw new Error(`subagent "${label}" failed: all ${resolvedTasks.length} parallel tasks failed`);
        }
        return {
          content: [{ type: "text", text: sections.join("\n\n") }],
          details,
        };
      }

      const output = (result.result as { output?: unknown } | null)?.output;
      if (output === null || output === undefined) {
        // The workflow runtime converts a failed agent() into a null result and
        // attaches a structured error record on that agent (metadata.error and the
        // per-agent record.error). With a single agent, that failure is the whole
        // run. Read the structured error instead of grepping logs.
        const failed = result.agents.find((agentRecord) => agentRecord.status === "error" && agentRecord.error);
        const failure = failed?.error ?? failed?.metadata?.error;
        // Aborts are represented by error.name === 'AbortError' (detect by name, not
        // instanceof). The runtime rethrows aborts rather than recording them, so this
        // is defensive; still, surface it as an abort rather than a plain failure.
        if (failure?.name === "AbortError") {
          const abortError = new Error(`subagent "${label}" was aborted`);
          abortError.name = "AbortError";
          throw abortError;
        }
        throw new Error(`subagent "${label}" failed${failure ? `: ${failure.message}` : " without output"}`);
      }
      const text = typeof output === "string" && output.trim() ? output : JSON.stringify(output, null, 2);

      return {
        content: [{ type: "text", text }],
        details,
      };
    },
    renderCall(args, theme) {
      const input = args as Partial<SubagentToolInput> | undefined;
      const taskCount = Array.isArray(input?.tasks) ? `${input.tasks.length} parallel tasks` : undefined;
      const detail = [input?.model, input?.thinkingLevel, input?.label, taskCount].filter(Boolean).join(" · ");
      return new Text(
        `${theme.fg("toolTitle", theme.bold("subagent"))}${detail ? ` ${theme.fg("muted", detail)}` : ""}`,
        0,
        0,
      );
    },
    renderResult(result, _renderOptions, theme) {
      const text = result.content?.[0];
      return new Text(text?.type === "text" ? text.text : theme.fg("muted", "subagent"), 0, 0);
    },
  });
}
