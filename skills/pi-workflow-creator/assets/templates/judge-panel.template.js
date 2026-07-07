// Generate independent drafts, score them with independent judges, then synthesize.
// Use this when the solution space is broad or the stakes are high.

export const meta = {
  name: "todo_judge_panel",
  description: "TODO: draft from multiple angles, judge them, and synthesize the best answer",
  phases: [{ title: "Draft" }, { title: "Score" }, { title: "Synthesize" }],
};

const task =
  typeof args === "string" && args.trim()
    ? args
    : "TODO: describe the decision or plan the panel should evaluate";

const angles = ["mvp-first", "risk-first", "user-first"];

const SCORE = {
  type: "object",
  required: ["score", "strengths", "weaknesses"],
  properties: {
    score: { type: "number" },
    strengths: { type: "array", items: { type: "string" } },
    weaknesses: { type: "array", items: { type: "string" } },
  },
};

phase("Draft");
const drafts = await parallel(
  angles.map(
    (angle) => () =>
      agent(`Produce a ${angle} plan for this task:\n\n${task}`, {
        label: `draft:${angle}`,
        model: "opencode-go/minimax-m3",
        thinkingLevel: "medium",
      }),
  ),
);

phase("Score");
const judges = ["opencode-go/glm-5.2", "anthropic/claude-opus-4-8", "openai-codex/gpt-5.5"];
const scored = await parallel(
  drafts
    .map((draft, index) =>
      draft
        ? () =>
            agent(
              `Score this plan from 1-10 for feasibility, risk, and impact.\n\n${draft}`,
              {
                label: `judge:${angles[index]}`,
                model: judges[index % judges.length],
                thinkingLevel: "xhigh",
                schema: SCORE,
              },
            ).then((score) => (score ? { angle: angles[index], draft, ...score } : null))
        : null,
    )
    .filter(Boolean),
);

// SYNTHESIS CONTRACT: scored is an array of { angle, draft, score, strengths, weaknesses }.

phase("Synthesize");
const final = await agent(
  `Write the final plan. Start from the highest-scoring draft and graft useful ideas from runners-up.\n\n${JSON.stringify(
    scored.filter(Boolean).sort((a, b) => b.score - a.score),
    null,
    2,
  )}`,
  {
    label: "final-synthesis",
    model: "opencode-go/kimi-k2.7-code",
    thinkingLevel: "high",
  },
);

return { final, scored: scored.filter(Boolean) };
