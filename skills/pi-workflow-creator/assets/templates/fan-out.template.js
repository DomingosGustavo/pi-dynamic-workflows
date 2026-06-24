// Fan out over a known list, then synthesize from all results.
// Use this when the final step genuinely needs the complete result set.

export const meta = {
  name: "todo_fanout",
  description: "TODO: process independent items in parallel, then synthesize",
  phases: [{ title: "Work" }, { title: "Synthesize" }],
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

const ITEM_RESULT = {
  type: "object",
  required: ["summary"],
  properties: {
    summary: { type: "string" },
    points: { type: "array", items: { type: "string" } },
  },
};

phase("Work");
const results = await parallel(
  items.map((item, index) => () =>
    agent(`TODO: complete this task for one item.\n\nItem:\n${item}`, {
      label: `item:${index + 1}`,
      model: "opencode-go/deepseek-v4-flash",
      thinkingLevel: "low",
      schema: ITEM_RESULT,
    }),
  ),
);

const clean = results.map((result, index) => (result ? { item: items[index], ...result } : null)).filter(Boolean);

phase("Synthesize");
const report = await agent("TODO: combine these item results into one deliverable.\n\n" + JSON.stringify(clean, null, 2), {
  label: "synthesis",
  model: "opencode-go/kimi-k2.7-code",
  thinkingLevel: "medium",
});

return { count: clean.length, report };
