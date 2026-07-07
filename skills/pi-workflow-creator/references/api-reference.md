# Pi Dynamic Workflows Reference

Use this reference when authoring or debugging workflow scripts for the
`pi-dynamic-workflows` extension. It describes the contract implemented by this
package, not another workflow runtime.

## Contents

1. Workflow fit
2. Tool input and review artifacts
3. File anatomy
4. Runtime globals
5. `agent()` options
6. `parallel()` and `pipeline()`
7. `args`, `cwd`, and `budget`
8. Trust, isolation, and practical limits

## 1. Workflow fit

A workflow is a JavaScript orchestration script that fans work out to fresh Pi
subagents, then combines their results. JavaScript controls the shape: loops,
conditionals, barriers, and stage ordering. Model calls happen only at
`agent()` leaves.

Use a workflow when the task is decomposable and the decomposition should be
explicit:

- repository audits with independent inspection areas;
- multi-perspective code review and adversarial verification;
- research over many independent questions;
- implementation followed by review/fix loops;
- judge panels where multiple independent attempts are scored before synthesis.

Skip a workflow for quick reads, single-file edits, one subagent, or exploratory
tasks where the parent model should freely decide the next step after every
tool result.

## 2. Tool Input And Review Artifacts

The Pi tool accepts an object with:

| Field | Type | Meaning |
| --- | --- | --- |
| `script` | string | Required raw JavaScript. Do not wrap in Markdown fences. |
| `args` | any | Optional value exposed as global `args` in the script. |

Interactive sessions write the script to a review file before execution:

```text
.pi/workflows/<timestamp>-<workflow-name>.workflow.js
```

The user approves the generated workflow before subagents start. Test harnesses
and trusted automation can construct the tool with `approvalMode: "auto"`, but
normal parent models should assume interactive approval.

This package does not run saved workflow names directly through the tool input.
The parent model should generate one complete `script` string.

## 3. File Anatomy

The first statement must be a literal metadata export:

```js
export const meta = {
  name: "repo_audit",
  description: "Audit the repository across security, tests, and maintainability",
  whenToUse: "Before shipping a large branch",
  phases: [
    { title: "Inspect", detail: "one agent per area" },
    { title: "Synthesize" },
  ],
};
```

Rules:

- `meta.name` and `meta.description` are required non-empty strings.
- `meta.whenToUse` is optional.
- `meta.phases` is optional documentation for the expected outline.
- Runtime progress is driven by `phase(title)` calls, not by `meta.phases`.
- `meta` must be a pure literal: no variables, function calls, computed keys,
  spreads, or interpolated template strings.
- Everything after `meta` is async JavaScript, so top-level `await` and
  `return` are allowed.

## 4. Runtime Globals

| Global | Purpose |
| --- | --- |
| `agent(prompt, opts?)` | Run one fresh-context Pi subagent. |
| `parallel(thunks)` | Run an array of `() => Promise` tasks concurrently, then wait for all. |
| `pipeline(items, ...stages)` | Run each item through ordered stages while different items overlap. |
| `phase(title)` | Mark the current progress group. |
| `log(message)` | Add a workflow-level log line. |
| `args` | Optional value passed through from tool input. |
| `cwd` | Current working directory for the workflow. |
| `process.cwd()` | Safe cwd shim. |
| `budget` | `{ total, spent(), remaining() }` token budget helper. |
| `console` | Routed to workflow logs. |

The orchestrator should coordinate. Put repository reads, shell commands, file
edits, network checks, and tests inside subagent prompts.

### Prompt design for fresh-context agents

Each subagent starts with an empty conversation, so prompts must inline every
piece of context the agent needs: file paths, code snippets, prior findings, and
the task itself. Do not rely on earlier turns, tool output, or a cached file
view from the parent orchestrator.

Wrong:

```js
agent("Review the code above for race conditions.", { label: "review" });
```

Right:

```js
agent(
  "Review this function for race conditions.\n\n" +
    "File: src/queue.js\n" +
    "Code:\n```js\n...\n```\n" +
    "Known concern: enqueue and dequeue both mutate `tail` without locking.",
  { label: "review" },
);
```

## 5. `agent()` Options

```js
const result = await agent("Inspect src/auth for security issues.", {
  label: "auth security",
  phase: "Inspect",
  model: "opencode-go/deepseek-v4-flash",
  thinkingLevel: "medium",
  isolation: { mode: "worktree", dirty: "ignore", merge: "none" },
  schema: {
    type: "object",
    required: ["findings"],
    properties: {
      findings: { type: "array", items: { type: "string" } },
    },
  },
});
```

| Option | Type | Guidance |
| --- | --- | --- |
| `label` | string | Use a unique 2-5 word label for readable progress. |
| `phase` | string | Assign an agent to a progress group, especially inside concurrent callbacks. |
| `schema` | JSON Schema | Use whenever JavaScript reads fields from the result. |
| `model` | string or `{ provider, id }` | Prefer exact provider/id refs. See `model-selection.md`. |
| `thinkingLevel` | string | One of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. |
| `isolation` | string or object | Use worktree isolation for project inspection or parallel mutation. |
| `agentType` | string | Request a registered subagent role/type when available. |

Without `schema`, `agent()` returns the subagent final text as a string. With
`schema`, it returns the validated object directly. If an agent fails, the
runtime logs the failure and returns `null` for that branch.

## 6. `parallel()` And `pipeline()`

`parallel()` expects thunks:

```js
const reports = await parallel(
  areas.map((area) => () =>
    agent(`Inspect ${area.path}`, {
      label: area.label,
      phase: "Inspect",
    }),
  ),
);
```

Do not pass already-created promises:

```js
// Wrong: agent() starts immediately and parallel() receives promises.
await parallel(areas.map((area) => agent(`Inspect ${area.path}`)));
```

Use `parallel()` as a barrier only when the next step needs all results at once:
synthesis, deduplication, ranking, scoring, or early exit on total count.

`pipeline()` is the default for multi-stage item work:

```js
const verified = await pipeline(
  dimensions,
  (dimension) =>
    agent(dimension.prompt, {
      label: `review:${dimension.key}`,
      phase: "Review",
      schema: FINDINGS,
    }),
  (review, dimension) =>
    parallel(
      (review?.findings ?? []).map((finding) => () =>
        agent(`Try to refute this finding:\n${JSON.stringify(finding)}`, {
          label: `verify:${dimension.key}`,
          phase: "Verify",
          schema: VERDICT,
        }),
      ),
    ),
);
```

Each stage receives `(previousValue, originalItem, index)`. If one stage throws,
that item becomes `null` and later stages for that item are skipped.

### Structured hand-off contracts

Treat data passed between workflow stages as a small contract:

(a) each hand-off JSON should carry exactly the fields the downstream agent needs;
(b) always use `schema` on producing agents so consumers get named fields instead
    of free text;
(c) use null-safe reads on every hand-off (`result?.findings ?? []`);
(d) when hand-offs grow large, pass summary statistics alongside raw items so
    consumers can route work without parsing everything.

```js
const summary = {
  total: items.length,
  categories: countBy(items, "category"),
  items: items.slice(0, 20),
};
const next = await agent(
  `Triage these findings.\n\n${JSON.stringify(summary, null, 2)}`,
  { label: "triage", schema: TRIAGE },
);
```

## 7. `args`, `cwd`, And `budget`

Pi passes `args` through as supplied to the tool. Parse only if the caller passed
a string:

```js
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
```

Use `cwd` or `process.cwd()` only to tell subagents where they are operating.
The parent workflow should not attempt direct filesystem work.

`budget.total` is `null` when no token target is set. Guard budget-scaled loops:

```js
while (budget.total && budget.remaining() > 50_000 && found.length < 100) {
  const result = await agent("Find more issues not already listed.", {
    schema: ISSUE_BATCH,
  });
  found.push(...(result?.issues ?? []));
}
```

Always include a hard stop: a target count, maximum rounds, dry-streak limit, or
budget guard.

## 8. Trust, Isolation, And Practical Limits

Workflow scripts are trusted orchestration code reviewed before execution. Keep
them simple enough for the user to inspect.

Use worktree isolation when subagents inspect a repository and must not alter the
parent working tree:

```js
const READ_ONLY_WORKTREE = {
  mode: "worktree",
  dirty: "ignore",
  merge: "none",
};
```

Use `dirty: "fail"` when a clean starting point matters. Use `keep: "onError"`
for debugging a failed isolated agent. Automatic merge-back is intentionally not
implemented; return findings and let the parent decide what to apply.

The runtime caps concurrent agents to a bounded number, so large fan-outs queue
rather than all starting at once. Very large scripts are hard for humans to
review; split large reusable knowledge into skill references and keep the
generated workflow script focused.
