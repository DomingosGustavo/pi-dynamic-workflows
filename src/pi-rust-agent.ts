import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  type AgentRunOptions,
  type AgentRunResult,
  buildWorkflowAgentPrompt,
  resolveWorkflowAgentModel,
  type WorkflowAgentOptions,
} from "./agent.js";
import { DEFAULT_WORKFLOW_MODEL_CATALOG, type WorkflowModelCatalog } from "./model-selection.js";
import type { WorkflowAgentRunMetadata } from "./options.js";
import { previewValue, usageFromMessages, workflowTelemetryFromSessionEvent } from "./telemetry.js";
import { WorkflowWorktreeManager } from "./worktree.js";

export interface PiRustAgentOptions extends WorkflowAgentOptions {
  binary?: string;
  extraCliArgs?: string[];
}

interface ParsedRunResult {
  output: string;
  usageMessages: unknown[];
  error?: string;
}

const availabilityCache = new Map<string, boolean>();

export function isPiRustAvailable(binary = "pi-rust"): boolean {
  const key = `${binary}\0${process.env.PATH ?? ""}`;
  const cached = availabilityCache.get(key);
  if (cached !== undefined) return cached;

  const available = binary.includes("/") || isAbsolute(binary) ? isExecutable(binary) : isExecutableOnPath(binary);
  availabilityCache.set(key, available);
  return available;
}

export class PiRustWorkflowAgent {
  private readonly cwd: string;
  private readonly extraTools: ToolDefinition[];
  private readonly sessionOptions: NonNullable<WorkflowAgentOptions["session"]>;
  private readonly instructions?: string;
  private readonly modelCatalog: WorkflowModelCatalog;
  private readonly binary: string;
  private readonly extraCliArgs: string[];

  constructor(options: PiRustAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.extraTools = options.tools ?? [];
    this.sessionOptions = options.session ?? {};
    this.instructions = options.instructions;
    this.modelCatalog = options.modelCatalog ?? DEFAULT_WORKFLOW_MODEL_CATALOG;
    this.binary = options.binary ?? "pi-rust";
    this.extraCliArgs = options.extraCliArgs ?? [];
  }

  async run<TSchemaDef extends TSchema | undefined = undefined>(
    prompt: string,
    options: AgentRunOptions<TSchemaDef> = {},
  ): Promise<AgentRunResult<TSchemaDef>> {
    if (this.extraTools.length > 0 || (options.tools?.length ?? 0) > 0) {
      throw new Error("pi-rust runner does not support custom in-process tools");
    }

    const { selected, resolvedModel, thinkingLevel } = resolveWorkflowAgentModel({
      sessionOptions: this.sessionOptions,
      modelCatalog: this.modelCatalog,
      model: options.model,
      job: options.job,
      thinkingLevel: options.thinkingLevel,
    });
    const metadata: WorkflowAgentRunMetadata = {
      cwd: this.cwd,
      model: resolvedModel ? { provider: resolvedModel.provider, id: resolvedModel.id } : undefined,
      thinkingLevel,
      modelSelection: selected
        ? { job: selected.job, considered: selected.considered, reason: selected.reason }
        : undefined,
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

      const finalPrompt = buildWorkflowAgentPrompt(
        prompt,
        options as AgentRunOptions<any>,
        this.instructions,
        options.schema ? finalJsonContract(options.schema) : undefined,
      );
      const args = [
        "-p",
        "--mode",
        "json",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        ...(resolvedModel ? ["--provider", resolvedModel.provider, "--model", resolvedModel.id] : []),
        ...(thinkingLevel ? ["--thinking", thinkingLevel] : []),
        ...this.extraCliArgs,
        finalPrompt,
      ];
      const run = await this.runCli(args, runCwd, options.signal, emitUpdate);
      if (run.error) throw new Error(`pi-rust subagent failed: ${run.error}`);

      if (options.schema) {
        const parsed = parseStructuredJson(options.schema, run.output);
        recordFinalMetadata(metadata, run.usageMessages, parsed);
        emitUpdate();
        success = true;
        return parsed as AgentRunResult<TSchemaDef>;
      }

      recordFinalMetadata(metadata, run.usageMessages, run.output);
      emitUpdate();
      success = true;
      return run.output as AgentRunResult<TSchemaDef>;
    } finally {
      if (activeWorktree) metadata.worktree = await activeWorktree.finish(success);
      emitUpdate();
      options.onMetadata?.(metadata);
    }
  }

  private runCli(
    args: string[],
    cwd: string,
    signal: AbortSignal | undefined,
    emitUpdate: (patch?: Partial<WorkflowAgentRunMetadata>) => void,
  ): Promise<ParsedRunResult> {
    if (signal?.aborted) throw createAbortError();

    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      const usageMessages: unknown[] = [];
      const agentEndMessages: unknown[] = [];
      let lastAssistantMessageEnd: unknown;
      let agentEndError: string | undefined;
      let stdoutBuffer = "";
      let stderr = "";
      let aborted = false;
      let killTimer: NodeJS.Timeout | undefined;

      const cleanup = () => {
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        aborted = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let event: any;
        try {
          event = JSON.parse(trimmed);
        } catch {
          return;
        }

        if (event?.type === "message_end" && event.message?.role === "assistant") {
          usageMessages.push(event.message);
          lastAssistantMessageEnd = event.message;
        }
        if (event?.type === "agent_end") {
          if (Array.isArray(event.messages)) {
            agentEndMessages.splice(0, agentEndMessages.length, ...event.messages);
            if (usageMessages.length === 0) {
              usageMessages.push(...event.messages.filter((message: any) => message?.role === "assistant"));
            }
          }
          if (typeof event.error === "string" && event.error.trim()) agentEndError = event.error.trim();
        }

        const update = workflowTelemetryFromSessionEvent(event);
        const usage = usageFromMessages(usageMessages);
        if (usage) update.usage = usage;
        if (Object.keys(update).length > 0) emitUpdate(update);
      };

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        let newline = stdoutBuffer.indexOf("\n");
        while (newline >= 0) {
          const line = stdoutBuffer.slice(0, newline);
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          handleLine(line);
          newline = stdoutBuffer.indexOf("\n");
        }
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        cleanup();
        reject(error);
      });
      child.on("close", (code) => {
        cleanup();
        if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
        if (aborted || signal?.aborted) {
          reject(createAbortError());
          return;
        }
        const output = lastAssistantText(agentEndMessages) || lastAssistantText([lastAssistantMessageEnd]);
        if (code !== 0) {
          const detail = agentEndError ?? stderr.trim() ?? `exit code ${code ?? "unknown"}`;
          reject(new Error(`pi-rust subagent failed: ${detail}`));
          return;
        }
        resolve({ output, usageMessages, error: agentEndError });
      });
    });
  }
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isExecutableOnPath(binary: string): boolean {
  const paths = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  if (paths.some((entry) => isExecutable(join(entry, binary)))) return true;
  // Last-resort fallback for platforms/environments where PATH lookup has custom behavior.
  const result = spawnSync(binary, ["--version"], { stdio: "ignore", timeout: 1000 });
  return !result.error;
}

function finalJsonContract(schema: TSchema): string {
  return [
    "Final output contract:",
    "- Your FINAL assistant message MUST be exactly one JSON object matching this schema, with no prose outside it.",
    "- You may wrap the JSON object in a single ```json fenced block, but do not include any other text.",
    "- If you need to inspect files or run commands first, do so, then end with only the JSON object.",
    "JSON schema:",
    JSON.stringify(schema, null, 2),
  ].join("\n");
}

function parseStructuredJson<TSchemaDef extends TSchema>(schema: TSchemaDef, text: string): unknown {
  const parsed = extractJson(text);
  if (!Value.Check(schema, parsed)) {
    const details = [...Value.Errors(schema, parsed)]
      .slice(0, 5)
      .map((error) => error.message)
      .join("; ");
    throw new Error(`Subagent final JSON failed schema validation${details ? `: ${details}` : ""}`);
  }
  return parsed;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const whole = tryParseJson(trimmed);
  if (whole.ok) return whole.value;

  const fences = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const parsed = tryParseJson(fences[i][1].trim());
    if (parsed.ok) return parsed.value;
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const parsed = tryParseJson(trimmed.slice(first, last + 1));
    if (parsed.ok) return parsed.value;
  }

  throw new Error("Subagent returned invalid JSON for schema validation");
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function recordFinalMetadata(metadata: WorkflowAgentRunMetadata, messages: unknown[], output: unknown): void {
  const usage = usageFromMessages(messages);
  if (usage) metadata.usage = usage;
  metadata.outputPreview = previewValue(output);
  metadata.activity = { kind: "done", text: "done", updatedAt: Date.now() };
}

function lastAssistantText(messages: unknown[]): string {
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

function createAbortError(message = "Subagent was aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
