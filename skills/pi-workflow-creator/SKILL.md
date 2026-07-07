---
name: pi-workflow-creator
description: Author, review, debug, and adapt runnable `pi-dynamic-workflows` JavaScript workflow scripts for Pi. Use when a user asks to create a workflow, design multi-agent orchestration, fan out work across subagents, choose models/thinking levels for workflow agents, turn a repeatable audit/review/research/implementation process into a workflow, or fix a `.workflow.js` script using `agent()`, `parallel()`, `pipeline()`, `phase()`, structured output schemas, worktree isolation, or the Pi `workflow` tool. Do not use for a one-off single-agent task or merely to run an already-written workflow unchanged.
---

# Pi Workflow Creator

Create Pi workflow scripts that coordinate multiple fresh-context subagents with deterministic JavaScript control flow. A workflow is worth using when the work has a repeatable fan-out, pipeline, loop, or judge pattern and the parent model should make an explicit orchestration plan before spending model calls.

Deep reference material is split by need:

- Read `references/api-reference.md` before using an unfamiliar workflow global, debugging parser/runtime errors, or explaining the exact Pi workflow contract.
- Read `references/patterns.md` when choosing the topology or copying a starter shape.
- Read `references/model-selection.md` before assigning per-agent `model` or `thinkingLevel` options.
- Use `assets/templates/` for minimal starter files and `assets/examples/` for complete worked examples.
- Run `scripts/validate-workflow.mjs <workflow-file.js>` before handing over any workflow file.

## Authoring Procedure

1. Decide whether a workflow is the right tool.
   Use a workflow for many subagents in a fixed shape, especially repository audits, independent research/checks, multi-perspective review, implementation plus review loops, and fan-out/fan-in synthesis. Prefer ordinary tools or a single agent for small linear tasks.

2. Write down the design before coding.
   - **Sizing agents.** One logical sub-task per agent, describable in one or two sentences and a prompt of roughly ≤200 words. Keep one concern per agent (e.g., "security review of src/auth/" not "review security and performance"). If a prompt contains two independent action verbs such as "find bugs and fix them," split it into two agents. When the item count is unknown at design time, use a bounded loop instead of a fixed fan-out.
   - **One responsibility per agent.** A reviewer agent identifies issues; a separate implementer agent applies fixes. Focused tasks make null branches easier to isolate and retry.
   - **Designing phases.** Assign one phase per logical barrier. Each `parallel()` or `pipeline()` group gets its own phase. Use short imperative names such as "Inspect", "Verify", or "Synthesize". Runtime `phase()` calls should match `meta.phases` entries. More than about five phases usually means the topology needs rethinking.

3. Prefer `pipeline()` for multi-stage per-item work.
   `pipeline(items, ...stages)` lets each item advance as soon as it is ready. Use `parallel(thunks)` as a barrier only when the next step needs all previous results together for deduping, merging, scoring, counting, or synthesis. Choose `pipeline()` when items are independent and stages are sequential: fast items are not blocked by slow ones, and one slow stage does not make every other item wait. With many items (more than ~20) and cheap stages, pipeline avoids the barrier tax; if one stage is much slower than others, pipeline lets fast items skip the wait.

4. Choose models deliberately.
   Use enabled provider/id refs, not provider-specific aliases. Default cheap workhorse repo scans to `opencode-go/deepseek-v4-flash`. Use `opencode-go/kimi-k2.7-code` or `opencode-go/minimax-m3` for cheap agentic implementation/exploration. Use `opencode-go/glm-5.2` with `thinkingLevel: "xhigh"` as the lower-cost reasoning/judge alternative. Use a frontier judge such as `anthropic/claude-opus-4-8` or an enabled GPT 5.5 ref such as `openai-codex/gpt-5.5` with `thinkingLevel: "xhigh"` when the judgment is high stakes.

5. Write plain JavaScript with a literal first statement:

```js
export const meta = {
  name: "short_snake_case",
  description: "One-line description shown before execution",
  phases: [{ title: "Inspect" }, { title: "Synthesize" }],
};
```

6. Give every `agent()` a short unique `label`, enough task context, and the right options.
   Use `schema` whenever JavaScript reads fields from an agent result. Use `isolation: { mode: "worktree", dirty: "ignore", merge: "none" }` for project-inspection agents when the parent working tree must remain untouched.

7. Validate before returning.
   Run the bundled validator. Then, when possible, test the script with the Pi workflow tool or a unit harness using `approvalMode: "auto"` only for trusted automation.

## Gotchas

- The Pi workflow tool currently receives `script` directly; it does not invoke saved workflows by name.
- Review artifacts are written under `.pi/workflows/` before execution.
- `args` is passed through as the value supplied to the tool. Parse only if it is a string.
- `parallel()` takes thunks: `items.map((item) => () => agent(...))`, never already-started promises.
- Failed or skipped branches can return `null`; filter before synthesizing.
- The orchestrator should coordinate. Put file reads, shell work, code edits, and repository inspection inside subagents.
- Disjoint file ownership: Parallel mutating agents need disjoint file ownership. If two agents write the same file, the last writer wins. Assign each parallel writer an exclusive directory or file set, or use worktree isolation (dirty: "patch", merge: "none"). Never have parallel agents edit the same source file; if two tasks touch the same file, sequence them.
- Self-contained prompts: Every agent prompt must be self-contained. Subagents start with zero conversational history — no prior turns, tool output, or file cache from the parent. Include file paths, prior findings, and instructions inline. Test: if the prompt would confuse a colleague who just joined the project, it needs more context.
- Implementer/reviewer separation: Never let the same agent implement and then review its own output — it lacks adversarial distance. Use a fresh agent with different instructions and prefer a different model for review (`opencode-go/glm-5.2` with `thinkingLevel: "xhigh"`, or a frontier judge like `anthropic/claude-opus-4-8` / `openai-codex/gpt-5.5` for high stakes).
