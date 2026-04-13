import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "qwen");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("review command is review-only and returns Qwen output verbatim", () => {
  const source = read("commands/review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Qwen's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /review \$ARGUMENTS/);
  assert.match(source, /\[--wait\|--background\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(
    source,
    /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/qwen-companion\.mjs" review \$ARGUMENTS`/
  );
  assert.match(source, /description:\s*"Qwen review"/);
  assert.match(source, /git status|git diff/);
});

test("adversarial-review command is review-only and returns Qwen output verbatim", () => {
  const source = read("commands/adversarial-review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Qwen's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /adversarial-review "\$ARGUMENTS"/);
  assert.match(source, /\[--wait\|--background\].*\[focus \.\.\.\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(
    source,
    /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/qwen-companion\.mjs" adversarial-review "\$ARGUMENTS"`/
  );
  assert.match(source, /description:\s*"Qwen adversarial review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(
    source,
    /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i
  );
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /\/qwen:adversarial-review.*uses the same review target selection as `\/qwen:review`/i);
  assert.match(source, /supports working-tree review, branch review, and `--base <ref>`/i);
  assert.match(source, /does not support `--scope staged` or `--scope unstaged`/i);
  assert.match(source, /can still take extra focus text after the flags/i);
});

test("task command is listed in the plugin (via qwen-companion.mjs usage)", () => {
  const script = fs.readFileSync(
    path.join(PLUGIN_ROOT, "scripts", "qwen-companion.mjs"),
    "utf8"
  );
  assert.match(script, /qwen-companion\.mjs.*task/);
  assert.match(script, /qwen-companion\.mjs.*review/);
  assert.match(script, /qwen-companion\.mjs.*adversarial-review/);
  assert.match(script, /qwen-companion\.mjs.*status/);
  assert.match(script, /qwen-companion\.mjs.*result/);
  assert.match(script, /qwen-companion\.mjs.*cancel/);
});

test("command files cover expected set (no codex commands, no broker)", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md",
    "task.md"
  ]);
});

test("rescue command routes to qwen:qwen-rescue subagent and keeps output verbatim", () => {
  const rescue = read("commands/rescue.md");
  const agent = read("agents/qwen-rescue.md");
  const runtimeSkill = read("skills/qwen-cli-runtime/SKILL.md");

  assert.match(rescue, /The final user-visible response must be Qwen's output verbatim/i);
  assert.match(rescue, /allowed-tools:.*Bash\(node:\*\)/);
  assert.match(rescue, /--background\|--wait/);
  assert.match(rescue, /--resume\|--fresh/);
  assert.match(rescue, /--model/);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.match(rescue, /AskUserQuestion/);
  assert.match(rescue, /Continue current Qwen thread/);
  assert.match(rescue, /Start a new Qwen thread/);
  assert.match(rescue, /run the `qwen:qwen-rescue` subagent in the background/i);
  assert.match(rescue, /default to foreground/i);
  assert.match(rescue, /Do not forward them to `task`/i);
  assert.match(rescue, /Leave `--resume` and `--fresh` in the forwarded request/i);

  assert.match(agent, /--resume/);
  assert.match(agent, /--fresh/);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /prefer foreground for a small, clearly bounded rescue request/i);
  assert.match(
    agent,
    /If the user did not explicitly choose `--background` or `--wait` and the task looks complicated/i
  );
  assert.match(agent, /Use exactly one `Bash` call/i);
  assert.match(
    agent,
    /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i
  );
  assert.match(agent, /Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(agent, /Leave model unset by default/i);
  assert.match(agent, /If the user asks for `pro`, map that to `--model qwen-2\.5-pro`/i);
  assert.match(agent, /If the user asks for `flash`, map that to `--model qwen-2\.5-flash`/i);
  assert.match(agent, /Return the stdout of the `qwen-companion` command exactly as-is/i);
  assert.match(agent, /If the Bash call fails or Qwen cannot be invoked, return nothing/i);
  assert.match(agent, /qwen-prompting/);
  assert.match(agent, /only to tighten the user's request into a better Qwen prompt/i);

  assert.match(runtimeSkill, /only job is to invoke `task` once and return that stdout unchanged/i);
  assert.match(runtimeSkill, /Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(runtimeSkill, /use the `qwen-prompting` skill to rewrite the user's request into a tighter Qwen prompt/i);
  assert.match(runtimeSkill, /That prompt drafting is the only Claude-side work allowed/i);
  assert.match(runtimeSkill, /Leave model unset by default/i);
  assert.match(runtimeSkill, /Map `pro` to `--model qwen-2\.5-pro`/i);
  assert.match(runtimeSkill, /Map `flash` to `--model qwen-2\.5-flash`/i);
  assert.match(
    runtimeSkill,
    /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i
  );
  assert.match(runtimeSkill, /If the Bash call fails or Qwen cannot be invoked, return nothing/i);
});

test("result and cancel commands are deterministic runtime entrypoints", () => {
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");
  const resultHandling = read("skills/qwen-result-handling/SKILL.md");

  assert.match(result, /disable-model-invocation:\s*true/);
  assert.match(result, /qwen-companion\.mjs" result \$ARGUMENTS/);
  assert.match(cancel, /disable-model-invocation:\s*true/);
  assert.match(cancel, /qwen-companion\.mjs" cancel \$ARGUMENTS/);
  assert.match(resultHandling, /do not turn a failed or incomplete Qwen run into a Claude-side implementation attempt/i);
  assert.match(resultHandling, /if Qwen was never successfully invoked, do not generate a substitute answer at all/i);
});

test("internal docs use task terminology for rescue runs and qwen model names", () => {
  const runtimeSkill = read("skills/qwen-cli-runtime/SKILL.md");
  const promptingSkill = read("skills/qwen-prompting/SKILL.md");
  const promptRecipes = read("skills/qwen-prompting/references/qwen-prompt-recipes.md");

  assert.match(runtimeSkill, /qwen-companion\.mjs" task/);
  assert.match(runtimeSkill, /Use `task` for every rescue request/i);
  assert.match(runtimeSkill, /task --resume-last/i);
  assert.match(promptingSkill, /Qwen/i);
  assert.match(promptRecipes, /Qwen/i);
});

test("hooks keep session-start and session-end lifecycle handlers", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /session-lifecycle-hook\.mjs/);
});

test("setup command points users to qwen auth and DASHSCOPE_API_KEY", () => {
  const setup = read("commands/setup.md");

  assert.match(setup, /argument-hint:\s*'\[--enable-review-gate\|--disable-review-gate\]'/);
  assert.match(setup, /AskUserQuestion/);
  assert.match(setup, /qwen-companion\.mjs" setup --json \$ARGUMENTS/);
  assert.match(setup, /DASHSCOPE_API_KEY/);
  assert.match(setup, /qwen auth login/i);
});
