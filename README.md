# pi-dynamic-workflows

> Claude-Code-style dynamic workflows for [Pi](https://github.com/earendil-works/pi).

A Pi extension that adds a `workflow` tool. Instead of one assistant doing everything sequentially, the model writes a small JavaScript script that fans out the work across many isolated subagents, then synthesizes the results.

Great for codebase audits, multi-perspective review, large refactors, and fan-out research.

Inspired by Anthropic's [dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code).

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

## Usage

Just ask Pi for a workflow in plain language:

```text
Run a workflow to inspect this repository and summarize the main modules.
```

The model will write a workflow script and call the `workflow` tool. Live progress shows up inline:

```text
◆ Workflow: inspect_project (3/3 done) · 42k tok in 31k out 11k $0.0842
  ✓ Scan 1/1
    #1 ✓ repo inventory · anthropic/claude-haiku-4-5 · low · done · 9.2k tok in 7.1k out 2.1k $0.0061
      in: Inspect the repository structure and identify important entry points.
      out: Main code is under src/, with extension entrypoint extensions/workflow.ts.
  ✓ Analyze 2/2
    #2 ✓ source modules · anthropic/claude-sonnet-4-6 · medium · done · 18k tok in 14k out 4.0k $0.0310
      out: The workflow runtime lives in src/workflow.ts and subagents run via src/agent.ts.
    #3 ✓ final summary · anthropic/claude-opus-4-8 · high · done · 15k tok in 10k out 5.0k $0.0471
      out: Prioritized findings include...
```

While a workflow is running, each row can show the requested/resolved model, thinking level, current activity,
tool/prompt/output previews, and token/cost totals as soon as Pi reports them. Token usage may show as pending
while an agent is streaming and becomes exact after the agent finishes.

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
    model: 'anthropic/claude-sonnet-4-6',
    thinkingLevel: 'medium',
    isolation: { mode: 'worktree', dirty: 'ignore', merge: 'none' },
  },
)

return { inventory, summary }
```

Phases are discovered as the script runs, so conditional and loop-created phases work naturally. If a branch is skipped, its phase does not show up as an empty progress row.

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
| `parallel(thunks)` | Run an array of `() => agent(...)` thunks concurrently. Results are returned in input order. |
| `pipeline(items, ...stages)` | Run each item through sequential stages while items fan out. Each stage receives `(prev, original, index)`. |
| `phase(title)` | Mark the current phase. Used for grouping in the live progress view. |
| `log(message)` | Append a workflow-level log line. |
| `args` | Optional JSON value passed in via the tool's `args` parameter. |
| `cwd`, `process.cwd()` | Current working directory for subagents. |
| `budget` | `{ total, spent(), remaining() }` token budget tracker. |

### Trust and isolation

Workflow scripts are trusted orchestration code. Pi parses the first literal `meta` export for display and then runs the JavaScript under Pi's normal session/tool trust model.

The workflow body can use normal JavaScript such as `Date.now()` and `Math.random()`. Static `import`, `require`, and direct `fs` access are still not part of the workflow surface; use subagents and Pi tools for project inspection.

`meta` must stay literal: no spreads, computed keys, template interpolation, or function calls inside `meta`. This keeps upfront metadata parseable before the workflow runs.

Subagents can opt into real Git worktree isolation:

```js
await agent('Audit src/lib/auth.ts for issues.', {
  label: 'security audit',
  model: 'anthropic/claude-sonnet-4-6',
  thinkingLevel: 'high',
  isolation: { mode: 'worktree', dirty: 'ignore', merge: 'none' },
})
```

Worktree isolation creates a temporary Git worktree for that subagent, runs the Pi coding tools in that cwd, captures `git status --short` and `git diff --binary`, then removes the worktree unless `keep` says otherwise. Automatic merge-back is intentionally not implemented.

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
  → workflow tool parses meta + runs trusted orchestration JavaScript
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
