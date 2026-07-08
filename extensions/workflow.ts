import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildDelegationPromptAppend,
  createSubagentTool,
  createWorkflowTool,
  DELEGATION_PROMPT_MARKER,
  pruneStale,
} from "../src/index.js";

const activeExtensions = new WeakSet<ExtensionAPI>();

export default function extension(pi: ExtensionAPI) {
  if (activeExtensions.has(pi)) return;
  activeExtensions.add(pi);

  const workflowTool = createWorkflowTool();
  const subagentTool = createSubagentTool();
  pi.registerTool(workflowTool);
  pi.registerTool(subagentTool);

  pi.on("session_start", () => {
    void pruneStale().catch(() => undefined);
    const active = pi.getActiveTools();
    const missing = [workflowTool.name, subagentTool.name].filter((name) => !active.includes(name));
    if (missing.length > 0) {
      pi.setActiveTools([...active, ...missing]);
    }
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
