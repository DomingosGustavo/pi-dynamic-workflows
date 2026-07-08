import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  WorkflowAgentActivity,
  WorkflowAgentRunMetadata,
  WorkflowContextUsage,
  WorkflowModelRef,
  WorkflowReviewMetadata,
  WorkflowThinkingLevel,
  WorkflowTokenUsage,
  WorktreeIsolation,
} from "./options.js";
import { previewValue, sumWorkflowUsage } from "./telemetry.js";
import type { WorkflowMeta } from "./workflow.js";

export type WorkflowAgentStatus = "queued" | "running" | "done" | "error" | "skipped";

export interface WorkflowAgentSnapshot {
  id: number;
  label: string;
  phase?: string;
  prompt: string;
  status: WorkflowAgentStatus;
  model?: WorkflowModelRef;
  thinkingLevel?: WorkflowThinkingLevel;
  isolation?: WorktreeIsolation;
  metadata?: WorkflowAgentRunMetadata;
  activity?: WorkflowAgentActivity;
  usage?: WorkflowTokenUsage;
  contextUsage?: WorkflowContextUsage;
  promptPreview?: string;
  outputPreview?: string;
  resultPreview?: string;
  error?: string;
}

export interface WorkflowSnapshot {
  name: string;
  description?: string;
  phases: string[];
  currentPhase?: string;
  logs: string[];
  agents: WorkflowAgentSnapshot[];
  agentCount: number;
  runningCount: number;
  doneCount: number;
  errorCount: number;
  skippedCount: number;
  durationMs?: number;
  usage?: WorkflowTokenUsage;
  review?: WorkflowReviewMetadata;
  result?: unknown;
}

export interface WorkflowDisplay {
  update(snapshot: WorkflowSnapshot): void;
  complete(snapshot: WorkflowSnapshot): void;
  clear(): void;
}

export interface WorkflowDisplayOptions {
  key?: string;
  placement?: "aboveEditor" | "belowEditor";
  maxAgents?: number;
  maxLogs?: number;
  showStatus?: boolean;
  showResultPreviews?: boolean;
  showModel?: boolean;
  showUsage?: boolean;
  showActivity?: boolean;
  showPreviews?: boolean;
  previewWidth?: number;
}

export function createWorkflowSnapshot(meta: WorkflowMeta): WorkflowSnapshot {
  return {
    name: meta.name,
    description: meta.description,
    phases: [],
    logs: [],
    agents: [],
    agentCount: 0,
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
    skippedCount: 0,
  };
}

export function recomputeWorkflowSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  const runningCount = snapshot.agents.filter((agent) => agent.status === "running").length;
  const doneCount = snapshot.agents.filter((agent) => agent.status === "done").length;
  const errorCount = snapshot.agents.filter((agent) => agent.status === "error").length;
  const skippedCount = snapshot.agents.filter((agent) => agent.status === "skipped").length;
  const usage = sumWorkflowUsage(snapshot.agents.map((agent) => agent.usage ?? agent.metadata?.usage));
  return {
    ...snapshot,
    agentCount: snapshot.agents.length,
    runningCount,
    doneCount,
    errorCount,
    skippedCount,
    usage,
  };
}

export function createWidgetWorkflowDisplay(
  ctx: Pick<ExtensionContext, "ui" | "hasUI">,
  options: WorkflowDisplayOptions = {},
): WorkflowDisplay {
  const key = options.key ?? "workflow";
  const placement = options.placement ?? "belowEditor";
  const showStatus = options.showStatus ?? false;

  const render = (snapshot: WorkflowSnapshot, completed = false) => {
    if (!ctx.hasUI) return;
    if (showStatus) ctx.ui.setStatus(key, statusLine(snapshot, completed));
    ctx.ui.setWidget(key, renderWorkflowLines(snapshot, options), { placement });
  };

  return {
    update(snapshot) {
      render(snapshot, false);
    },
    complete(snapshot) {
      render(snapshot, true);
    },
    clear() {
      if (!ctx.hasUI) return;
      if (showStatus) ctx.ui.setStatus(key, undefined);
      ctx.ui.setWidget(key, undefined);
    },
  };
}

export function createToolUpdateWorkflowDisplay(
  onUpdate: ((result: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void) | undefined,
  ctx?: Pick<ExtensionContext, "ui" | "hasUI">,
  options: WorkflowDisplayOptions & { streamToolUpdates?: boolean; clearWidgetOnComplete?: boolean } = {},
): WorkflowDisplay {
  const widget = ctx ? createWidgetWorkflowDisplay(ctx, options) : undefined;
  const streamToolUpdates = options.streamToolUpdates ?? !ctx?.hasUI;
  const clearWidgetOnComplete = options.clearWidgetOnComplete ?? false;

  const emit = (snapshot: WorkflowSnapshot, completed = false) => {
    if (streamToolUpdates) {
      onUpdate?.({
        content: [{ type: "text", text: renderWorkflowText(snapshot, completed, options) }],
        details: snapshot,
      });
    }
    if (completed && clearWidgetOnComplete) widget?.clear();
    else if (completed) widget?.complete(snapshot);
    else widget?.update(snapshot);
  };

  return {
    update(snapshot) {
      emit(snapshot, false);
    },
    complete(snapshot) {
      emit(snapshot, true);
    },
    clear() {
      widget?.clear();
    },
  };
}

export function renderWorkflowLines(snapshot: WorkflowSnapshot, options: WorkflowDisplayOptions = {}): string[] {
  const maxAgents = options.maxAgents ?? 8;
  const maxLogs = options.maxLogs ?? 2;
  const showResultPreviews = options.showResultPreviews ?? false;
  const showModel = options.showModel ?? false;
  const showUsage = options.showUsage ?? false;
  const showActivity = options.showActivity ?? false;
  const showPreviews = options.showPreviews ?? false;
  const state = [
    snapshot.errorCount > 0 ? `, ${snapshot.errorCount} errors` : "",
    snapshot.runningCount > 0 ? `, ${snapshot.runningCount} running` : "",
    snapshot.skippedCount > 0 ? `, ${snapshot.skippedCount} skipped` : "",
  ].join("");
  const headerUsage = showUsage ? formatUsage(snapshot.usage) : undefined;
  const lines = [
    `◆ Workflow: ${snapshot.name} (${snapshot.doneCount}/${snapshot.agentCount} done${state})${headerUsage ? ` · ${headerUsage}` : ""}`,
  ];

  // Single pass: bucket agents by phase (preserving append order) and tally per-phase counts,
  // instead of re-filtering the agent list once per phase.
  const byPhase = new Map<string, PhaseBucket>();
  const bucketFor = (phase: string): PhaseBucket => {
    let bucket = byPhase.get(phase);
    if (!bucket) {
      bucket = { agents: [], done: 0, running: 0, errors: 0, skipped: 0 };
      byPhase.set(phase, bucket);
    }
    return bucket;
  };
  // Seed declared phases (and current phase) so empty-but-current phases can still render.
  for (const phase of snapshot.phases) bucketFor(phase);
  if (snapshot.currentPhase) bucketFor(snapshot.currentPhase);
  for (const agent of snapshot.agents) {
    if (!agent.phase) continue;
    const bucket = bucketFor(agent.phase);
    bucket.agents.push(agent);
    if (agent.status === "done") bucket.done++;
    else if (agent.status === "running") bucket.running++;
    else if (agent.status === "error") bucket.errors++;
    else if (agent.status === "skipped") bucket.skipped++;
  }
  const rendered = new Set<WorkflowAgentSnapshot>();

  for (const [phase, bucket] of byPhase) {
    const agents = bucket.agents;
    if (agents.length === 0 && snapshot.currentPhase !== phase) continue;
    for (const agent of agents) rendered.add(agent);
    const { done, running, errors, skipped } = bucket;
    const complete = agents.length > 0 && done + errors + skipped === agents.length;
    const marker = running > 0 || (!complete && snapshot.currentPhase === phase) ? "▶" : complete ? "✓" : " ";
    lines.push(
      `  ${marker} ${phase} ${done}/${agents.length}${running ? ` · ${running} running` : ""}${errors ? ` · ${errors} errors` : ""}${skipped ? ` · ${skipped} skipped` : ""}`,
    );

    const visibleAgents = agents.slice(-maxAgents);
    for (const agent of visibleAgents) {
      lines.push(renderAgentLine(agent, { ...options, showModel, showUsage, showActivity, showPreviews }));
      if (showPreviews) lines.push(...renderAgentPreviewLines(agent, options));
      else if (showResultPreviews && agent.resultPreview) {
        lines[lines.length - 1] += ` — ${shorten(agent.resultPreview, options.previewWidth ?? 96)}`;
      }
    }
    if (agents.length > visibleAgents.length)
      lines.push(`    … ${agents.length - visibleAgents.length} earlier agents`);
  }

  const unphased = snapshot.agents.filter((agent) => !rendered.has(agent));
  if (unphased.length) {
    lines.push("  Unphased");
    for (const agent of unphased.slice(-maxAgents)) {
      lines.push(renderAgentLine(agent, { ...options, showModel, showUsage, showActivity, showPreviews }));
      if (showPreviews) lines.push(...renderAgentPreviewLines(agent, options));
      else if (showResultPreviews && agent.resultPreview) {
        lines[lines.length - 1] += ` — ${shorten(agent.resultPreview, options.previewWidth ?? 96)}`;
      }
    }
  }

  const visibleLogs = snapshot.logs.slice(-maxLogs);
  if (visibleLogs.length) {
    if (lines.length > 1) lines.push("");
    for (const log of visibleLogs) lines.push(`  log: ${log}`);
  }
  return lines;
}

export function renderWorkflowText(
  snapshot: WorkflowSnapshot,
  completed = false,
  options: WorkflowDisplayOptions = {},
): string {
  const header = completed ? "Workflow completed" : "Workflow running";
  return [header, ...renderWorkflowLines(snapshot, options)].join("\n");
}

interface PhaseBucket {
  agents: WorkflowAgentSnapshot[];
  done: number;
  running: number;
  errors: number;
  skipped: number;
}

function statusLine(snapshot: WorkflowSnapshot, completed: boolean): string {
  const usage = snapshot.usage ? ` · ${formatUsage(snapshot.usage)}` : "";
  const skipped = snapshot.skippedCount > 0 ? `, ${snapshot.skippedCount} skipped` : "";
  if (completed) return `workflow ✓ ${snapshot.name}: ${snapshot.doneCount}/${snapshot.agentCount}${skipped}${usage}`;
  if (snapshot.runningCount > 0)
    return `workflow ${snapshot.name}: ${snapshot.runningCount} running, ${snapshot.doneCount}/${snapshot.agentCount} done${skipped}${usage}`;
  return `workflow ${snapshot.name}: ${snapshot.doneCount}/${snapshot.agentCount} done${skipped}${usage}`;
}

function statusIcon(status: WorkflowAgentStatus): string {
  switch (status) {
    case "queued":
      return "○";
    case "running":
      return "●";
    case "done":
      return "✓";
    case "error":
      return "✗";
    case "skipped":
      return "-";
  }
}

function shorten(value: string, max: number): string {
  if (max <= 0) return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function preview(value: unknown, max = 80): string {
  return previewValue(value, max);
}

function renderAgentLine(agent: WorkflowAgentSnapshot, options: WorkflowDisplayOptions): string {
  const parts = [`#${agent.id} ${statusIcon(agent.status)} ${shorten(agent.label, 40)}`];
  if (options.showModel) parts.push(formatModel(agent), formatThinkingLevel(agent));
  if (options.showActivity) parts.push(formatActivity(agent));
  if (options.showUsage) parts.push(formatUsage(agent.usage ?? agent.metadata?.usage) ?? "tokens pending");
  return `    ${parts.join(" · ")}`;
}

function renderAgentPreviewLines(agent: WorkflowAgentSnapshot, options: WorkflowDisplayOptions): string[] {
  const max = options.previewWidth ?? 108;
  const activity = agent.activity ?? agent.metadata?.activity;
  const lines: string[] = [];
  const prompt = agent.promptPreview ?? agent.metadata?.promptPreview ?? preview(agent.prompt, max);
  const output = agent.outputPreview ?? agent.metadata?.outputPreview ?? agent.resultPreview;
  const tool = activity?.toolResultPreview
    ? `${activity.toolName ?? "tool"} result: ${activity.toolResultPreview}`
    : activity?.toolArgsPreview
      ? `${activity.toolName ?? "tool"} args: ${activity.toolArgsPreview}`
      : activity?.preview;

  if (prompt) lines.push(`      in: ${shorten(prompt, max)}`);
  if (tool) lines.push(`      tool: ${shorten(tool, max)}`);
  if (output) lines.push(`      out: ${shorten(output, max)}`);
  return lines.slice(0, 3);
}

function formatModel(agent: WorkflowAgentSnapshot): string {
  const resolved = agent.metadata?.model;
  if (resolved) return `${resolved.provider}/${resolved.id}`;
  const requested = agent.model;
  if (!requested) return "model default";
  if (typeof requested === "string") return requested;
  if (requested.provider && requested.id) return `${requested.provider}/${requested.id}`;
  return requested.id ?? requested.provider ?? "model pending";
}

function formatThinkingLevel(agent: WorkflowAgentSnapshot): string {
  return agent.metadata?.thinkingLevel ?? agent.thinkingLevel ?? "effort default";
}

function formatActivity(agent: WorkflowAgentSnapshot): string {
  const activity = agent.activity ?? agent.metadata?.activity;
  if (activity?.text) return shorten(activity.text, 56);
  switch (agent.status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "done":
      return "done";
    case "error":
      return agent.error ? `error: ${shorten(agent.error, 40)}` : "error";
    case "skipped":
      return "skipped";
  }
}

function formatUsage(usage: WorkflowTokenUsage | undefined): string | undefined {
  if (!usage) return undefined;
  const parts = [`${formatTokens(usage.total)} tok`];
  if (usage.input || usage.output) parts.push(`in ${formatTokens(usage.input)}`, `out ${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`cacheR ${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`cacheW ${formatTokens(usage.cacheWrite)}`);
  if (usage.cost.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
  return parts.join(" ");
}

function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1000) return Math.round(value).toString();
  if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1000000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1000000).toFixed(1)}M`;
}
