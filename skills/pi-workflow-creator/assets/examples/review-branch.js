/**
 * review-branch - review changed files, then adversarially verify each finding.
 *
 * Shape: pipeline. Findings from one dimension can verify while other
 * dimensions are still reviewing.
 */

export const meta = {
  name: "review_branch",
  description: "Review the branch across dimensions and verify each finding",
  whenToUse: "Before opening or merging a pull request",
  phases: [
    { title: "Review", detail: "one reviewer per dimension" },
    { title: "Verify", detail: "try to refute each finding", model: "opencode-go/glm-5.2" },
  ],
};

const READ_ONLY_WORKTREE = { mode: "worktree", dirty: "ignore", merge: "none" };

const FINDINGS = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "file", "severity"],
        properties: {
          title: { type: "string" },
          file: { type: "string" },
          line: { type: "number" },
          severity: { type: "string", enum: ["low", "medium", "high"] },
        },
      },
    },
  },
};

const VERDICT = {
  type: "object",
  required: ["isReal", "reason"],
  properties: {
    isReal: { type: "boolean" },
    reason: { type: "string" },
  },
};

const dimensions = [
  { key: "bugs", prompt: "Find logic bugs in the files changed on this branch." },
  { key: "security", prompt: "Find security or hardening issues in the changed files." },
  { key: "tests", prompt: "Find missing, weak, or misleading tests in the changes." },
];

const results = await pipeline(
  dimensions,
  (dimension) =>
    agent(`${dimension.prompt} Include file and line references where possible.`, {
      label: `review:${dimension.key}`,
      phase: "Review",
      model: "opencode-go/deepseek-v4-flash",
      thinkingLevel: "medium",
      isolation: READ_ONLY_WORKTREE,
      schema: FINDINGS,
    }),
  (review, dimension) =>
    parallel(
      (review?.findings ?? []).map((finding) => () =>
        agent(
          "Adversarially verify this finding. Try hard to refute it. If uncertain, mark it not real.\n\n" +
            JSON.stringify(finding, null, 2),
          {
            label: `verify:${dimension.key}`,
            phase: "Verify",
            model: "opencode-go/glm-5.2",
            thinkingLevel: "xhigh",
            isolation: READ_ONLY_WORKTREE,
            schema: VERDICT,
          },
        ).then((verdict) => ({ ...finding, dimension: dimension.key, verdict })),
      ),
    ),
);

const confirmed = results.flat().filter(Boolean).filter((finding) => finding.verdict?.isReal);
return { confirmedCount: confirmed.length, confirmed };
