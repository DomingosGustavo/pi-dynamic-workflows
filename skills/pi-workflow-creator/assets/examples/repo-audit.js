/**
 * repo-audit - inspect a repository across independent areas, then synthesize.
 *
 * Shape: fan-out barrier, because final prioritization needs all inspection
 * reports together.
 */

export const meta = {
  name: "repo_audit",
  description: "Audit a repository across architecture, tests, security, and maintainability",
  phases: [
    { title: "Inspect", detail: "one isolated agent per area" },
    { title: "Synthesize" },
  ],
};

const READ_ONLY_WORKTREE = { mode: "worktree", dirty: "ignore", merge: "none" };

const REPORT = {
  type: "object",
  required: ["area", "summary", "findings"],
  properties: {
    area: { type: "string" },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "priority", "files"],
        properties: {
          title: { type: "string" },
          priority: { type: "string", enum: ["low", "medium", "high"] },
          files: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

const areas = [
  {
    key: "architecture",
    prompt: "Inspect the repository architecture. Identify module boundaries, coupling, and simplification opportunities.",
  },
  {
    key: "tests",
    prompt: "Inspect test coverage and test ergonomics. Identify missing high-value coverage and flaky-risk areas.",
  },
  {
    key: "security",
    prompt: "Inspect security-sensitive code paths, input handling, secrets risk, and unsafe defaults.",
  },
  {
    key: "maintenance",
    prompt: "Inspect maintainability, naming, dead code risk, and developer experience issues.",
  },
];

phase("Inspect");
const reports = await parallel(
  areas.map((area) => () =>
    agent(`${area.prompt}\nReturn concrete file references when possible.`, {
      label: area.key,
      model: "opencode-go/deepseek-v4-flash",
      thinkingLevel: "medium",
      isolation: READ_ONLY_WORKTREE,
      schema: REPORT,
    }),
  ),
);

const clean = reports.filter(Boolean);

phase("Synthesize");
const synthesis = await agent(
  "Synthesize these repo audit reports into prioritized actions. Deduplicate overlapping findings, call out uncertainty, " +
    "and include concrete file references.\n\n" +
    JSON.stringify(clean, null, 2),
  {
    label: "audit synthesis",
    model: "opencode-go/kimi-k2.7-code",
    thinkingLevel: "high",
  },
);

return { reportCount: clean.length, reports: clean, synthesis };
