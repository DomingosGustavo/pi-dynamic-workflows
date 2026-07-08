# Model Selection For Pi Workflows

Use exact enabled provider/id references whenever possible. Avoid short aliases
unless the local Pi model registry explicitly documents them.

> **Placeholder refs.** Every `opencode-go/*`, `anthropic/claude-opus-4-8`, and
> `openai-codex/gpt-5.5` ref in this document, the templates, and the examples is
> a **placeholder**. Replace each one with a model ref that is actually enabled
> in the current Pi session's registry before running a workflow. An unknown or
> disabled ref is not an error at parse time: the affected `agent()` branch
> simply fails and returns `null` (with a structured error on its metadata), so a
> workflow full of unknown refs will quietly produce all-`null` results. Confirm
> the refs first.

## Defaults

| Need | Recommended model | Thinking |
| --- | --- | --- |
| High-volume repo scan, summarization, classification | `opencode-go/deepseek-v4-flash` | `low` to `medium` |
| Cheap agentic implementation or exploration | `opencode-go/kimi-k2.7-code` | `medium` to `high` |
| Cheap agentic alternative with broad synthesis | `opencode-go/minimax-m3` | `medium` to `high` |
| Lower-cost reasoning or judge | `opencode-go/glm-5.2` | `xhigh` |
| Frontier judge or critical reasoning | `anthropic/claude-opus-4-8` or enabled GPT 5.5 ref such as `openai-codex/gpt-5.5` | `xhigh` |

## Selection Rules

- Default broad inspection workers to `opencode-go/deepseek-v4-flash`.
- Use `opencode-go/kimi-k2.7-code` for cheap implementation, code navigation,
  and tasks that benefit from agentic persistence.
- Use `opencode-go/minimax-m3` for cheap long-form synthesis or a second agentic
  perspective.
- Use `opencode-go/glm-5.2` with `thinkingLevel: "xhigh"` when the task needs
  reasoning or adversarial judging but does not justify a frontier call.
- Use `anthropic/claude-opus-4-8` or the enabled GPT 5.5 provider/id for
  high-stakes judging, final review, security decisions, or tie-breaking.
- Prefer two independent judges for high-stakes outcomes: one lower-cost
  reasoning judge and one frontier judge, followed by synthesis.
- Leave routine formatting, file inventory, and mechanical classification on
  cheaper workhorse models.

## Example Options

```js
const WORKTREE_READ_ONLY = { mode: "worktree", dirty: "ignore", merge: "none" };

await agent("Inventory source modules and risks.", {
  label: "source inventory",
  model: "opencode-go/deepseek-v4-flash",
  thinkingLevel: "medium",
  isolation: WORKTREE_READ_ONLY,
});

await agent("Implement the smallest safe fix for the failing tests.", {
  label: "implement fix",
  model: "opencode-go/kimi-k2.7-code",
  thinkingLevel: "high",
  isolation: { mode: "worktree", dirty: "patch", merge: "none", keep: "onError" },
});

await agent("Adversarially judge whether this finding is real.", {
  label: "glm judge",
  model: "opencode-go/glm-5.2",
  thinkingLevel: "xhigh",
});

await agent("Independently judge the same finding for release-blocking risk.", {
  label: "frontier judge",
  model: "anthropic/claude-opus-4-8",
  thinkingLevel: "xhigh",
});
```

If GPT 5.5 is the enabled frontier judge in the current environment, use its
exact registry ref, for example:

```js
await agent("Independently judge the same finding for release-blocking risk.", {
  label: "gpt judge",
  model: "openai-codex/gpt-5.5",
  thinkingLevel: "xhigh",
});
```

## Phase Metadata

`meta.phases[].model` is documentation for review readability. It does not set a
runtime model by itself. Always set the actual model on each `agent()` call.

```js
export const meta = {
  name: "review_branch",
  description: "Review and verify branch findings",
  phases: [{ title: "Verify", model: "opencode-go/glm-5.2" }],
};

await agent("Verify the finding.", {
  label: "verify finding",
  phase: "Verify",
  model: "opencode-go/glm-5.2",
  thinkingLevel: "xhigh",
});
```

## Cost Shape

Use many cheap workers and few expensive judges. A common shape is:

1. `deepseek-v4-flash` workers inspect independent areas.
2. `kimi-k2.7-code` or `minimax-m3` synthesizes candidate recommendations.
3. `glm-5.2` and either `claude-opus-4-8` or GPT 5.5 independently judge the
   highest-risk claims.
4. One synthesis agent returns the final structured result.
