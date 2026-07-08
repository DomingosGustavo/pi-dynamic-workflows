import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";

export interface StructuredOutputCapture<T = unknown> {
  value: T | undefined;
  called: boolean;
  /** Soft warnings recorded while capturing (e.g. repeated structured_output calls). */
  warnings?: string[];
  /** Number of times execute() was invoked, including ignored duplicates. */
  callCount?: number;
  /** Number of structured_output tool calls the model attempted, including schema-invalid ones. */
  attempts?: number;
  /** Message from the most recent schema-invalid (rejected) structured_output attempt. */
  lastError?: string;
}

export interface StructuredOutputToolOptions<TSchemaDef extends TSchema> {
  schema: TSchemaDef;
  capture: StructuredOutputCapture<Static<TSchemaDef>>;
  name?: string;
}

/**
 * Create a terminating tool that captures validated params as the subagent result.
 *
 * Pi validates `params` against `schema` before execute() is called. Returning
 * `terminate: true` lets the subagent finish on this tool call without paying for
 * an extra assistant follow-up turn.
 */
export function createStructuredOutputTool<TSchemaDef extends TSchema>({
  schema,
  capture,
  name = "structured_output",
}: StructuredOutputToolOptions<TSchemaDef>): ToolDefinition<TSchemaDef, Static<TSchemaDef>> {
  return defineTool({
    name,
    label: "Structured Output",
    description: "Return the final machine-readable result for this subagent task.",
    promptSnippet: "Return final machine-readable output",
    promptGuidelines: [
      `${name} is the final answer channel for this task; call ${name} exactly once when done.`,
      `Do not write a prose final answer after calling ${name}.`,
    ],
    parameters: schema,
    async execute(_toolCallId, params) {
      capture.callCount = (capture.callCount ?? 0) + 1;
      if (capture.called) {
        // First result is authoritative; ignore later calls but record a soft warning.
        const warning = `${name} called ${capture.callCount} times; keeping the first result and ignoring later call(s).`;
        capture.warnings ??= [];
        capture.warnings.push(warning);
        return {
          content: [
            {
              type: "text",
              text: `Structured output already received; ignoring this repeated ${name} call.`,
            },
          ],
          details: capture.value,
          terminate: true,
        };
      }
      capture.value = params;
      capture.called = true;
      return {
        content: [{ type: "text", text: "Structured output received." }],
        details: params,
        terminate: true,
      };
    },
  });
}
