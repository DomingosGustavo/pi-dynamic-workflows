import { join } from "node:path";
import type { AssistantMessage, Model, TextContent } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  AuthStorage,
  type CreateAgentSessionOptions,
  createAgentSession,
  createCodingTools,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import type {
  WorkflowAgentRunMetadata,
  WorkflowModelRef,
  WorkflowThinkingLevel,
  WorktreeIsolation,
} from "./options.js";
import { createStructuredOutputTool, type StructuredOutputCapture } from "./structured-output.js";
import {
  contextUsageFromSessionStats,
  previewValue,
  usageFromMessages,
  usageFromSessionStats,
  workflowTelemetryFromSessionEvent,
} from "./telemetry.js";
import { WorkflowWorktreeManager } from "./worktree.js";

export interface WorkflowAgentOptions {
  cwd?: string;
  /** Extra tools available to the subagent in addition to the structured output tool. */
  tools?: ToolDefinition[];
  /** Override any createAgentSession option (model, authStorage, resourceLoader, etc.). */
  session?: Partial<CreateAgentSessionOptions>;
  /** Extra system guidance prepended to every subagent task. */
  instructions?: string;
}

export interface AgentRunOptions<TSchemaDef extends TSchema | undefined = undefined> {
  label?: string;
  schema?: TSchemaDef;
  tools?: ToolDefinition[];
  instructions?: string;
  signal?: AbortSignal;
  model?: WorkflowModelRef;
  thinkingLevel?: WorkflowThinkingLevel;
  isolation?: WorktreeIsolation;
  onMetadata?: (metadata: WorkflowAgentRunMetadata) => void;
  onUpdate?: (metadata: WorkflowAgentRunMetadata) => void;
}

export type AgentRunResult<TSchemaDef extends TSchema | undefined> = TSchemaDef extends TSchema
  ? Static<TSchemaDef>
  : string;

export class WorkflowAgent {
  private readonly cwd: string;
  private readonly extraTools: ToolDefinition[];
  private readonly sessionOptions: Partial<CreateAgentSessionOptions>;
  private readonly instructions?: string;

  constructor(options: WorkflowAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.extraTools = options.tools ?? [];
    this.sessionOptions = options.session ?? {};
    this.instructions = options.instructions;
  }

  async run<TSchemaDef extends TSchema | undefined = undefined>(
    prompt: string,
    options: AgentRunOptions<TSchemaDef> = {},
  ): Promise<AgentRunResult<TSchemaDef>> {
    const capture: StructuredOutputCapture<any> = { called: false, value: undefined };
    const agentDir = getAgentDir();
    const modelRegistry =
      this.sessionOptions.modelRegistry ??
      ModelRegistry.create(this.sessionOptions.authStorage ?? AuthStorage.create(join(agentDir, "auth.json")));
    const resolvedModel = resolveWorkflowModel(modelRegistry, options.model);
    const metadata: WorkflowAgentRunMetadata = {
      cwd: this.cwd,
      model: resolvedModel ? { provider: resolvedModel.provider, id: resolvedModel.id } : undefined,
      thinkingLevel: options.thinkingLevel,
      promptPreview: previewValue(prompt),
      activity: { kind: "starting", text: "starting", updatedAt: Date.now() },
    };
    const emitUpdate = (patch: Partial<WorkflowAgentRunMetadata> = {}) => {
      Object.assign(metadata, patch);
      options.onUpdate?.({ ...metadata });
    };
    let activeWorktree: Awaited<ReturnType<WorkflowWorktreeManager["create"]>>;
    let success = false;

    try {
      activeWorktree = await new WorkflowWorktreeManager(this.cwd).create(options.isolation);
      const runCwd = activeWorktree?.cwd ?? this.cwd;
      metadata.cwd = runCwd;
      emitUpdate();
      const customTools: ToolDefinition[] = [
        ...createCodingTools(runCwd),
        ...this.extraTools,
        ...(options.tools ?? []),
      ];

      if (options.schema) {
        customTools.push(createStructuredOutputTool({ schema: options.schema, capture }) as unknown as ToolDefinition);
      }

      const { session } = await createAgentSession({
        cwd: runCwd,
        agentDir,
        sessionManager: SessionManager.inMemory(runCwd),
        settingsManager: SettingsManager.create(runCwd, agentDir),
        customTools,
        ...this.sessionOptions,
        model: resolvedModel ?? this.sessionOptions.model,
        thinkingLevel: options.thinkingLevel ?? this.sessionOptions.thinkingLevel,
        modelRegistry,
      });

      let removeAbortListener: (() => void) | undefined;
      let unsubscribe: (() => void) | undefined;
      try {
        if (options.signal?.aborted) throw createAbortError();
        if (options.signal) {
          // session.abort() may reject if there is nothing in flight; ignore that explicitly.
          const onAbort = () => void Promise.resolve(session.abort()).catch(() => {});
          options.signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
        }

        unsubscribe = session.subscribe((event: AgentSessionEvent) => {
          if (options.schema) trackStructuredOutputAttempt(event, capture);
          const update = workflowTelemetryFromSessionEvent(event);
          // Live usage from a single assistant message undercounts multi-turn runs; recompute
          // the cumulative total from all messages so live totals stay monotonic and match finals.
          if (update.usage) update.usage = usageFromMessages(session.messages) ?? update.usage;
          if (Object.keys(update).length > 0) emitUpdate(update);
        });

        await session.prompt(this.buildPrompt(prompt, options as AgentRunOptions<any>, Boolean(options.schema)));
        if (options.signal?.aborted) throw createAbortError();

        if (options.schema) {
          if (!capture.called) {
            throw new Error(this.structuredOutputFailureMessage(capture));
          }
          this.recordFinalMetadata(session, metadata, capture.value);
          emitUpdate();
          success = true;
          return capture.value as AgentRunResult<TSchemaDef>;
        }

        const result = this.lastAssistantText(session.messages);
        this.recordFinalMetadata(session, metadata, result);
        emitUpdate();
        success = true;
        return result as AgentRunResult<TSchemaDef>;
      } finally {
        removeAbortListener?.();
        unsubscribe?.();
        session.dispose();
      }
    } finally {
      if (activeWorktree) metadata.worktree = await activeWorktree.finish(success);
      emitUpdate();
      options.onMetadata?.(metadata);
    }
  }

  private buildPrompt(prompt: string, options: AgentRunOptions<any>, structured: boolean): string {
    const parts = [
      this.instructions,
      options.instructions,
      options.label ? `Task label: ${options.label}` : undefined,
      prompt,
    ].filter(Boolean);

    if (structured) {
      parts.push(
        [
          "Final output contract:",
          "- Your final action MUST be a structured_output tool call.",
          "- The structured_output arguments are the return value of this subagent.",
          "- Do not emit a prose final answer instead of structured_output.",
          "- If you need to inspect files or run commands first, do so, then call structured_output exactly once.",
        ].join("\n"),
      );
    }

    return parts.join("\n\n");
  }

  private lastAssistantText(messages: unknown[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as Partial<AssistantMessage> | undefined;
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      const text = message.content
        .filter((part): part is TextContent => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text.trim()) return text;
    }
    return "";
  }

  private structuredOutputFailureMessage(capture: StructuredOutputCapture<any>): string {
    const attempts = capture.attempts ?? 0;
    if (attempts === 0) {
      return "Subagent finished without calling structured_output";
    }
    const detail = capture.lastError ? `; last validation error: ${capture.lastError}` : "";
    return `Subagent finished without a valid structured_output result after ${attempts} invalid attempt(s)${detail}`;
  }

  private recordFinalMetadata(session: AgentSession, metadata: WorkflowAgentRunMetadata, output: unknown): void {
    const stats = session.getSessionStats();
    const usage = usageFromMessages(session.messages) ?? usageFromSessionStats(stats);
    if (usage) metadata.usage = usage;
    metadata.contextUsage = contextUsageFromSessionStats(stats);
    metadata.outputPreview = previewValue(output);
    metadata.activity = { kind: "done", text: "done", updatedAt: Date.now() };
  }
}

function createAbortError(message = "Subagent was aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/**
 * Track structured_output tool calls that Pi rejected for failing schema validation.
 *
 * Invalid arguments never reach the tool's execute(), so capture.called stays false. Pi still
 * emits a tool_execution_end for structured_output with isError=true, letting us distinguish
 * "never tried" from "tried but invalid" in the final failure message.
 */
function trackStructuredOutputAttempt(event: AgentSessionEvent, capture: StructuredOutputCapture<any>): void {
  if (event.type !== "tool_execution_end") return;
  if (event.toolName !== "structured_output" || !event.isError) return;
  capture.attempts = (capture.attempts ?? 0) + 1;
  const message = errorTextFromToolResult(event.result);
  if (message) capture.lastError = message;
}

function errorTextFromToolResult(result: unknown): string | undefined {
  if (typeof result === "string") return result;
  const content = (result as { content?: unknown })?.content;
  if (Array.isArray(content)) {
    const text = content
      .filter(
        (part): part is { type: "text"; text: string } =>
          !!part &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text)
      .join("");
    if (text.trim()) return text.trim();
  }
  return undefined;
}

export function resolveWorkflowModel(
  modelRegistry: Pick<ModelRegistry, "find" | "getAll">,
  modelRef: WorkflowModelRef | undefined,
): Model<any> | undefined {
  if (!modelRef) return undefined;

  if (typeof modelRef === "string") {
    const slash = modelRef.indexOf("/");
    if (slash > 0) {
      const provider = modelRef.slice(0, slash);
      const id = modelRef.slice(slash + 1);
      const model = modelRegistry.find(provider, id);
      if (!model) throw new Error(`Unknown workflow agent model "${modelRef}"`);
      return model;
    }

    const matches = modelRegistry.getAll().filter((model) => model.id === modelRef);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      const refs = matches.map((model) => `${model.provider}/${model.id}`).join(", ");
      throw new Error(`Ambiguous workflow agent model "${modelRef}". Use one of: ${refs}`);
    }
    throw new Error(`Unknown workflow agent model "${modelRef}"`);
  }

  const provider = modelRef.provider?.trim();
  const id = modelRef.id?.trim();
  if (!provider || !id) throw new Error("Workflow agent model object must include provider and id");
  const model = modelRegistry.find(provider, id);
  if (!model) throw new Error(`Unknown workflow agent model "${provider}/${id}"`);
  return model;
}
