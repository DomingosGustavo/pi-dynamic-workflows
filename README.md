# pi-dynamic-workflows

> Dynamic multi-agent workflows for [Pi](https://github.com/earendil-works/pi).

A Pi extension that adds a `workflow` tool. Instead of one assistant doing everything sequentially, the model writes a small JavaScript script that fans out the work across many isolated subagents, then synthesizes the results.

Great for codebase audits, multi-perspective review, large refactors, and fan-out research across whatever model providers your Pi session has enabled.

## Install

```bash
pi install npm:pi-dynamic-workflows
# or from a local checkout
pi install /path/to/pi-dynamic-workflows
```

Then in Pi:

```text
/reload
```

That's it. The extension registers a `workflow` tool and activates it on session start.

## Workflow Creator Skill

This repo includes a Codex skill at `skills/pi-workflow-creator` for designing Pi workflow scripts. Invoke it as
`$pi-workflow-creator` when you want the parent model to choose the workflow topology, model mix, structured output
schemas, and isolation strategy before generating a `workflow` tool script.

The skill includes Pi-specific API docs, orchestration patterns, model-selection guidance, starter templates, worked
examples, and `scripts/validate-workflow.mjs` for checking generated workflow files before running them.

## Usage

Just ask Pi for a workflow in plain language:

```text
Run a workflow to inspect this repository and summarize the main modules.
```

The model will write a workflow script and call the `workflow` tool. Live progress shows up inline:

```text
Workflow ready for review
File: /path/to/repo/.pi/workflows/20260622T220000Z-inspect_project.workflow.js

Approve the confirmation prompt to run this workflow.

◆ Workflow: inspect_project (3/3 done) · 42k tok in 31k out 11k $0.0842
  ✓ Scan 1/1
    #1 ✓ repo inventory · opencode-go/deepseek-v4-flash · low · done · 9.2k tok in 7.1k out 2.1k $0.0061
  ✓ Analyze 2/2
    #2 ✓ source modules · opencode-go/kimi-k2.7-code · medium · done · 18k tok in 14k out 4.0k $0.0310
    #3 ✓ final summary · opencode-go/glm-5.2 · xhigh · done · 15k tok in 10k out 5.0k $0.0471
```

While a workflow is running, each row can show the requested/resolved model, thinking level, current activity,
and token/cost totals as soon as Pi reports them. Token usage may show as pending while an agent is streaming
and becomes exact after the agent finishes. Full prompt, output, and tool metadata is still kept in workflow
details for inspection, but the default inline view stays compact.

Before execution, the generated script is written to `.pi/workflows/` and streamed back with its absolute path
and source code. Interactive sessions must approve the confirmation prompt before any subagent starts. Tests and
trusted automation can construct the tool with `approvalMode: "auto"`.

Press `Esc` to cancel a running workflow. Active subagents are aborted and surfaced as skipped.

## Workflow script shape

A workflow is plain JavaScript. The first statement must export literal metadata. `name` and `description` are required; `phases` is optional documentation for an expected outline. The live progress view is driven by `phase(...)` calls at runtime:

```js
export const meta = {
  name: 'inspect_project',
  description: 'Inspect a repository and summarize the main modules',
  phases: [
    { title: 'Scan' },
    { title: 'Analyze' },
  ],
}

phase('Scan')
const inventory = await agent('Inspect the repository structure.', {
  label: 'repo inventory',
})

phase('Analyze')
const summary = await agent(
  'Summarize the main modules from this inventory:\n' + inventory,
  {
    label: 'module summary',
    model: 'opencode-go/deepseek-v4-flash',
    thinkingLevel: 'medium',
    isolation: { mode: 'worktree', dirty: 'ignore', merge: 'none' },
  },
)

return { inventory, summary }
```

Phases are discovered as the script runs, so conditional and loop-created phases work naturally. If a branch is skipped, its phase does not show up as an empty progress row.

## Workflow design principles

- Size each agent to one focused responsibility describable in a sentence or two; split prompts that contain multiple independent action verbs into separate agents.
- Parallel writers need disjoint file ownership — never let two agents edit the same file. Sequence overlapping edits or use worktree isolation so changes do not collide.
- Use a separate, independent agent (ideally a different model) to review an implementer's work; do not let the same agent implement and then judge its own output.
- Prefer structured JSON hand-offs — put `opts.schema` on the producer and reference named fields in the consumer's prompt — instead of passing raw text dumps between agents.
- Bound every loop with a maximum-rounds cap and a dry-streak break when a round produces no new results.

Worked examples of each principle live in `skills/pi-workflow-creator/references/patterns.md`.

### Editor IntelliSense

Reusable workflow files can opt into editor hints for workflow globals:

```js
/// <reference types="pi-dynamic-workflows/workflow" />
```

This declares `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `cwd`, and `budget` for TypeScript-aware editors.

### Available globals

| Global | Description |
| --- | --- |
| `agent(prompt, opts)` | Spawn a subagent. Returns its final text or, with `opts.schema`, a validated object. |
| `parallel(thunks)` | Run an array of `() => agent(...)` thunks concurrently. Results are returned in input order. Use as a barrier when all results are needed before the next step (synthesis, dedup, ranking). |
| `pipeline(items, ...stages)` | Run each item through sequential stages while items fan out. Each stage receives `(prev, original, index)`. Use as the default multi-stage shape when each item can advance independently. |
| `phase(title)` | Mark the current phase. Used for grouping in the live progress view. |
| `log(message)` | Append a workflow-level log line. |
| `args` | Optional JSON value passed in via the tool's `args` parameter. |
| `cwd`, `process.cwd()` | Current working directory for subagents. |
| `budget` | `{ total, spent(), remaining() }` token budget tracker. |

Failed branches resolve to `null` — filter with `.filter(Boolean)` and log the gaps before passing results downstream.

### Trust and isolation

Workflow scripts are trusted orchestration code. Pi parses the first literal `meta` export for display and then runs the JavaScript under Pi's normal session/tool trust model.

The workflow body can use normal JavaScript such as `Date.now()` and `Math.random()`. Static `import`, `require`, and direct `fs` access are still not part of the workflow surface; use subagents and Pi tools for project inspection.

`meta` must stay literal: no spreads, computed keys, template interpolation, or function calls inside `meta`. This keeps upfront metadata parseable before the workflow runs.

Subagents can opt into real Git worktree isolation:

```js
await agent('Audit src/lib/auth.ts for issues.', {
  label: 'security audit',
  model: 'opencode-go/deepseek-v4-flash',
  thinkingLevel: 'high',
  isolation: { mode: 'worktree', dirty: 'ignore', merge: 'none' },
})
```

Worktree isolation creates a temporary Git worktree for that subagent, runs the Pi coding tools in that cwd, captures `git status --short` and `git diff --binary`, then removes the worktree unless `keep` says otherwise. Automatic merge-back is intentionally not implemented.

The parent model decides the workflow shape, agent count, and model assignment from the current request. The tool
prompt encourages enabled provider/id refs rather than provider-specific aliases: `opencode-go/deepseek-v4-flash`
as the high-volume workhorse, `opencode-go/kimi-k2.7-code` or `opencode-go/minimax-m3` for cheap agentic
implementation/exploration, `opencode-go/glm-5.2` with `thinkingLevel: "xhigh"` as a lower-cost reasoning judge,
and either `anthropic/claude-opus-4-8` or an enabled GPT 5.5 ref such as `openai-codex/gpt-5.5` for frontier
judging.

### Structured subagent output

Pass a JSON Schema via `opts.schema` and the subagent will return a validated object:

```js
const finding = await agent('Find security-sensitive files.', {
  label: 'security scan',
  schema: {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string' } },
      reason: { type: 'string' },
    },
    required: ['paths', 'reason'],
  },
})
```

Under the hood this is a Pi `structured_output` tool with `terminate: true`, so the subagent ends on that call without an extra assistant turn.

## How it works

```text
user prompt
  → Pi model writes a workflow script
  → workflow tool parses meta + writes .pi/workflows review artifact
  → user approves the generated script in interactive sessions
  → workflow tool runs trusted orchestration JavaScript
  → script calls agent(), parallel(), pipeline()
  → each agent() spawns an in-memory Pi subagent session, optionally in a Git worktree
  → snapshots stream back as compact progress
  → final structured result returned to the parent assistant
```

Subagents run in fresh in-memory Pi sessions with the standard coding tools, so they can read files, run shell commands, and call structured output exactly like a normal Pi turn.

## Library modules

| File | Purpose |
| --- | --- |
| `src/workflow.ts` | Literal metadata parser and trusted workflow runtime. |
| `src/workflow-tool.ts` | The Pi `workflow` tool, prompt guidelines, rendering, abort handling. |
| `src/agent.ts` | `WorkflowAgent`, an in-memory Pi subagent runner. |
| `src/worktree.ts` | Opt-in Git worktree isolation for subagents. |
| `src/structured-output.ts` | Terminating structured-output tool backed by TypeBox/JSON Schema. |
| `src/telemetry.ts` | Subagent event/stat summarizers for activity, previews, usage, and context. |
| `src/display.ts` | Workflow snapshots and rich inline text renderers. |
| `extensions/workflow.ts` | The Pi extension entrypoint. |

## Development

```bash
npm install
npm test     # biome check + tsc + unit tests
npm run test:e2e:fintrack  # opt-in live Pi model workflow test against /home/gustavo/fintrack
npm run dev
```

Parser unit tests live in `tests/workflow-parser.test.ts` and cover both accepted and rejected script shapes.

## Status

This is a prototype. It implements the core workflow primitive (script, subagents, parallel/pipeline, phases, abort, structured output) but does not yet implement persisted or resumable runs, or a `/workflows` manager.

## License

MIT
