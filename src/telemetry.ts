import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, SessionStats } from "@earendil-works/pi-coding-agent";
import type {
  WorkflowAgentActivity,
  WorkflowAgentRunMetadata,
  WorkflowContextUsage,
  WorkflowTokenUsage,
} from "./options.js";

const DEFAULT_PREVIEW_MAX = 120;

export function workflowTelemetryFromSessionEvent(event: AgentSessionEvent): Partial<WorkflowAgentRunMetadata> {
  const update: Partial<WorkflowAgentRunMetadata> = {};
  const activity = activityFromSessionEvent(event);
  const assistantMessage = assistantMessageFromSessionEvent(event);
  const usage = usageFromAssistantMessage(assistantMessage);
  const outputPreview = assistantTextPreview(assistantMessage);

  if (activity) update.activity = activity;
  if (usage) update.usage = usage;
  if (outputPreview) update.outputPreview = outputPreview;
  return update;
}

export function activityFromSessionEvent(
  event: AgentSessionEvent,
  now = Date.now(),
): WorkflowAgentActivity | undefined {
  switch (event.type) {
    case "agent_start":
      return { kind: "starting", text: "starting", updatedAt: now };
    case "turn_start":
      return { kind: "thinking", text: "thinking", updatedAt: now };
    case "message_update":
      return activityFromAssistantUpdate(event.assistantMessageEvent, now);
    case "tool_execution_start":
      return {
        kind: "tool_running",
        text: toolActivityText("running", event.toolName, event.args),
        toolName: event.toolName,
        toolArgsPreview: previewValue(event.args),
        updatedAt: now,
      };
    case "tool_execution_update":
      return {
        kind: "tool_running",
        text: toolActivityText("running", event.toolName, event.args),
        toolName: event.toolName,
        toolArgsPreview: previewValue(event.args),
        toolResultPreview: previewValue(event.partialResult),
        updatedAt: now,
      };
    case "tool_execution_end":
      return {
        kind: event.isError ? "error" : "tool_done",
        text: toolActivityText(event.isError ? "tool error" : "finished", event.toolName, undefined),
        toolName: event.toolName,
        toolResultPreview: previewValue(event.result),
        updatedAt: now,
      };
    case "auto_retry_start":
      return {
        kind: "waiting",
        text: `retrying after error (${event.attempt}/${event.maxAttempts})`,
        preview: event.errorMessage,
        updatedAt: now,
      };
    case "compaction_start":
      return { kind: "waiting", text: `compacting context (${event.reason})`, updatedAt: now };
    case "compaction_end":
      return event.errorMessage
        ? { kind: "error", text: "compaction failed", preview: event.errorMessage, updatedAt: now }
        : { kind: "waiting", text: "context compacted", updatedAt: now };
    case "agent_end":
      return { kind: "done", text: "done", updatedAt: now };
    default:
      return undefined;
  }
}

export function usageFromMessages(messages: unknown[]): WorkflowTokenUsage | undefined {
  const assistantUsages = messages
    .map((message) => usageFromAssistantMessage(message))
    .filter((usage): usage is WorkflowTokenUsage => Boolean(usage));

  if (assistantUsages.length === 0) return undefined;

  const usage = sumWorkflowUsage(assistantUsages);
  return usage ? { ...usage, turns: assistantUsages.length } : undefined;
}

export function usageFromSessionStats(stats: SessionStats | undefined): WorkflowTokenUsage | undefined {
  if (!stats) return undefined;
  return {
    input: numberOrZero(stats.tokens.input),
    output: numberOrZero(stats.tokens.output),
    cacheRead: numberOrZero(stats.tokens.cacheRead),
    cacheWrite: numberOrZero(stats.tokens.cacheWrite),
    total: numberOrZero(stats.tokens.total),
    // Session stats only expose an aggregate cost; leave the per-bucket breakdown undefined
    // (unknown) rather than reporting a misleading zero for each component.
    cost: { total: numberOrZero(stats.cost) },
    turns: stats.assistantMessages,
  };
}

export function contextUsageFromSessionStats(stats: SessionStats | undefined): WorkflowContextUsage | undefined {
  return stats?.contextUsage ? { ...stats.contextUsage } : undefined;
}

export function sumWorkflowUsage(values: Array<WorkflowTokenUsage | undefined>): WorkflowTokenUsage | undefined {
  const usages = values.filter((usage): usage is WorkflowTokenUsage => Boolean(usage));
  if (usages.length === 0) return undefined;

  return usages.reduce<WorkflowTokenUsage>(
    (sum, usage) => ({
      input: sum.input + usage.input,
      output: sum.output + usage.output,
      cacheRead: sum.cacheRead + usage.cacheRead,
      cacheWrite: sum.cacheWrite + usage.cacheWrite,
      total: sum.total + usage.total,
      // Cost buckets may be undefined (unknown) when derived from session stats; coalesce to 0.
      cost: {
        input: numberOrZero(sum.cost.input) + numberOrZero(usage.cost.input),
        output: numberOrZero(sum.cost.output) + numberOrZero(usage.cost.output),
        cacheRead: numberOrZero(sum.cost.cacheRead) + numberOrZero(usage.cost.cacheRead),
        cacheWrite: numberOrZero(sum.cost.cacheWrite) + numberOrZero(usage.cost.cacheWrite),
        total: numberOrZero(sum.cost.total) + numberOrZero(usage.cost.total),
      },
      turns: (sum.turns ?? 0) + (usage.turns ?? 0),
    }),
    {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      turns: 0,
    },
  );
}

export function previewValue(value: unknown, max = DEFAULT_PREVIEW_MAX): string {
  if (max <= 0) return "";
  if (value === undefined || value === null) return "";
  const text =
    typeof value === "string"
      ? value
      : (safeJson(value) ??
        (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint"
          ? String(value)
          : Object.prototype.toString.call(value)));
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function activityFromAssistantUpdate(
  update: AgentSessionEvent extends infer Event
    ? Event extends { type: "message_update"; assistantMessageEvent: infer AssistantEvent }
      ? AssistantEvent
      : never
    : never,
  now: number,
): WorkflowAgentActivity | undefined {
  const event = update as {
    type?: string;
    delta?: string;
    content?: string;
    toolCall?: { name?: string; arguments?: unknown };
    partial?: unknown;
    message?: unknown;
    error?: unknown;
    reason?: string;
  };

  switch (event.type) {
    case "thinking_start":
    case "thinking_delta":
    case "thinking_end":
      return {
        kind: "thinking",
        text: "thinking",
        preview: previewValue(event.delta ?? event.content),
        updatedAt: now,
      };
    case "text_start":
    case "text_delta":
    case "text_end":
      return {
        kind: "responding",
        text: "responding",
        preview: previewValue(event.delta ?? event.content),
        updatedAt: now,
      };
    case "toolcall_start":
    case "toolcall_delta": {
      const toolCall = latestToolCall(event.partial);
      return {
        kind: "tool_calling",
        text: toolCall?.name ? `preparing ${toolCall.name}` : "preparing tool call",
        toolName: toolCall?.name,
        preview: previewValue(event.delta),
        updatedAt: now,
      };
    }
    case "toolcall_end":
      return {
        kind: "tool_calling",
        text: event.toolCall?.name ? `calling ${event.toolCall.name}` : "calling tool",
        toolName: event.toolCall?.name,
        toolArgsPreview: previewValue(event.toolCall?.arguments),
        updatedAt: now,
      };
    case "done":
      return {
        kind: event.reason === "toolUse" ? "waiting" : "responding",
        text: event.reason === "toolUse" ? "waiting for tools" : "response complete",
        updatedAt: now,
      };
    case "error":
      return { kind: "error", text: "model error", preview: previewValue(event.error), updatedAt: now };
    default:
      return undefined;
  }
}

function assistantMessageFromSessionEvent(event: AgentSessionEvent): unknown {
  if ("assistantMessageEvent" in event) {
    const messageEvent = event.assistantMessageEvent as {
      partial?: unknown;
      message?: unknown;
      error?: unknown;
    };
    return messageEvent.message ?? messageEvent.error ?? messageEvent.partial;
  }
  if ("message" in event) return event.message;
  if ("messages" in event) return lastAssistantMessage(event.messages);
  return undefined;
}

function usageFromAssistantMessage(message: unknown): WorkflowTokenUsage | undefined {
  const assistant = message as Partial<AssistantMessage> | undefined;
  const usage = assistant?.role === "assistant" ? assistant.usage : undefined;
  if (!usage) return undefined;
  return usageFromProviderUsage(usage);
}

function usageFromProviderUsage(usage: Usage): WorkflowTokenUsage {
  return {
    input: numberOrZero(usage.input),
    output: numberOrZero(usage.output),
    cacheRead: numberOrZero(usage.cacheRead),
    cacheWrite: numberOrZero(usage.cacheWrite),
    total: numberOrZero(usage.totalTokens),
    cost: {
      input: numberOrZero(usage.cost?.input),
      output: numberOrZero(usage.cost?.output),
      cacheRead: numberOrZero(usage.cost?.cacheRead),
      cacheWrite: numberOrZero(usage.cost?.cacheWrite),
      total: numberOrZero(usage.cost?.total),
    },
    turns: 1,
  };
}

function assistantTextPreview(message: unknown): string | undefined {
  const assistant = message as Partial<AssistantMessage> | undefined;
  if (assistant?.role !== "assistant" || !Array.isArray(assistant.content)) return undefined;
  const text = assistant.content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
  return previewValue(text);
}

function lastAssistantMessage(messages: unknown): unknown {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { role?: string } | undefined;
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function latestToolCall(message: unknown): { name?: string; arguments?: unknown } | undefined {
  const assistant = message as Partial<AssistantMessage> | undefined;
  if (assistant?.role !== "assistant" || !Array.isArray(assistant.content)) return undefined;
  for (let index = assistant.content.length - 1; index >= 0; index--) {
    const part = assistant.content[index] as { type?: string; name?: string; arguments?: unknown } | undefined;
    if (part?.type === "toolCall") return { name: part.name, arguments: part.arguments };
  }
  return undefined;
}

function toolActivityText(verb: string, toolName: string, args: unknown): string {
  const target = toolTargetPreview(toolName, args);
  return target ? `${verb} ${toolName} ${target}` : `${verb} ${toolName}`;
}

function toolTargetPreview(toolName: string, args: unknown): string {
  const value = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  switch (toolName) {
    case "bash":
      return previewValue(value.command ?? value.cmd, 80);
    case "read":
    case "write":
    case "edit":
      return previewValue(value.file_path ?? value.path, 80);
    case "grep":
    case "find":
      return previewValue(value.pattern ?? value.path, 80);
    case "ls":
      return previewValue(value.path ?? ".", 80);
    default:
      return previewValue(args, 80);
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
