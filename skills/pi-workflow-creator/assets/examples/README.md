# Example Workflows

These are complete Pi workflow scripts intended for copying into the `workflow`
tool's `script` parameter or adapting into a generated workflow.

| File | Shape | Demonstrates |
| --- | --- | --- |
| `repo-audit.js` | fan-out then synthesize | worktree-isolated inspection, cheap workhorse agents, final synthesis |
| `review-branch.js` | pipeline with nested parallel verify | no global barrier between review and verification, structured output |
| `implement-and-review.js` | bounded loop | implementation, structured review, fix rounds, hard loop cap |

All examples should pass `scripts/validate-workflow.mjs`.

**Model refs are placeholders.** The `opencode-go/*`, `anthropic/claude-opus-4-8`,
and `openai-codex/gpt-5.5` refs in these files must be replaced with refs enabled
in the current Pi session before running. An unknown ref is not a parse error:
the affected `agent()` branch just fails and returns `null` (with a structured
error on its metadata). See `references/model-selection.md`.
