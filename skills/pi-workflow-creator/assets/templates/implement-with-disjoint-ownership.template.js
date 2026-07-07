// Parallel mutating agents with partitioned file ownership.
//
// Rule: never assign the same file to two agents in the same parallel batch.
// Each partition owns a disjoint set of files, so agents cannot conflict.
// Merge-back is manual by design: each agent writes to its own worktree and
// reports what it changed; the synthesizer produces the merged report.

export const meta = {
  name: "todo_disjoint_implement",
  description: "TODO: implement disjoint file partitions in parallel and merge reports",
  phases: [{ title: "Implement" }, { title: "Report" }],
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
const task = typeof input === "string" && input.trim() ? input : "TODO: describe the overall task";

const partitions = [
  {
    label: "partition-a",
    files: ["src/a/TODO.js", "src/a/TODO.test.js"],
    task: "TODO: implement the A-side changes",
  },
  {
    label: "partition-b",
    files: ["src/b/TODO.js", "src/b/TODO.test.js"],
    task: "TODO: implement the B-side changes",
  },
];

const PARTITION_RESULT = {
  type: "object",
  required: ["filesChanged", "summary"],
  properties: {
    filesChanged: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    blockers: { type: "array", items: { type: "string" } },
  },
};

phase("Implement");
const results = await parallel(
  partitions.map(
    (p) => () =>
      agent(
        `Implement this part of the overall task.\n\n` +
          `Only modify these files:\n${p.files.join("\n")}\n\n` +
          `Do not touch any other file.\n\n${p.task}\n\nOverall context: ${task}`,
        {
          label: `implement:${p.label}`,
          model: "opencode-go/kimi-k2.7-code",
          thinkingLevel: "high",
          schema: PARTITION_RESULT,
          isolation: { mode: "worktree", dirty: "patch", merge: "none", keep: "onError" },
        },
      ),
  ),
);

for (const [index, result] of results.entries()) {
  if (!result) log(`partition ${partitions[index].label} returned no result`);
}

const clean = results
  .map((result, index) => (result ? { label: partitions[index].label, ...result } : null))
  .filter(Boolean);

phase("Report");
const report = await agent(
  `Merge these parallel implementation reports into one coherent summary.\n\n` +
    `Note any partitions that failed or reported blockers.\n\n${JSON.stringify(clean, null, 2)}`,
  {
    label: "merge-report",
    model: "opencode-go/kimi-k2.7-code",
    thinkingLevel: "medium",
  },
);

return { partitions: clean.length, failed: partitions.length - clean.length, report };
