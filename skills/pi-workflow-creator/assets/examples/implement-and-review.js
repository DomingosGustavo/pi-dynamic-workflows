/**
 * implement-and-review - implement a task, then loop review/fix until it passes.
 *
 * Shape: bounded loop. The hard round cap prevents unbounded agent calls.
 */

export const meta = {
  name: "implement_and_review",
  description: "Implement a task, then review and fix until the review passes or the round cap is hit",
  phases: [{ title: "Implement" }, { title: "Review" }, { title: "Fix" }],
};

const REVIEW = {
  type: "object",
  required: ["passed", "issues"],
  properties: {
    passed: { type: "boolean" },
    issues: { type: "array", items: { type: "string" } },
  },
};

const task = (() => {
  if (typeof args !== "string" || !args.trim()) return "the feature described by the user";
  try {
    const parsed = JSON.parse(args);
    return typeof parsed === "string" ? parsed : args;
  } catch {
    return args;
  }
})();

const MAX_ROUNDS = 3;

phase("Implement");
await agent(`Implement this task in the repository. Run focused tests when possible.\n\n${task}`, {
  label: "implement",
  model: "opencode-go/kimi-k2.7-code",
  thinkingLevel: "high",
});

let review = { passed: false, issues: ["review has not run"] };
let round = 0;

while (!review.passed && round < MAX_ROUNDS) {
  round += 1;

  phase("Review");
  review = await agent(`Review the current changes for this task:\n\n${task}`, {
    label: `review:${round}`,
    model: round === MAX_ROUNDS ? "anthropic/claude-opus-4-8" : "opencode-go/glm-5.2",
    thinkingLevel: "xhigh",
    schema: REVIEW,
  });

  if (review?.passed) {
    log(`Review passed on round ${round}`);
    break;
  }

  phase("Fix");
  await agent(`Fix these review issues, then run focused tests:\n\n${(review?.issues ?? []).join("\n")}`, {
    label: `fix:${round}`,
    model: "opencode-go/kimi-k2.7-code",
    thinkingLevel: "high",
  });
}

return {
  passed: Boolean(review?.passed),
  rounds: round,
  remainingIssues: review?.passed ? [] : (review?.issues ?? []),
};
