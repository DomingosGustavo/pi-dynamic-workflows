// Run each item through ordered stages. Items advance independently.
// Use this as the default shape for multi-stage work.

export const meta = {
  name: "todo_pipeline",
  description: "TODO: run each item through two workflow stages",
  phases: [{ title: "Stage 1" }, { title: "Stage 2" }],
};

const input =
  typeof args === "string"
    ? (() => {
        try {
          return JSON.parse(args);
        } catch {
          return args;
        }
      })()
    : args;
const items = Array.isArray(input) && input.length ? input : ["TODO item one", "TODO item two"];

const STAGE_1 = {
  type: "object",
  required: ["result"],
  properties: {
    result: { type: "string" },
  },
};

const output = await pipeline(
  items,
  (item, _original, index) =>
    agent(`TODO: first-stage instruction.\n\nItem:\n${item}`, {
      label: `stage1:${index + 1}`,
      phase: "Stage 1",
      model: "opencode-go/deepseek-v4-flash",
      // isolation: { mode: "worktree", dirty: "ignore", merge: "none" }, // read-only inspection
      schema: STAGE_1,
    }),
  (previous, item, index) =>
    agent(`TODO: second-stage instruction.\n\nItem:\n${item}\nStage 1 output (JSON):\n${JSON.stringify(previous ?? { result: "missing" }, null, 2)}`, {
      label: `stage2:${index + 1}`,
      phase: "Stage 2",
      model: "opencode-go/minimax-m3",
      thinkingLevel: "medium",
    }),
);

return { done: output.filter(Boolean) };
