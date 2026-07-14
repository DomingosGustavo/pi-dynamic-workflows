import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildDelegationPromptAppend,
  createSubagentTool,
  createWorkflowTool,
  DELEGATION_PROMPT_MARKER,
  isWorkflowStateEvent,
  type PersistedWorkflowState,
  pruneStale,
  reduceWorkflowStateEvents,
  WORKFLOW_SESSION_ENTRY_TYPE,
  type WorkflowStateEvent,
  type WorkflowStateStore,
} from "../src/index.js";

const activeExtensions = new WeakSet<ExtensionAPI>();

export default function extension(pi: ExtensionAPI) {
  if (activeExtensions.has(pi)) return;
  activeExtensions.add(pi);

  let stateEvents: WorkflowStateEvent[] = [];
  let states = new Map<string, PersistedWorkflowState>();
  const stateStore: WorkflowStateStore = {
    append(event) {
      pi.appendEntry(WORKFLOW_SESSION_ENTRY_TYPE, event);
      stateEvents.push(event);
      states = reduceWorkflowStateEvents(stateEvents);
    },
    get(workflowId) {
      return states.get(workflowId);
    },
    list() {
      return [...states.values()];
    },
  };

  const restoreWorkflowStates = (entries: Array<any>) => {
    stateEvents = entries
      .filter((entry) => entry.type === "custom" && entry.customType === WORKFLOW_SESSION_ENTRY_TYPE)
      .map((entry) => entry.data)
      .filter(isWorkflowStateEvent);
    states = reduceWorkflowStateEvents(stateEvents);
  };

  const workflowTool = createWorkflowTool({ stateStore });
  const subagentTool = createSubagentTool();
  pi.registerTool(workflowTool);
  pi.registerTool(subagentTool);

  pi.on("session_start", (_event, ctx) => {
    restoreWorkflowStates(ctx.sessionManager.getBranch());
    void pruneStale().catch(() => undefined);
    const active = pi.getActiveTools();
    const missing = [workflowTool.name, subagentTool.name].filter((name) => !active.includes(name));
    if (missing.length > 0) {
      pi.setActiveTools([...active, ...missing]);
    }
  });

  pi.on("session_tree", (_event, ctx) => {
    restoreWorkflowStates(ctx.sessionManager.getBranch());
  });

  pi.on("before_agent_start", (event) => {
    if (event.systemPrompt.includes(DELEGATION_PROMPT_MARKER)) return;
    const active = pi.getActiveTools();
    const append = buildDelegationPromptAppend({
      subagent: active.includes(subagentTool.name),
      workflow: active.includes(workflowTool.name),
    });
    if (!append) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${append}` };
  });
}
