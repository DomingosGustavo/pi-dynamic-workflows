# Example Workflows

These are complete Pi workflow scripts intended for copying into the `workflow`
tool's `script` parameter or adapting into a generated workflow.

| File | Shape | Demonstrates |
| --- | --- | --- |
| `repo-audit.js` | fan-out then synthesize | worktree-isolated inspection, cheap workhorse agents, final synthesis |
| `review-branch.js` | pipeline with nested parallel verify | no global barrier between review and verification, structured output |
| `implement-and-review.js` | bounded loop | implementation, structured review, fix rounds, hard loop cap |

All examples should pass `scripts/validate-workflow.mjs`.
