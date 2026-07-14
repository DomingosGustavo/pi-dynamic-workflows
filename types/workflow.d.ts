/**
 * Ambient globals available inside pi-dynamic-workflows workflow scripts.
 *
 * Add this to a JavaScript or TypeScript workflow file for editor IntelliSense:
 *
 *   /// <reference types="pi-dynamic-workflows/workflow" />
 */

export {};

declare global {
  /** Literal workflow metadata. Must be the first statement: `export const meta = { ... }`. */
  interface WorkflowMeta {
    name: string;
    description: string;
    whenToUse?: string;
    /** Optional documentation for an expected outline. Live progress is driven by `phase(...)`. */
    phases?: WorkflowMetaPhase[];
  }

  interface WorkflowMetaPhase {
    title: string;
    detail?: string;
    model?: string;
  }

  /**
   * Options shared by every agent() call, regardless of whether the model is
   * chosen explicitly or routed from a job work type. The `model`/`job`
   * requirement is layered on top by {@link WorkflowAgentOptions}.
   */
  interface WorkflowAgentBaseOptions<TSchema = JsonSchema> {
    /** Short label shown in the live progress UI. */
    label?: string;
    /** Override the current runtime phase for this agent. */
    phase?: string;
    /** JSON Schema for structured output. When present, the subagent returns a validated object instead of text. TypeScript cannot infer its shape from the schema literal, so annotate the result or pass a generic: `await agent<Finding>(prompt, { schema })`. */
    schema?: TSchema;
    /** Requested thinking level for this subagent. */
    thinkingLevel?: WorkflowThinkingLevel;
    /** Requested isolation mode. Worktree isolation is opt-in and does not merge changes back. */
    isolation?: WorkflowWorktreeIsolation;
    /**
     * Free-text role hint for the subagent. This does not select a registered
     * agent implementation; it only appends a line to the subagent instructions
     * (`Act as workflow subagent type: <agentType>`). Use a normal descriptive
     * string such as "security reviewer".
     */
    agentType?: string;
  }

  /**
   * Every agent() call must specify either an explicit `model` or a `job` work
   * type; this union enforces that at least one is present at the type level.
   * When both are given, the explicit model wins for execution.
   *
   * Unless a custom model catalog is configured, `job` must be one of the
   * bundled work types: inspection, classification, research, summarization,
   * implementation, exploration, synthesis, planning, review, security-review,
   * judge, or architecture.
   */
  type WorkflowAgentOptions<TSchema = JsonSchema> = WorkflowAgentBaseOptions<TSchema> &
    (
      | {
          /** Requested Pi model for this subagent. Use provider/id when possible, for example `opencode-go/deepseek-v4-flash`. */
          model: WorkflowModelRef;
          /** Bundled work type used to route a model when one is not given explicitly. */
          job?: string;
        }
      | {
          /** Requested Pi model for this subagent. Use provider/id when possible, for example `opencode-go/deepseek-v4-flash`. */
          model?: WorkflowModelRef;
          /** Bundled work type used when model is omitted: inspection, classification, research, summarization, implementation, exploration, synthesis, planning, review, security-review, judge, or architecture. */
          job: string;
        }
    );

  type WorkflowModelRef =
    | string
    | {
        provider?: string;
        id?: string;
      };

  type WorkflowThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

  type WorkflowWorktreeIsolation =
    | "none"
    | "worktree"
    | {
        mode: "worktree";
        baseRef?: string;
        rootDir?: string;
        branch?: string;
        keep?: boolean | "onError";
        dirty?: "fail" | "ignore" | "patch";
        merge?: "none";
      };

  type JsonPrimitive = string | number | boolean | null;
  type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
  interface JsonObject {
    [key: string]: JsonValue;
  }

  interface JsonSchema {
    type?: string | string[];
    properties?: Record<string, JsonSchema>;
    items?: JsonSchema | JsonSchema[];
    required?: string[];
    additionalProperties?: boolean | JsonSchema;
    enum?: JsonValue[];
    const?: JsonValue;
    description?: string;
    [key: string]: unknown;
  }

  /**
   * Spawn a subagent.
   *
   * Without `schema`, resolves to the subagent's final text (`string`).
   * With `schema`, resolves to the validated structured object; because the
   * default type parameter is `string` and options are non-generic, the schema
   * gives no automatic inference — pass the expected result type explicitly:
   * `await agent<MyResult>(prompt, { schema })`.
   *
   * Options are required and must include either `model` or `job`.
   * A failed branch resolves to `null` (a structured error record is attached to
   * the agent's run metadata), so downstream reads must be null-safe.
   */
  function agent<T = string>(prompt: string, options: WorkflowAgentOptions): Promise<T | null>;

  /** Run independent async tasks concurrently. Pass functions, not already-created promises. */
  function parallel<T>(thunks: Array<() => Promise<T>>): Promise<T[]>;

  /** Run each item through sequential async stages while different items may run concurrently. */
  function pipeline<TItem, TResult = unknown>(
    items: TItem[],
    ...stages: Array<(previous: unknown, original: TItem, index: number) => TResult | Promise<TResult>>
  ): Promise<TResult[]>;

  /** Mark the current workflow phase for progress grouping. */
  function phase(title: string): void;

  /** Cooperatively pause. Resume replays the script and reuses completed uniquely-labeled agents. */
  function pause(reason?: string, data?: JsonValue): never;

  /** Append a workflow-level log line. */
  function log(message: unknown): void;

  /** Console shim routed to workflow logs (`log`, `info`, `warn`, `error`). */
  const console: {
    log(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };

  /** Optional JSON args passed to the workflow tool. Narrow with a local type assertion when needed. */
  const args: unknown;

  /** Current working directory for the workflow/subagents. */
  const cwd: string;

  /** Trusted workflow process shim exposing cwd(). */
  const process: { cwd(): string };
}
