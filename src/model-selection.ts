import { readFileSync } from "node:fs";
import type { Model } from "@earendil-works/pi-ai";
import type { WorkflowThinkingLevel } from "./options.js";

export interface WorkflowModelCandidate {
  model: string;
  thinkingLevel?: WorkflowThinkingLevel;
}

export interface WorkflowModelCatalog {
  version: 2;
  work: Record<string, WorkflowModelCandidate[]>;
}

export interface SelectableWorkflowModel {
  provider: string;
  id: string;
}

export interface WorkflowModelSelection {
  model: string;
  thinkingLevel?: WorkflowThinkingLevel;
  job: string;
  considered: string[];
  reason: string;
}

const THINKING_LEVELS = new Set<WorkflowThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);
const MODEL_REF = /^[^/\s]+\/[^/\s]+$/;

/** Bundled, curated default. Pass a different parsed JSON catalog to override it. */
export const DEFAULT_WORKFLOW_MODEL_CATALOG = parseWorkflowModelCatalog(
  JSON.parse(readFileSync(new URL("../model-selection.json", import.meta.url), "utf8")),
);

export function parseWorkflowModelCatalog(value: unknown): WorkflowModelCatalog {
  if (!isPlainObject(value)) throw new TypeError("model catalog must be a plain object");
  if (value.version !== 2) throw new TypeError(`unsupported model catalog version ${String(value.version)}`);
  if (Object.keys(value).some((key) => key !== "$schema" && key !== "version" && key !== "work")) {
    throw new TypeError("model catalog contains unknown properties");
  }
  if (!isPlainObject(value.work)) throw new TypeError("model catalog work must be a plain object");
  const entries = Object.entries(value.work);
  if (entries.length === 0) throw new TypeError("model catalog work must contain at least one work type");
  for (const [job, candidates] of entries) {
    if (!job.trim()) throw new TypeError("model catalog work type names must be non-empty strings");
    validateCandidates(candidates, `work type "${job}"`);
  }
  return value as unknown as WorkflowModelCatalog;
}

export function workflowJobTypes(catalog: WorkflowModelCatalog): string[] {
  const parsed = parseWorkflowModelCatalog(catalog);
  return Object.keys(parsed.work).sort();
}

export function selectWorkflowModel(
  catalogValue: WorkflowModelCatalog | unknown,
  jobType: string,
  availableModels: readonly SelectableWorkflowModel[],
): WorkflowModelSelection {
  const catalog = parseWorkflowModelCatalog(catalogValue);
  if (typeof jobType !== "string" || !jobType.trim()) {
    throw new TypeError("workflow job type must be a non-empty string");
  }
  if (!Object.hasOwn(catalog.work, jobType)) {
    throw new Error(`Unknown workflow job type "${jobType}". Known types: ${workflowJobTypes(catalog).join(", ")}`);
  }
  const candidates = catalog.work[jobType];
  const available = new Set(availableModels.map(modelRef));
  const considered: string[] = [];
  for (const candidate of candidates) {
    considered.push(candidate.model);
    if (available.has(candidate.model)) {
      return {
        model: candidate.model,
        thinkingLevel: candidate.thinkingLevel,
        job: jobType,
        considered,
        reason: `job ${jobType}; first available candidate`,
      };
    }
  }
  throw new Error(
    `No enabled model is available for workflow job type "${jobType}" (considered: ${considered.join(", ")})`,
  );
}

export function modelRef(model: Pick<Model<any>, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateCandidates(value: unknown, name: string): asserts value is WorkflowModelCandidate[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${name} must contain at least one candidate`);
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!isPlainObject(candidate)) throw new TypeError(`${name} candidates must be plain objects`);
    const keys = Object.keys(candidate);
    if (keys.some((key) => key !== "model" && key !== "thinkingLevel")) {
      throw new TypeError(`${name} candidate contains unknown properties`);
    }
    if (typeof candidate.model !== "string" || !MODEL_REF.test(candidate.model)) {
      throw new TypeError(`${name} candidate model must be a provider/id string`);
    }
    if (seen.has(candidate.model)) throw new TypeError(`${name} contains duplicate model "${candidate.model}"`);
    seen.add(candidate.model);
    if (
      candidate.thinkingLevel !== undefined &&
      !THINKING_LEVELS.has(candidate.thinkingLevel as WorkflowThinkingLevel)
    ) {
      throw new TypeError(`${name} has an invalid thinkingLevel`);
    }
  }
}
