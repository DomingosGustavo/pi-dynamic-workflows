# Workflow Patterns

Pick the smallest topology that matches the job. Copy the closest shape, then
replace prompts, schemas, labels, and model choices.

## 1. Fan Out Then Synthesize

Use when the units are independent, one pass each, and the synthesis genuinely
needs every result.

```js
export const meta = {
  name: "research_fanout",
  description: "Research independent questions in parallel, then synthesize",
  phases: [{ title: "Research" }, { title: "Synthesize" }],
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
const questions = Array.isArray(input) && input.length ? input : ["demo question"];

const RESEARCH = {
  type: "object",
  required: ["summary", "sources"],
  properties: {
    summary: { type: "string" },
    sources: { type: "array", items: { type: "string" } },
  },
};

phase("Research");
const findings = await parallel(
  questions.map((question, index) => () =>
    agent(`Research verified facts for this question:\n\n${question}`, {
      label: `research:${index + 1}`,
      model: "opencode-go/deepseek-v4-flash",
      thinkingLevel: "low",
      schema: RESEARCH,
    }),
  ),
);

const clean = findings
  .map((finding, index) => (finding ? { question: questions[index], ...finding } : null))
  .filter(Boolean);

phase("Synthesize");
const report = await agent(
  "Combine the research into one concise briefing. Call out disagreements.\n\n" + JSON.stringify(clean, null, 2),
  {
    label: "synthesis",
    model: "opencode-go/kimi-k2.7-code",
    thinkingLevel: "medium",
  },
);

return { questionCount: clean.length, report };
```

### Synthesis contract

The synthesis agent receives a JSON array of structured objects. Each object
should include at least `{ label, summary, findings }` so the synthesizer knows
the source. It must return prioritized/deduped items, uncertainty call-outs, and
concrete file references.

Recommended prompt template:

```text
Synthesize these N reports into a prioritized action list. Deduplicate
overlapping items, flag disagreements between sources, and include file
references.
```

For high-stakes synthesis, use two independent judges (one
`opencode-go/glm-5.2` reasoning judge, and one frontier judge such as
`anthropic/claude-opus-4-8` or `openai-codex/gpt-5.5`) plus a reconciling agent.

## 2. Pipeline: Review Then Verify

Use when each item should advance to the next stage as soon as it is ready. This
is the default multi-stage shape.

```js
export const meta = {
  name: "review_and_verify",
  description: "Review each dimension, then verify findings without a global barrier",
  phases: [{ title: "Review" }, { title: "Verify" }],
};

const FINDINGS = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "file"],
        properties: {
          title: { type: "string" },
          file: { type: "string" },
          severity: { type: "string" },
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

const READ_ONLY_WORKTREE = { mode: "worktree", dirty: "ignore", merge: "none" };
const dimensions = [
  { key: "bugs", prompt: "Find logic bugs in the changed files." },
  { key: "security", prompt: "Find security or hardening issues in the changed files." },
  { key: "tests", prompt: "Find missing or weak test coverage in the changes." },
];

const results = await pipeline(
  dimensions,
  (dimension) =>
    agent(dimension.prompt, {
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
        agent(`Try to refute this finding:\n\n${JSON.stringify(finding, null, 2)}`, {
          label: `verify:${dimension.key}`,
          phase: "Verify",
          model: "opencode-go/glm-5.2",
          thinkingLevel: "xhigh",
          isolation: READ_ONLY_WORKTREE,
          schema: VERDICT,
        }).then((verdict) => ({ ...finding, dimension: dimension.key, verdict })),
      ),
    ),
);

const confirmed = results.flat().filter(Boolean).filter((finding) => finding.verdict?.isReal);
return { confirmedCount: confirmed.length, confirmed };
```

## 3. Barrier For Dedup Or Merge

Use when a downstream step must see the entire previous result set before it can
continue.

```js
phase("Review");
const batches = await parallel(
  dimensions.map((dimension) => () =>
    agent(dimension.prompt, {
      label: `review:${dimension.key}`,
      model: "opencode-go/deepseek-v4-flash",
      schema: FINDINGS,
    }),
  ),
);

const allFindings = batches.filter(Boolean).flatMap((batch) => batch.findings ?? []);
const deduped = [];
const seen = new Set();
for (const finding of allFindings) {
  const key = `${finding.file}:${finding.title}`;
  if (!seen.has(key)) {
    seen.add(key);
    deduped.push(finding);
  }
}

if (deduped.length === 0) return { confirmed: [], note: "No findings to verify." };

phase("Verify");
const verified = await parallel(
  deduped.map((finding) => () =>
    agent(`Verify this deduped finding:\n${JSON.stringify(finding)}`, {
      label: `verify:${finding.file}`,
      model: "opencode-go/glm-5.2",
      thinkingLevel: "xhigh",
      schema: VERDICT,
    }).then((verdict) => ({ ...finding, verdict })),
  ),
);

return { confirmed: verified.filter(Boolean).filter((finding) => finding.verdict?.isReal) };
```

## 4. Loop Until A Target Count

Use for bounded discovery: "find 10 issues" or "collect 5 proposals".

```js
const ISSUE_BATCH = {
  type: "object",
  required: ["issues"],
  properties: {
    issues: { type: "array", items: { type: "string" } },
  },
};

phase("Discover");
const issues = [];
while (issues.length < 10) {
  const result = await agent(
    "Find issues not already listed below.\n\n" + JSON.stringify(issues),
    {
      label: `discover:${issues.length + 1}`,
      model: "opencode-go/deepseek-v4-flash",
      schema: ISSUE_BATCH,
    },
  );
  issues.push(...(result?.issues ?? []));
  log(`${issues.length}/10 issues found`);
}

return { issues: issues.slice(0, 10) };
```

## 5. Bounded-Rounds + Dry-Streak Loop

Use for discovery loops. Keep hard stops by item count, round cap, and dry
streak so the loop terminates even if each round returns results.

```js
const found = [];
let rounds = 0;
let dryStreak = 0;
while (found.length < 25 && rounds < 8 && dryStreak < 2) {
  rounds += 1;
  const before = found.length;
  const result = await agent("Find one more high-signal issue not already listed.", {
    label: `round:${rounds}`,
    model: "opencode-go/deepseek-v4-flash",
    schema: ISSUE_BATCH,
  });
  found.push(...(result?.issues ?? []));
  dryStreak = found.length === before ? dryStreak + 1 : 0;
  log(`${found.length} found; ${dryStreak} dry round(s)`);
}

return { rounds, found };
```

### Choosing bounds

Set conservative hard stops: discovery loops run at most ~8 rounds or collect
~25 items; implement-review-fix loops run at most 3 rounds. Add a dry-streak
break when consecutive rounds add nothing, and reserve capacity for final
synthesis.

## 6. Judge Panel

Use when the solution space is broad or high stakes. Generate independent
answers, score them with independent judges, then synthesize.

```js
const SCORE = {
  type: "object",
  required: ["score", "why"],
  properties: {
    score: { type: "number" },
    why: { type: "string" },
  },
};

const task = typeof args === "string" && args.trim() ? args : "the user's requested plan";
const angles = ["mvp-first", "risk-first", "user-first", "cost-first"];

phase("Draft");
const drafts = await parallel(
  angles.map((angle) => () =>
    agent(`Produce a ${angle} plan for this task:\n\n${task}`, {
      label: `draft:${angle}`,
      model: angle === "risk-first" ? "opencode-go/glm-5.2" : "opencode-go/minimax-m3",
      thinkingLevel: angle === "risk-first" ? "xhigh" : "medium",
    }),
  ),
);

phase("Judge");
const judges = ["opencode-go/glm-5.2", "anthropic/claude-opus-4-8", "openai-codex/gpt-5.5"];
const scored = await parallel(
  drafts.filter(Boolean).map((draft, index) => () =>
    agent(`Score this plan from 1-10 for feasibility, risk, and impact.\n\n${draft}`, {
      label: `judge:${index + 1}`,
      model: judges[index % judges.length],
      thinkingLevel: "xhigh",
      schema: SCORE,
    }).then((score) => ({ draft, ...score })),
  ),
);

const ranked = scored.filter(Boolean).sort((a, b) => b.score - a.score);

phase("Synthesize");
const final = await agent(
  "Write the final plan. Start from the winner and graft useful ideas from runners-up.\n\n" +
    JSON.stringify(ranked, null, 2),
  {
    label: "final synthesis",
    model: "opencode-go/kimi-k2.7-code",
    thinkingLevel: "high",
  },
);

return { final, ranked };
```

Use the enabled GPT 5.5 provider/id in the local registry if it differs from
`openai-codex/gpt-5.5`.

## 7. Defensive null handling

Failed branches return `null`. Defensive reads keep a workflow from crashing
mid-run.

Use `previous?.field ?? fallback` in every pipeline stage that reads a previous
result:

```js
(review?.findings ?? []).forEach((finding) => { ... });
```

`results.filter(Boolean)` is necessary but not sufficient. Also log which
branches failed so you can retry or report gaps:

```js
results.forEach((r, i) => {
  if (!r) log(`branch ${labels[i]} returned null`);
});
```

Provide fallback defaults:

```js
const items = result?.items ?? [];
```

Report known-failed branches in the synthesis prompt so the final output
acknowledges gaps rather than silently omitting them.
