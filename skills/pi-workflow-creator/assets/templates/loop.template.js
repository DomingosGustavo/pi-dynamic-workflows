// Keep spawning agents until a goal is met. Always include a hard stop.

export const meta = {
  name: "todo_loop",
  description: "TODO: collect results until a bounded stop condition is met",
  phases: [{ title: "Collect" }],
};

const RESULT_BATCH = {
  type: "object",
  required: ["items"],
  properties: {
    items: { type: "array", items: { type: "string" } },
  },
};

phase("Collect");
const collected = [];
let rounds = 0;
const maxRounds = 8;

while (collected.length < 25 && rounds < maxRounds) {
  rounds += 1;
  const result = await agent("TODO: find more items not already listed.\n\n" + JSON.stringify(collected), {
    label: `collect:${rounds}`,
    model: "opencode-go/deepseek-v4-flash",
    thinkingLevel: "medium",
    schema: RESULT_BATCH,
  });

  collected.push(...(result?.items ?? []));
  log(`${collected.length} collected after ${rounds} round(s)`);
}

return { rounds, collected };
