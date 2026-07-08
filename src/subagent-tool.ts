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
      "- subagent: run one narrow, focused task on one agent with no approval step. You choose the model and thinking level to match task difficulty.",
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

const subagentToolSchema = Type.Object({
  task: Type.String({
    description:
      "Self-contained task prompt for the subagent. Include every file path, code snippet, constraint, and the expected output format; the subagent cannot see the parent conversation.",
  }),
  model: Type.String({
    description:
      "Model ref (provider/id) for the subagent, chosen to match task difficulty per the model-selection guidelines.",
  }),
  thinkingLevel: Type.Optional(
    Type.Unsafe<WorkflowThinkingLevel>({
      type: "string",
      enum: ["off", "minimal", "low", "medium", "high", "xhigh"],
      description: "Thinking level for the subagent. Scale with task difficulty.",
    }),
  ),
  label: Type.Optional(Type.String({ description: "Short 2-5 word label for progress display." })),
});

export interface SubagentToolInput {
  task: string;
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

export function createSubagentTool(options: SubagentToolOptions = {}): ToolDefinition<typeof subagentToolSchema, any> {
  return defineTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate one narrow, self-contained task to a single subagent. Runs immediately with no approval prompt.",
      "You choose the model (provider/id) and thinkingLevel to match task difficulty.",
      "The subagent starts fresh with the standard coding tools in the current project; the task prompt must be self-contained.",
    ].join(" "),
    promptSnippet:
      "Delegate one narrow self-contained task to a single subagent (no approval). Choose model and thinkingLevel per the model-selection guidelines.",
    promptGuidelines: [
      "Use subagent for one narrow, focused, self-contained task that would take you many steps; use workflow instead when coordinating multiple agents, phases, or an independent reviewer.",
      "subagent task prompts must be self-contained: include file paths, relevant snippets, constraints, and the expected output; the subagent does not see this conversation.",
      "For subagent, choose the model by task difficulty: opencode-go/deepseek-v4-flash for high-volume inspection/classification; opencode-go/kimi-k2.7-code or opencode-go/minimax-m3 for cheap agentic implementation, exploration, and synthesis; opencode-go/glm-5.2 with thinkingLevel 'xhigh' for lower-cost deep reasoning; anthropic/claude-opus-4-8 or an enabled GPT 5.5 ref such as openai-codex/gpt-5.5 with thinkingLevel 'xhigh' for frontier-difficulty debugging, architecture, or judging.",
      "For subagent, scale thinkingLevel with difficulty: 'low' or 'medium' for routine implementation and research, 'high' or 'xhigh' for complex debugging and subtle reasoning.",
      "subagent needs no user approval and starts immediately; do not ask the user for permission before calling it.",
      "subagent gives each run a short unique label, 2-5 words, so live progress stays readable.",
    ],
    parameters: subagentToolSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const cwd = options.cwd ?? ctx.cwd;
      const label = params.label?.trim() || "subagent task";
      const name = `subagent_${slugWorkflowName(label).replace(/-/g, "_")}`;
      const meta: WorkflowMeta = {
        name,
        description: `Subagent: ${label}`,
      };
      const script = buildSubagentScript({
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
        args: { task: params.task },
        concurrency: options.concurrency,
        signal,
        review,
        agent: options.agent,
        displayOptions: defaultWorkflowDisplayOptions("subagent"),
        onUpdate,
        ctx,
      });

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
        details: {
          ...snapshot,
          meta,
          review,
          result: result.result,
          durationMs: result.durationMs,
          logs: result.logs,
          phases: result.phases,
        },
      };
    },
    renderCall(args, theme) {
      const input = args as Partial<SubagentToolInput> | undefined;
      const detail = [input?.model, input?.thinkingLevel, input?.label].filter(Boolean).join(" · ");
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
