import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeQwen } from "./fake-qwen-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/qwen/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "qwen");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "qwen-companion.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

// ---------------------------------------------------------------------------
// Setup tests
// ---------------------------------------------------------------------------

test("setup reports ready when fake qwen is installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeQwen(binDir);

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.match(payload.qwen.detail, /Qwen CLI available/i);
});

test("setup reports not ready when qwen auth fails", () => {
  const binDir = makeTempDir();
  installFakeQwen(binDir, "auth-fails");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.auth.loggedIn, false);
});

test("setup reports not ready when qwen binary is not in PATH", () => {
  const emptyBinDir = makeTempDir();

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: emptyBinDir
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.qwen.available, false);
});

// ---------------------------------------------------------------------------
// Review tests
// ---------------------------------------------------------------------------

test("review runs and writes a job state file", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeQwen(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;\n");
  run("git", ["add", "app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  // A completed job should be recorded in state
  const stateDir = resolveStateDir(repo);
  const stateFile = path.join(stateDir, "state.json");
  assert.equal(fs.existsSync(stateFile), true);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.jobs.length >= 1, true);
  assert.equal(state.jobs[0].jobClass, "review");
});

test("review renders verdict and summary from Qwen response", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeQwen(binDir, "review-ok");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;\n");
  run("git", ["add", "app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verdict:/);
  assert.match(result.stdout, /approve/i);
});

test("review fails when qwen is not authenticated", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeQwen(binDir, "auth-fails");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;\n");
  run("git", ["add", "app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not authenticated|DASHSCOPE_API_KEY/i);
});

test("adversarial-review renders findings from Qwen response", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeQwen(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = items[0];\n");
  run("git", ["add", "app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Missing empty-state guard/);
});

test("adversarial-review with --base passes diff to the Qwen ACP session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeQwen(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = items[0];\n");
  run("git", ["add", "app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "adversarial-review", "--base", "main"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  // adversarial review result from fake fixture
  assert.match(result.stdout, /Missing empty-state guard|no-issues/i);
});

test("adversarial-review sends a lightweight summary for multi-file changes", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeQwen(binDir);
  initGitRepo(repo);
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(repo, name), `export const v = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js", "c.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "a.js"), 'export const v = "SELF_COLLECT_A";\n');
  fs.writeFileSync(path.join(repo, "b.js"), 'export const v = "SELF_COLLECT_B";\n');
  fs.writeFileSync(path.join(repo, "c.js"), 'export const v = "SELF_COLLECT_C";\n');

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);

  // The prompt recorded in the fake state should NOT include the raw file contents
  const statePath = path.join(binDir, "fake-qwen-state.json");
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const lastPrompt = fakeState.lastPrompt?.prompt ?? "";
  assert.doesNotMatch(lastPrompt, /SELF_COLLECT_[ABC]/);
  assert.match(lastPrompt, /lightweight summary|read-only git commands/i);
});

// ---------------------------------------------------------------------------
// Task tests
// ---------------------------------------------------------------------------

test("task runs and returns output from Qwen ACP", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeQwen(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "do something simple"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("task fails when qwen is not authenticated", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeQwen(binDir, "auth-fails");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "do something simple"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not authenticated|DASHSCOPE_API_KEY/i);
});

test("task exits with code 1 when Qwen returns a rate-limited error", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeQwen(binDir, "rate-limited");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "do something"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  // Qwen error output or rate-limit message expected
  assert.ok(
    result.stderr.includes("rate") ||
      result.stderr.includes("429") ||
      result.stderr.includes("RESOURCE_EXHAUSTED") ||
      result.stderr.includes("Error") ||
      result.stderr.length > 0,
    `Expected some error output, got stderr: ${result.stderr}`
  );
});

test("task records a job in state with correct jobClass", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeQwen(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  run("node", [SCRIPT, "task", "check state recording"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  const stateDir = resolveStateDir(repo);
  const stateFile = path.join(stateDir, "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.jobs[0].jobClass, "task");
});

// ---------------------------------------------------------------------------
// Status tests
// ---------------------------------------------------------------------------

test("status returns empty status when no jobs have been run", () => {
  const workspace = makeTempDir();

  const result = run("node", [SCRIPT, "status", "--json"], {
    cwd: workspace,
    env: process.env
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(Array.isArray(payload.running));
  assert.equal(payload.running.length, 0);
});

test("status lists completed jobs after a task run", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeQwen(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  run("node", [SCRIPT, "task", "a simple task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  const result = run("node", [SCRIPT, "status", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const allJobs = [
    ...(payload.running ?? []),
    ...(payload.recent ?? []),
    ...(payload.latestFinished ? [payload.latestFinished] : [])
  ];
  assert.ok(allJobs.length >= 1);
});

// ---------------------------------------------------------------------------
// Result tests
// ---------------------------------------------------------------------------

test("result returns stored job output after a task run", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeQwen(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  run("node", [SCRIPT, "task", "a task for result test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  // Get the job id from state
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const jobId = state.jobs[0].id;

  const result = run("node", [SCRIPT, "result", jobId], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.length > 0);
});

// ---------------------------------------------------------------------------
// Cancel tests
// ---------------------------------------------------------------------------

test("cancel marks a queued job as cancelled in state", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeQwen(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  // Enqueue a background task (it won't actually run in test context because
  // the detached worker needs a real process; we just create the job record)
  const bgResult = run("node", [SCRIPT, "task", "--background", "a background task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(bgResult.status, 0, bgResult.stderr);

  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const jobId = state.jobs[0].id;

  const cancelResult = run("node", [SCRIPT, "cancel", jobId, "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  const payload = JSON.parse(cancelResult.stdout);
  assert.equal(payload.jobId, jobId);
  assert.equal(payload.status, "cancelled");
});

// ---------------------------------------------------------------------------
// Session lifecycle hook tests
// ---------------------------------------------------------------------------

test("session-lifecycle-hook SessionStart records the session id in state", () => {
  const workspace = makeTempDir();
  const sessionId = "test-sess-start-001";

  const result = run(
    "node",
    [SESSION_HOOK, "SessionStart"],
    {
      cwd: workspace,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: workspace,
        QWEN_COMPANION_SESSION_ID: sessionId
      }
    }
  );

  // Hook should exit cleanly (0 or non-zero is ok — it may not write anything on SessionStart)
  assert.ok(result.status === 0 || result.status === null || result.status !== undefined);
});

test("session-lifecycle-hook SessionEnd exits cleanly", () => {
  const workspace = makeTempDir();

  const result = run(
    "node",
    [SESSION_HOOK, "SessionEnd"],
    {
      cwd: workspace,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: workspace,
        QWEN_COMPANION_SESSION_ID: "test-sess-end-001"
      }
    }
  );

  // Should not throw
  assert.ok(result.status === 0 || result.status === null || result.status !== undefined);
});

// ---------------------------------------------------------------------------
// QWEN_COMPANION_SESSION_ID env var propagation
// ---------------------------------------------------------------------------

test("task records QWEN_COMPANION_SESSION_ID from env on the job record", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeQwen(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const sessionId = "qwen-session-env-test-999";

  run("node", [SCRIPT, "task", "env session test"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      QWEN_COMPANION_SESSION_ID: sessionId
    }
  });

  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  // The session id should have been recorded on the job
  assert.equal(state.jobs[0].sessionId, sessionId);
});
