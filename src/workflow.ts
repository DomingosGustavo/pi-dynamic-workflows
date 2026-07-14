import { createHash } from "node:crypto";
import type { Node } from "acorn";
import { parse } from "acorn";
import type { TSchema } from "typebox";
import { WorkflowAgent, type WorkflowAgentOptions } from "./agent.js";
import { DEFAULT_WORKFLOW_MODEL_CATALOG, workflowJobTypes } from "./model-selection.js";
import type {
  WorkflowAgentRunMetadata,
  WorkflowModelRef,
  WorkflowThinkingLevel,
  WorktreeIsolation,
} from "./options.js";
import type { WorkflowCompletedCheckpoint } from "./workflow-state.js";
import { normalizeWorktreeIsolation } from "./worktree.js";

export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: WorkflowMetaPhase[];
}

export interface WorkflowSerializedError {
  name: string;
  message: string;
  stack?: string;
}

export interface WorkflowPauseInfo {
  reason: string;
  data?: unknown;
  /** Deterministic key for explicit pauses. */
  key?: string;
}

export interface WorkflowResumeState {
  workflowId: string;
  tokensSpent: number;
  completed: Record<string, WorkflowCompletedCheckpoint>;
  /** Keys of explicit pauses that have already been acknowledged and should be skipped on replay. */
  acknowledgedPauseKeys?: string[];
}

type WorkflowAgentRunMetadataWithError = WorkflowAgentRunMetadata & { error?: WorkflowSerializedError };

export interface WorkflowAgentRunRecord {
  id: number;
  label: string;
  phase?: string;
  prompt: string;
  status: "running" | "done" | "error";
  result?: unknown;
  model?: WorkflowModelRef;
  thinkingLevel?: WorkflowThinkingLevel;
  isolation?: WorktreeIsolation;
  metadata?: WorkflowAgentRunMetadataWithError;
  error?: WorkflowSerializedError;
}

export interface WorkflowRunOptions extends WorkflowAgentOptions {
  args?: unknown;
  agent?: Pick<WorkflowAgent, "run">;
  concurrency?: number;
  resume?: WorkflowResumeState;
  onAgentCheckpoint?: (checkpoint: WorkflowCompletedCheckpoint, tokensSpent: number) => void | Promise<void>;
  signal?: AbortSignal;
  onLog?: (message: string) => void;
  onPhase?: (title: string) => void;
  onAgentStart?: (event: {
    id: number;
    label: string;
    phase?: string;
    prompt: string;
    model?: WorkflowModelRef;
    thinkingLevel?: WorkflowThinkingLevel;
    isolation?: WorktreeIsolation;
  }) => void;
  onAgentUpdate?: (event: {
    id: number;
    label: string;
    phase?: string;
    metadata: WorkflowAgentRunMetadataWithError;
  }) => void;
  onAgentEnd?: (event: {
    id: number;
    label: string;
    phase?: string;
    result: unknown;
    metadata?: WorkflowAgentRunMetadataWithError;
  }) => void;
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  logs: string[];
  phases: string[];
  agentCount: number;
  durationMs: number;
  agents: WorkflowAgentRunRecord[];
  tokensSpent: number;
  paused?: WorkflowPauseInfo;
}

export interface AgentOptions<TSchemaDef extends TSchema | undefined = TSchema | undefined> {
  label?: string;
  phase?: string;
  schema?: TSchemaDef;
  model?: WorkflowModelRef;
  /** Select from the configured catalog when model is omitted. */
  job?: string;
  thinkingLevel?: WorkflowThinkingLevel;
  isolation?: WorktreeIsolation;
  agentType?: string;
}

interface RuntimeState {
  currentPhase?: string;
  logs: string[];
  phases: string[];
  agentCount: number;
  spent: number;
  agents: WorkflowAgentRunRecord[];
}

type AnyNode = Node & { [key: string]: any; start: number; end: number };

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (ctx: Record<string, unknown>) => Promise<unknown>;

export async function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
  const started = Date.now();
  const { meta, body } = parseWorkflowScript(script);
  const state: RuntimeState = {
    logs: [],
    phases: [],
    agentCount: 0,
    spent: options.resume?.tokensSpent ?? 0,
    agents: [],
  };
  const agentRunner = options.agent ?? new WorkflowAgent(options);
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2), 16),
  );
  const limiter = createLimiter(concurrency);
  const pendingAgentRuns = new Set<Promise<unknown>>();
  const pendingRejections: unknown[] = [];

  const log = (message: string) => {
    const text = String(message);
    state.logs.push(text);
    options.onLog?.(text);
  };

  const phase = (title: unknown) => {
    const text = requireString(title, "phase title");
    state.currentPhase = text;
    if (!state.phases.includes(text)) state.phases.push(text);
    options.onPhase?.(text);
  };

  const throwIfAborted = () => {
    if (options.signal?.aborted) throw createAbortError("workflow aborted");
  };

  const pauseOccurrences = new Map<string, number>();
  const pause = (reason: unknown = "Workflow paused", data?: unknown): never => {
    const text = requireString(reason, "pause reason");
    if (data !== undefined) assertJsonSerializable(data, "pause data");
    const payload = stableJsonStringify({ reason: text, data });
    const payloadHash = createHash("sha256").update(payload).digest("hex").slice(0, 16);
    const occurrence = (pauseOccurrences.get(payloadHash) ?? 0) + 1;
    pauseOccurrences.set(payloadHash, occurrence);
    const key = computePauseKey(payloadHash, occurrence);
    if (options.resume?.acknowledgedPauseKeys?.includes(key)) {
      log(`[resume] skipped acknowledged pause: ${text}`);
      return undefined as never;
    }
    throw new WorkflowPauseSignal(text, data, key);
  };

  const seenLabels = new Map<string, true>();
  const completedByLabel = new Map<string, WorkflowCompletedCheckpoint>();
  if (options.resume?.completed) {
    for (const [label, checkpoint] of Object.entries(options.resume.completed)) {
      completedByLabel.set(label, checkpoint);
    }
  }
  const agent = (prompt: unknown, agentOptions: unknown = {}): Promise<unknown> => {
    throwIfAborted();
    const taskPrompt = requireString(prompt, "agent prompt");
    const normalizedOptions = normalizeAgentOptions(agentOptions);
    const assignedPhase = normalizedOptions.phase ?? state.currentPhase;
    const requestedLabel = normalizedOptions.label?.trim();
    const label = requestedLabel || defaultAgentLabel(assignedPhase, seenLabels.size + 1);
    if (seenLabels.has(label)) {
      throw new WorkflowLabelConflictError(`Duplicate workflow agent label "${label}"; labels must be unique`);
    }
    seenLabels.set(label, true);
    const catalog = options.modelCatalog ?? DEFAULT_WORKFLOW_MODEL_CATALOG;
    const knownJobs = workflowJobTypes(catalog);
    if (!normalizedOptions.model && !normalizedOptions.job) {
      throw new WorkflowConfigurationError(
        `agent "${label}" must specify an explicit model or a job work type (one of: ${knownJobs.join(", ")})`,
      );
    }
    // A bogus job string is a script bug even when an explicit model wins for
    // execution: it still pollutes the checkpoint fingerprint, so reject it.
    if (normalizedOptions.job && !Object.hasOwn(catalog.work, normalizedOptions.job)) {
      throw new WorkflowConfigurationError(
        `Unknown workflow job type "${normalizedOptions.job}". Known types: ${knownJobs.join(", ")}`,
      );
    }
    const fingerprint = computeAgentFingerprint(taskPrompt, assignedPhase, label, normalizedOptions);

    const run = limiter(async () => {
      const replay = completedByLabel.get(label);
      if (replay) {
        if (!replay.fingerprint) {
          throw new WorkflowInfrastructureError(
            `Cannot reuse completed agent "${label}": checkpoint is missing a fingerprint. ` +
              "Legacy checkpoints are not supported; restart the workflow instead.",
          );
        }
        if (replay.fingerprint !== fingerprint) {
          throw new WorkflowInfrastructureError(
            `Cannot reuse completed agent "${label}": fingerprint mismatch. ` +
              "The replay-relevant invocation changed; restart the workflow instead.",
          );
        }
        const id = ++state.agentCount;
        const record: WorkflowAgentRunRecord = {
          id,
          label,
          phase: assignedPhase,
          prompt: taskPrompt,
          status: "done",
          result: replay.result,
          model: normalizedOptions.model,
          thinkingLevel: normalizedOptions.thinkingLevel,
          isolation: normalizedOptions.isolation,
          metadata: replay.metadata,
        };
        state.agents.push(record);
        log(`reused completed agent ${label} from workflow ${options.resume?.workflowId}`);
        options.onAgentStart?.({
          id,
          label,
          phase: assignedPhase,
          prompt: taskPrompt,
          model: normalizedOptions.model,
          thinkingLevel: normalizedOptions.thinkingLevel,
          isolation: normalizedOptions.isolation,
        });
        options.onAgentEnd?.({ id, label, phase: assignedPhase, result: replay.result, metadata: replay.metadata });
        return replay.result;
      }

      const id = ++state.agentCount;
      const record: WorkflowAgentRunRecord = {
        id,
        label,
        phase: assignedPhase,
        prompt: taskPrompt,
        status: "running",
        model: normalizedOptions.model,
        thinkingLevel: normalizedOptions.thinkingLevel,
        isolation: normalizedOptions.isolation,
      };
      state.agents.push(record);
      let metadata: WorkflowAgentRunMetadataWithError | undefined;
      let lastUsageTotal = 0;
      const recordUsageDelta = (value: WorkflowAgentRunMetadata | undefined) => {
        const total = value?.usage?.total;
        const tokenDelta =
          typeof total === "number" && Number.isFinite(total) && total > lastUsageTotal ? total - lastUsageTotal : 0;
        state.spent += tokenDelta;
        lastUsageTotal += tokenDelta;
      };

      options.onAgentStart?.({
        id,
        label,
        phase: assignedPhase,
        prompt: taskPrompt,
        model: normalizedOptions.model,
        thinkingLevel: normalizedOptions.thinkingLevel,
        isolation: normalizedOptions.isolation,
      });
      let agentResult: unknown;
      let agentSucceeded = false;
      try {
        throwIfAborted();
        const result = await agentRunner.run(taskPrompt, {
          label,
          schema: normalizedOptions.schema,
          signal: options.signal,
          instructions: buildAgentInstructions(assignedPhase, normalizedOptions),
          model: normalizedOptions.model,
          job: normalizedOptions.job,
          thinkingLevel: normalizedOptions.thinkingLevel,
          isolation: normalizedOptions.isolation,
          onMetadata(value: WorkflowAgentRunMetadata) {
            metadata = value;
            record.metadata = metadata;
            recordUsageDelta(value);
          },
          onUpdate(value: WorkflowAgentRunMetadata) {
            metadata = value;
            record.metadata = metadata;
            recordUsageDelta(value);
            options.onAgentUpdate?.({ id, label, phase: assignedPhase, metadata });
          },
        } as any);
        throwIfAborted();
        recordUsageDelta(metadata);
        assertJsonSerializable(result, `result for agent "${label}"`);
        agentResult = result;
        agentSucceeded = true;
      } catch (error) {
        if (isAbortError(error)) throw error;
        const errorInfo = serializeError(error);
        metadata = attachAgentError(metadata, errorInfo, options.cwd);
        recordUsageDelta(metadata);
        record.status = "error";
        record.result = null;
        record.metadata = metadata;
        record.error = errorInfo;
        log(`agent ${label} failed: ${errorInfo.message}`);
        options.onAgentEnd?.({ id, label, phase: assignedPhase, result: null, metadata });
        return null;
      }
      if (agentSucceeded) {
        record.status = "done";
        record.result = agentResult;
        record.metadata = metadata;
        try {
          await options.onAgentCheckpoint?.({ label, result: agentResult, metadata, fingerprint }, state.spent);
        } catch (error) {
          throw new WorkflowInfrastructureError(
            `Failed to persist checkpoint for agent "${label}": ${error instanceof Error ? error.message : String(error)}`,
            error,
          );
        }
        options.onAgentEnd?.({ id, label, phase: assignedPhase, result: agentResult, metadata });
        return agentResult;
      }
      return null;
    });
    pendingAgentRuns.add(run);
    run.then(
      () => pendingAgentRuns.delete(run),
      (reason) => {
        pendingAgentRuns.delete(run);
        pendingRejections.push(reason);
      },
    );
    return run;
  };

  const PAUSED = Symbol("workflow paused");
  const parallel = async (thunks: Array<() => Promise<unknown>>) => {
    throwIfAborted();
    if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
    if (thunks.some((thunk) => typeof thunk !== "function")) {
      throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
    }
    const results = await Promise.all(
      thunks.map(async (thunk, index) => {
        try {
          return await thunk();
        } catch (error) {
          if (
            isWorkflowLabelConflictError(error) ||
            isWorkflowInfrastructureError(error) ||
            isWorkflowConfigurationError(error)
          )
            throw error;
          if (isAbortError(error)) throw error;
          if (isWorkflowPauseSignal(error)) return { [PAUSED]: error };
          log(`parallel[${index}] failed: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        }
      }),
    );
    const paused = results.find(
      (result): result is { [PAUSED]: unknown } => !!result && typeof result === "object" && PAUSED in result,
    );
    if (paused) throw paused[PAUSED];
    return results;
  };

  const pipeline = async (
    items: unknown[],
    ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
  ) => {
    throwIfAborted();
    if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
    if (stages.some((stage) => typeof stage !== "function")) {
      throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
    }
    const results = await Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item;
        for (const stage of stages) {
          try {
            throwIfAborted();
            value = await stage(value, item, index);
            throwIfAborted();
          } catch (error) {
            if (
              isWorkflowLabelConflictError(error) ||
              isWorkflowInfrastructureError(error) ||
              isWorkflowConfigurationError(error)
            )
              throw error;
            if (isAbortError(error)) throw error;
            if (isWorkflowPauseSignal(error)) return { [PAUSED]: error };
            log(`pipeline[${index}] failed: ${error instanceof Error ? error.message : String(error)}`);
            return null;
          }
        }
        return value;
      }),
    );
    const paused = results.find(
      (result): result is { [PAUSED]: unknown } => !!result && typeof result === "object" && PAUSED in result,
    );
    if (paused) throw paused[PAUSED];
    return results;
  };

  const context = {
    agent,
    parallel,
    pipeline,
    log,
    phase,
    pause,
    args: options.args,
    cwd: options.cwd ?? process.cwd(),
    process: Object.freeze({ cwd: () => options.cwd ?? process.cwd() }),
    console: {
      log,
      info: log,
      warn: (m: unknown) => log(`[warn] ${String(m)}`),
      error: (m: unknown) => log(`[error] ${String(m)}`),
    },
    JSON,
    Math,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Set,
    Map,
    Promise,
  };

  const fn = new AsyncFunction(
    "ctx",
    `
const { agent, parallel, pipeline, log, phase, pause, args, cwd, process, console, JSON, Math, Array, Object, String, Number, Boolean, Set, Map, Promise } = ctx;
${body}
`,
  );
  let result: unknown;
  let paused: WorkflowPauseInfo | undefined;
  try {
    result = await fn(context);
  } catch (error) {
    if (!isWorkflowPauseSignal(error)) throw error;
    paused = { reason: error.message, data: error.data, key: error.key };
    log(`[paused] ${error.message}`);
  }
  if (pendingAgentRuns.size > 0) {
    log(`[warn] awaited ${pendingAgentRuns.size} unawaited agent() call(s) after workflow script returned`);
    await Promise.allSettled([...pendingAgentRuns]);
  }
  const unawaitedRejections = pendingRejections.filter((reason) => {
    if (isWorkflowPauseSignal(reason) && paused) return false;
    return true;
  });
  if (unawaitedRejections.length > 0) {
    log(`[warn] ${unawaitedRejections.length} unawaited agent() call(s) rejected`);
    const first = unawaitedRejections[0];
    if (isWorkflowPauseSignal(first)) throw first;
    if (isAbortError(first)) throw first;
    if (unawaitedRejections.length === 1) {
      throw first instanceof Error ? first : new Error(String(first));
    }
    const messages = unawaitedRejections.map((reason) => (reason instanceof Error ? reason.message : String(reason)));
    const aggregate = new Error(`${unawaitedRejections.length} unawaited agent calls rejected: ${messages.join("; ")}`);
    throw aggregate;
  }
  if (!paused) assertJsonSerializable(result, "workflow result");
  return {
    meta,
    result: (paused ? null : result) as T,
    logs: state.logs,
    phases: state.phases,
    agentCount: state.agentCount,
    durationMs: Date.now() - started,
    agents: state.agents,
    tokensSpent: state.spent,
    paused,
  };
}

export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string } {
  const ast = parse(script, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    ranges: false,
  }) as AnyNode;

  const first = ast.body?.[0] as AnyNode | undefined;
  if (first?.type !== "ExportNamedDeclaration") {
    throw new Error("`export const meta = { name, description }` must be the first statement in the script");
  }

  const declaration = first.declaration as AnyNode | null;
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
    throw new Error("meta export must be `export const meta = ...`");
  }
  if (declaration.declarations.length !== 1) {
    throw new Error("meta export must declare only `meta`");
  }

  const declarator = declaration.declarations[0] as AnyNode;
  if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta") {
    throw new Error("meta export must declare `meta`");
  }
  if (!declarator.init) throw new Error("meta must have a literal value");

  const meta = evaluateLiteral(declarator.init, "meta");
  validateMeta(meta);

  for (const node of (ast.body as AnyNode[]).slice(1)) {
    if (isModuleOnlySyntax(node)) {
      throw new Error("workflow scripts do not support import/export statements after the meta export");
    }
  }

  return {
    meta,
    body: script.slice(0, first.start) + script.slice(first.end),
  };
}

function evaluateLiteral(node: AnyNode, path: string): unknown {
  switch (node.type) {
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties as AnyNode[]) {
        if (prop.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        if (prop.type !== "Property") throw new Error(`only plain properties allowed in ${path}`);
        if (prop.computed) throw new Error(`computed keys not allowed in ${path}`);
        if (prop.kind !== "init" || prop.method) throw new Error(`methods/accessors not allowed in ${path}`);
        const key = propertyKey(prop.key as AnyNode, path);
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new Error(`reserved key name not allowed in ${path}: ${key}`);
        }
        out[key] = evaluateLiteral(prop.value as AnyNode, `${path}.${key}`);
      }
      return out;
    }
    case "ArrayExpression":
      return (node.elements as Array<AnyNode | null>).map((element, index) => {
        if (!element) throw new Error(`sparse arrays not allowed in ${path}`);
        if (element.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        return evaluateLiteral(element, `${path}[${index}]`);
      });
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length > 0) throw new Error(`template interpolation not allowed in ${path}`);
      return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
    case "UnaryExpression":
      if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
        return -node.argument.value;
      }
      throw new Error(`only negative-number unary allowed in ${path}`);
    default:
      throw new Error(`non-literal node type in ${path}: ${node.type}`);
  }
}

function propertyKey(node: AnyNode, path: string): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number"))
    return String(node.value);
  throw new Error(`unsupported key type in ${path}: ${node.type}`);
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  if (!meta || typeof meta !== "object") throw new Error("meta must be an object");
  const value = meta as WorkflowMeta;
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("meta.name must be a non-empty string");
  if (typeof value.description !== "string" || !value.description.trim())
    throw new Error("meta.description must be a non-empty string");
  if (value.whenToUse !== undefined && typeof value.whenToUse !== "string")
    throw new Error("meta.whenToUse must be a string");
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) throw new Error("meta.phases must be an array");
    for (const phase of value.phases) {
      if (!phase || typeof phase !== "object" || typeof (phase as WorkflowMetaPhase).title !== "string") {
        throw new Error("each meta phase must have a title string");
      }
    }
  }
}

function isModuleOnlySyntax(node: AnyNode): boolean {
  return node.type === "ImportDeclaration" || node.type.startsWith("Export");
}

function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const drain = () => {
    if (active >= limit) return;
    const start = queue.shift();
    if (!start) return;
    active++;
    start();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < limit) {
      active++;
    } else {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    try {
      return await fn();
    } finally {
      active--;
      drain();
    }
  };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, name);
}

function optionalThinkingLevel(value: unknown): WorkflowThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  throw new TypeError("agent thinkingLevel must be one of off, minimal, low, medium, high, xhigh");
}

function optionalModelRef(value: unknown): WorkflowModelRef | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("agent model must be a string or { provider, id } object");
  }
  const model = value as { provider?: unknown; id?: unknown };
  return {
    provider: optionalString(model.provider, "agent model provider"),
    id: optionalString(model.id, "agent model id"),
  };
}

function optionalIsolation(value: unknown): WorktreeIsolation | undefined {
  if (value === undefined) return undefined;
  if (value === "none" || value === "worktree") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("agent isolation must be 'none', 'worktree', or a worktree options object");
  }
  const isolation = value as Record<string, unknown>;
  if (isolation.mode !== "worktree") throw new TypeError("agent isolation mode must be 'worktree'");
  // Per-field type/shape checks for untrusted script input (friendly per-field errors).
  const normalized: Exclude<WorktreeIsolation, "none" | "worktree"> = { mode: "worktree" };
  const baseRef = optionalString(isolation.baseRef, "agent isolation baseRef");
  const rootDir = optionalString(isolation.rootDir, "agent isolation rootDir");
  const branch = optionalString(isolation.branch, "agent isolation branch");
  const keep = optionalKeep(isolation.keep);
  const dirty = optionalDirty(isolation.dirty);
  const merge = optionalMerge(isolation.merge);
  if (baseRef !== undefined) normalized.baseRef = baseRef;
  if (rootDir !== undefined) normalized.rootDir = rootDir;
  if (branch !== undefined) normalized.branch = branch;
  if (keep !== undefined) normalized.keep = keep;
  if (dirty !== undefined) normalized.dirty = dirty;
  if (merge !== undefined) normalized.merge = merge;
  // Delegate cross-field value semantics (e.g. dirty:'patch' requires baseRef:'HEAD')
  // to normalizeWorktreeIsolation, the single source of truth in worktree.ts, so the
  // runtime and the worktree manager can never disagree on what a valid isolation is.
  // The sparse object (not the fully-defaulted result) is returned to preserve round-trips.
  normalizeWorktreeIsolation(normalized);
  return normalized;
}

function optionalKeep(value: unknown): boolean | "onError" | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean" || value === "onError") return value;
  throw new TypeError("agent isolation keep must be a boolean or 'onError'");
}

function optionalDirty(value: unknown): "fail" | "ignore" | "patch" | undefined {
  if (value === undefined) return undefined;
  if (value === "fail" || value === "ignore" || value === "patch") return value;
  throw new TypeError("agent isolation dirty must be 'fail', 'ignore', or 'patch'");
}

function optionalMerge(value: unknown): "none" | undefined {
  if (value === undefined || value === "none") return value;
  throw new TypeError("agent isolation merge currently supports only 'none'");
}

function normalizeAgentOptions(value: unknown): AgentOptions {
  if (!value || typeof value !== "object") throw new TypeError("agent options must be an object");
  const options = value as AgentOptions;
  return {
    ...options,
    label: optionalString(options.label, "agent label"),
    phase: optionalString(options.phase, "agent phase"),
    model: optionalModelRef(options.model),
    job: optionalNonEmptyString(options.job, "agent job"),
    thinkingLevel: optionalThinkingLevel(options.thinkingLevel),
    isolation: optionalIsolation(options.isolation),
    agentType: optionalString(options.agentType, "agent type"),
  };
}

function optionalNonEmptyString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  const text = requireString(value, name);
  if (!text.trim()) throw new TypeError(`${name} must be a non-empty string`);
  return text;
}

function assertJsonSerializable(value: unknown, name: string): void {
  try {
    structuredClone(value);
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(
      `${name} must be JSON-serializable; did you forget to await agent(), parallel(), or pipeline()?${detail}`,
    );
  }

  try {
    if (JSON.stringify(value) === undefined) {
      throw new TypeError("JSON.stringify returned undefined");
    }
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(`${name} must be JSON-serializable; JSON.stringify failed.${detail}`);
  }
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

function buildAgentInstructions(phase: string | undefined, options: AgentOptions): string | undefined {
  const lines = [];
  if (phase) lines.push(`Workflow phase: ${phase}`);
  if (options.agentType) lines.push(`Act as workflow subagent type: ${options.agentType}`);
  return lines.length ? lines.join("\n") : undefined;
}

function serializeError(error: unknown): WorkflowSerializedError {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { name: "Error", message: String(error) };
}

function attachAgentError(
  metadata: WorkflowAgentRunMetadataWithError | undefined,
  error: WorkflowSerializedError,
  cwd: string | undefined,
): WorkflowAgentRunMetadataWithError {
  return {
    cwd: cwd ?? process.cwd(),
    ...metadata,
    error,
    activity: metadata?.activity ?? { kind: "error", text: error.message, updatedAt: Date.now() },
  };
}

class WorkflowConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowConfigurationError";
  }
}

function isWorkflowConfigurationError(error: unknown): error is WorkflowConfigurationError {
  return (
    error instanceof WorkflowConfigurationError ||
    (!!error && typeof error === "object" && (error as { name?: unknown }).name === "WorkflowConfigurationError")
  );
}

class WorkflowLabelConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowLabelConflictError";
  }
}

function isWorkflowLabelConflictError(error: unknown): error is WorkflowLabelConflictError {
  return (
    error instanceof WorkflowLabelConflictError ||
    (!!error && typeof error === "object" && (error as { name?: unknown }).name === "WorkflowLabelConflictError")
  );
}

class WorkflowInfrastructureError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "WorkflowInfrastructureError";
    this.cause = cause;
  }
}

function isWorkflowInfrastructureError(error: unknown): error is WorkflowInfrastructureError {
  return (
    error instanceof WorkflowInfrastructureError ||
    (!!error && typeof error === "object" && (error as { name?: unknown }).name === "WorkflowInfrastructureError")
  );
}

class WorkflowPauseSignal extends Error {
  readonly data?: unknown;
  readonly key?: string;

  constructor(message: string, data?: unknown, key?: string) {
    super(message);
    this.name = "WorkflowPauseSignal";
    this.data = data;
    this.key = key;
  }
}

function isWorkflowPauseSignal(error: unknown): error is WorkflowPauseSignal {
  return (
    error instanceof WorkflowPauseSignal ||
    (!!error && typeof error === "object" && (error as { name?: unknown }).name === "WorkflowPauseSignal")
  );
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError";
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val).sort()) {
        sorted[k] = val[k as keyof typeof val];
      }
      return sorted;
    }
    return val;
  });
}

function computeAgentFingerprint(
  prompt: string,
  phase: string | undefined,
  label: string,
  options: AgentOptions,
): string {
  const normalized = {
    prompt,
    phase,
    label,
    schema: options.schema,
    model: options.model,
    job: options.job,
    thinkingLevel: options.thinkingLevel,
    isolation: options.isolation,
    agentType: options.agentType,
  };
  return createHash("sha256").update(stableJsonStringify(normalized)).digest("hex");
}

function computePauseKey(payloadHash: string, occurrence: number): string {
  return `pause-${payloadHash}-${occurrence}`;
}
