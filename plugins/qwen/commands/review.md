---
description: Run a Qwen code review against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Qwen code review.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Qwen's output verbatim to the user.

Execution mode rules:
- If `--wait` is in the arguments, run in the foreground without asking.
- If `--background` is in the arguments, run in the background without asking.
- Otherwise, estimate the size using `git status --short` and `git diff --shortstat`:
  - Recommend waiting only for 1-2 file diffs. Recommend background for everything else.
  - Use `AskUserQuestion` exactly once with: `Wait for results` and `Run in background`

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" review $ARGUMENTS
```
- Return stdout verbatim. Do not fix any issues mentioned.

Background flow:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" review $ARGUMENTS`,
  description: "Qwen review",
  run_in_background: true
})
```
- Tell the user: "Qwen review started in the background. Check `/qwen:status` for progress."
