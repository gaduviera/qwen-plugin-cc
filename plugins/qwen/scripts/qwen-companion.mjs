#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import {
  collectReviewContext,
  ensureGitRepository,
  resolveReviewTarget,
} from "./lib/git.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
} from "./lib/job-control.mjs";
import { resolveModel } from "./lib/models.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./lib/prompts.mjs";
import {
  getQwenAvailability,
  getQwenLoginStatus,
  interruptSession,
  runReview,
  runTask,
} from "./lib/qwen.mjs";
import {
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
} from "./lib/render.mjs";
import {
  generateJobId,
  getConfig,
  upsertJob,
  writeJobFile,
} from "./lib/state.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/qwen-companion.mjs setup [--json]",
      "  node scripts/qwen-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/qwen-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/qwen-companion.mjs task [--background] [--write] [--model <model|pro|flash|pro-3|flash-3>] [prompt]",
      "  node scripts/qwen-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/qwen-companion.mjs result [job-id] [--json]",
      "  node scripts/qwen-companion.mjs cancel [job-id] [--json]",
    ].join("\n"),
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw?.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {}),
    },
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

// --- Setup ---

async function buildSetupReport(cwd) {
  const nodeAvailable = binaryAvailable("node");
  const npmAvailable = binaryAvailable("npm");
  const qwen = await getQwenAvailability();
  const auth = await getQwenLoginStatus();
  const ready = qwen.available && auth.loggedIn;
  const config = getConfig(resolveWorkspaceRoot(cwd));

  const nextSteps = [];
  if (!qwen.available) {
    nextSteps.push("Install the Qwen CLI: npm install -g @qwen-code/qwen-code");
  }
  if (qwen.available && !auth.loggedIn) {
    nextSteps.push("Configure auth: set DASHSCOPE_API_KEY or run `qwen auth`.");
  }

  return {
    ready,
    node: { detail: nodeAvailable ? "available" : "NOT FOUND" },
    npm: { detail: npmAvailable ? "available" : "NOT FOUND" },
    qwen,
    auth,
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken: [],
    nextSteps,
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"],
  });

  const report = await buildSetupReport(resolveCommandCwd(options));
  outputResult(options.json ? report : renderSetupReport(report), options.json);
}

// --- Qwen readiness guard ---

async function ensureQwenReady(_cwd) {
  const qwen = await getQwenAvailability();
  if (!qwen.available) {
    throw new Error(
      "Qwen CLI is not installed. Install it and rerun `/qwen:setup`.",
    );
  }
  const auth = await getQwenLoginStatus();
  if (!auth.loggedIn) {
    throw new Error(
      "Qwen CLI is not authenticated. Configure DASHSCOPE_API_KEY and retry.",
    );
  }
}

// --- Job infrastructure ---

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "task";
}

function createCompanionJob({
  prefix,
  kind,
  title,
  workspaceRoot,
  jobClass,
  summary,
  write = false,
}) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write,
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile =
    options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id),
    }),
  };
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json,
  });
  const execution = await runTrackedJob(job, () => runner(progress), {
    logFile,
  });
  outputResult(
    options.json ? execution.payload : execution.rendered,
    options.json,
  );
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "qwen-companion.mjs");
  const child = spawn(
    process.execPath,
    [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId],
    {
      cwd,
      env: process.env,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request,
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile,
    },
    logFile,
  };
}

// --- Task ---

function buildTaskRunMetadata({ prompt }) {
  const title = "Qwen Task";
  return {
    title,
    summary: shorten(prompt || "Task"),
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write,
  });
}

function buildTaskRequest({ cwd, model, prompt, write, jobId }) {
  return { cwd, model, prompt, write, jobId };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }
  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

async function executeTaskRun(request) {
  const result = await runTask({
    cwd: request.cwd,
    prompt: request.prompt,
    model: request.model,
    onProgress: request.onProgress,
  });

  const rawOutput = result.output ?? "";
  const payload = {
    status: result.stopReason === "error" ? 1 : 0,
    sessionId: result.sessionId,
    rawOutput,
  };

  return {
    exitStatus: result.stopReason === "error" ? 1 : 0,
    sessionId: result.sessionId,
    payload,
    rendered: rawOutput ? `${rawOutput}\n` : "Task completed.\n",
    summary: firstMeaningfulLine(rawOutput, "Task finished."),
    jobTitle: request.jobTitle ?? "Qwen Task",
    jobClass: "task",
    write: Boolean(request.write),
  };
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "cwd", "prompt-file"],
    booleanOptions: ["json", "write", "background"],
    aliasMap: { m: "model" },
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = resolveModel(options.model);
  const prompt = readTaskPrompt(cwd, options, positionals);
  const write = Boolean(options.write);

  if (!prompt) {
    throw new Error("Provide a prompt, a prompt file, or piped stdin.");
  }

  const taskMetadata = buildTaskRunMetadata({ prompt });

  if (options.background) {
    await ensureQwenReady(cwd);
    const job = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = buildTaskRequest({
      cwd,
      model,
      prompt,
      write,
      jobId: job.id,
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(
      payload,
      `${payload.title} started in the background as ${payload.jobId}. Check /qwen:status ${payload.jobId} for progress.\n`,
      options.json,
    );
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        prompt,
        write,
        jobId: job.id,
        onProgress: progress,
        jobTitle: taskMetadata.title,
      }),
    { json: options.json },
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"],
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const _cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(
      `Stored job ${options["job-id"]} is missing its task request payload.`,
    );
  }

  const { logFile, progress } = createTrackedProgress(
    { ...storedJob, workspaceRoot },
    { logFile: storedJob.logFile ?? null },
  );
  await runTrackedJob(
    { ...storedJob, workspaceRoot, logFile },
    () => executeTaskRun({ ...request, onProgress: progress }),
    { logFile },
  );
}

// --- Review ---

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_INPUT: context.content,
  });
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: `Qwen ${reviewName}`,
    summary: `${reviewName} ${target.label}`,
  };
}

async function executeReviewRun(request) {
  await ensureQwenReady(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope,
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";

  let reviewResult, stopReason;

  if (reviewName === "Review") {
    ({ reviewResult, stopReason } = await runReview({
      cwd: request.cwd,
      reviewTarget: target,
      model: request.model,
      logFile: request.logFile,
      onProgress: request.onProgress,
    }));
  } else {
    const context = collectReviewContext(request.cwd, target);
    const prompt = buildAdversarialReviewPrompt(context, focusText);
    ({ reviewResult, stopReason } = await runReview({
      cwd: request.cwd,
      reviewTarget: target,
      model: request.model,
      focusText,
      systemPrompt: prompt,
      logFile: request.logFile,
      onProgress: request.onProgress,
    }));
  }

  const payload = {
    review: reviewName,
    target,
    reviewResult,
    stopReason,
  };

  const lines = [
    `Verdict: ${reviewResult.verdict}`,
    `Summary: ${reviewResult.summary}`,
  ];
  if (reviewResult.findings?.length > 0) {
    lines.push(`Findings: ${reviewResult.findings.length}`);
    for (const finding of reviewResult.findings) {
      lines.push(`  [${finding.severity}] ${finding.title}`);
    }
  }
  if (reviewResult.next_steps?.length > 0) {
    lines.push("Next steps:");
    for (const step of reviewResult.next_steps) {
      lines.push(`  - ${step}`);
    }
  }
  const rendered = `${lines.join("\n")}\n`;

  return {
    exitStatus: 0,
    payload,
    rendered,
    summary: reviewResult.summary ?? `${reviewName} finished.`,
    jobTitle: `Qwen ${reviewName}`,
    jobClass: "review",
    targetLabel: target.label,
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: { m: "model" },
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope,
  });
  const metadata = buildReviewJobMetadata(config.reviewName, target);

  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary,
  });

  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: resolveModel(options.model),
        focusText,
        reviewName: config.reviewName,
        onProgress: progress,
      }),
    { json: options.json },
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, { reviewName: "Review" });
}

// --- Status ---

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(
    0,
    Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS,
  );
  const pollIntervalMs = Math.max(
    100,
    Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS,
  );
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job?.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job?.status),
    timeoutMs,
  };
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"],
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";

  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"],
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(
      snapshot,
      renderJobStatusReport(snapshot.job),
      options.json,
    );
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(
    options.json ? report : renderStatusReport(report),
    options.json,
  );
}

// --- Result ---

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"],
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = { job, storedJob };
  outputCommandResult(
    payload,
    renderStoredJobResult(job, storedJob),
    options.json,
  );
}

// --- Cancel ---

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"],
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference);
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const sessionId = existing.sessionId ?? job.sessionId ?? null;

  if (sessionId) {
    try {
      await interruptSession(sessionId, { cwd });
      appendLogLine(
        job.logFile,
        `Requested Qwen session interrupt for ${sessionId}.`,
      );
    } catch {
      appendLogLine(job.logFile, "Qwen session interrupt failed.");
    }
  }

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user.",
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt,
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt,
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    sessionInterrupted: Boolean(sessionId),
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

// --- Main ---

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, { reviewName: "Adversarial Review" });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().then(
  () => {
    process.exit(process.exitCode ?? 0);
  },
  (error) => {
    if (error?.code === "RATE_LIMITED" || error?.code === "MODEL_UNAVAILABLE") {
      const lines = [
        `# Qwen Error`,
        ``,
        `Model: ${error.model ?? "unknown"}`,
        `Status: ${error.code === "RATE_LIMITED" ? "rate limited" : "unavailable"}`,
        ``,
        error.message,
      ];
      if (error.suggestions?.length > 0) {
        lines.push(``, `Try instead:`);
        for (const s of error.suggestions) {
          lines.push(`- --model ${s}`);
        }
      }
      process.stderr.write(`${lines.join("\n")}\n`);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
    }
    process.exit(1);
  },
);
