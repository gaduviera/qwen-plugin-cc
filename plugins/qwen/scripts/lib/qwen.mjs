import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSession,
  resumeSession,
  spawnAcpClient,
} from "./acp-lifecycle.mjs";
import { binaryAvailable, runCommand } from "./process.mjs";
import { appendLogBlock, appendLogLine } from "./tracked-jobs.mjs";

const PLUGIN_LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = path.resolve(PLUGIN_LIB_DIR, "..", "..", "schemas");
const REVIEW_SCHEMA_PATH = path.join(SCHEMAS_DIR, "review-output.schema.json");

export async function getQwenAvailability() {
  const available = binaryAvailable("qwen");
  if (!available) {
    return { available: false, detail: "qwen CLI not found in PATH." };
  }
  const result = runCommand("qwen", ["--version"], { timeoutMs: 2000 });
  const version = result.status === 0 ? result.stdout.trim() : "unknown";
  return { available: true, version, detail: "Qwen CLI available." };
}

export async function getQwenLoginStatus() {
  try {
    const authResult = runCommand("qwen", ["auth", "status"], {
      timeoutMs: 5000,
    });
    if (authResult.status === 0) {
      return {
        loggedIn: true,
        detail: "Logged in via OAuth.",
      };
    }
    return {
      loggedIn: false,
      detail: "Not authenticated. Run qwen auth login or set DASHSCOPE_API_KEY.",
    };
  } catch {
    const result = runCommand("qwen", ["--version"], { timeoutMs: 3000 });
    if (result.status !== 0) {
      return { loggedIn: false, detail: "qwen CLI not responding." };
    }
    return {
      loggedIn: true,
      detail: "Auth assumed configured (DASHSCOPE_API_KEY or ADC).",
    };
  }
}

/**
 * Run a task via Qwen ACP.
 * @param {object} options
 * @param {string} options.cwd
 * @param {string} options.prompt
 * @param {string} [options.model]
 * @param {string} [options.modeId="default"]
 * @param {string} [options.resumeSessionId]
 * @param {string} [options.logFile]
 * @param {Function} [options.onProgress]
 * @param {object} [options.env]
 * @returns {Promise<{sessionId: string, output: string, stopReason: string}>}
 */
// @ts-expect-error
export async function runTask(options = {}) {
  const {
    cwd = process.cwd(),
    prompt,
    model,
    modeId = "default",
    resumeSessionId,
    logFile,
    onProgress,
    env = process.env,
  } = options;

  let client, sessionId;

  if (resumeSessionId) {
    ({ client, sessionId } = await resumeSession(resumeSessionId, {
      cwd,
      model,
      env,
    }));
  } else {
    ({ client, sessionId } = await createSession({ cwd, model, modeId, env }));
  }

  const chunks = [];

  const removeUpdate = client.onUpdate((params) => {
    if (params?.sessionId !== sessionId) return;
    const update = params.update;
    if (!update) return;
    if (
      update.sessionUpdate === "agent_message_chunk" &&
      update.content?.text
    ) {
      chunks.push(update.content.text);
      appendLogLine(logFile, update.content.text);
      onProgress?.({ message: update.content.text, phase: "streaming" });
    } else if (update.sessionUpdate === "tool_call") {
      const toolName = update.name ?? "tool";
      appendLogLine(logFile, `[tool_call] ${toolName}`);
      onProgress?.({ message: `Running: ${toolName}`, phase: "tool_call" });
    }
  });

  // Default: approve permissions in non-plan modes
  if (modeId !== "plan") {
    client.onServerRequest("session/request_permission", async (p) => {
      appendLogLine(logFile, `[permission] approved: ${p?.description ?? ""}`);
      return { approved: true };
    });
  }

  let result;
  try {
    result = await client.prompt(sessionId, [{ type: "text", text: prompt }]);
  } catch (err) {
    removeUpdate();
    await client.shutdown();

    const msg = err?.message ?? String(err);
    const isRateLimit = /429|RESOURCE_EXHAUSTED|capacity|rate.limit/i.test(msg);
    if (isRateLimit) {
      const modelLabel = model ?? "default";
      const suggestions = [];
      const structured = /** @type {any} */ (
        new Error(`Model "${modelLabel}" hit rate limits after retries.`)
      );
      structured.code = "RATE_LIMITED";
      structured.model = modelLabel;
      structured.suggestions = suggestions;
      throw structured;
    }

    const isMalformed = /malformed function call/i.test(msg);
    if (isMalformed) {
      const modelLabel = model ?? "default";
      const suggestions = [];
      const structured = /** @type {any} */ (
        new Error(
          `Model "${modelLabel}" returned malformed output (not supported for ACP tasks).`,
        )
      );
      structured.code = "MODEL_UNAVAILABLE";
      structured.model = modelLabel;
      structured.suggestions = suggestions;
      throw structured;
    }

    throw err;
  }

  removeUpdate();
  await client.shutdown();

  return {
    sessionId,
    output: chunks.join(""),
    stopReason: result?.stopReason ?? "unknown",
  };
}

/**
 * Run a code review via Qwen ACP.
 * Builds a review prompt from git diff, sends via runTask, validates response.
 * @param {object} options
 * @param {string} options.cwd
 * @param {object} options.reviewTarget  from resolveReviewTarget()
 * @param {string} [options.systemPrompt]
 * @param {string} [options.focusText]
 * @param {string} [options.model]
 * @param {string} [options.logFile]
 * @param {Function} [options.onProgress]
 * @param {object} [options.env]
 * @returns {Promise<{reviewResult: object, stopReason: string}>}
 */
// @ts-expect-error
export async function runReview(options = {}) {
  const {
    cwd = process.cwd(),
    reviewTarget,
    systemPrompt,
    focusText,
    model,
    logFile,
    onProgress,
    env = process.env,
  } = options;

  const reviewPrompt = buildReviewPrompt(reviewTarget, systemPrompt, focusText);

  const { output, stopReason } = await runTask({
    cwd,
    prompt: reviewPrompt,
    model,
    modeId: "default",
    logFile,
    onProgress,
    env,
  });

  appendLogBlock(logFile, "Review output", output);

  const reviewResult = parseReviewOutput(output);
  return { reviewResult, stopReason };
}

function buildReviewPrompt(reviewTarget, systemPrompt, focusText) {
  const parts = [];
  if (systemPrompt) parts.push(systemPrompt);
  if (reviewTarget?.diff) {
    parts.push(
      `\n\nGit diff to review:\n\`\`\`diff\n${reviewTarget.diff}\n\`\`\``,
    );
  }
  if (focusText) {
    parts.push(`\n\nAdditional focus: ${focusText}`);
  }
  parts.push(
    `\n\nRespond with ONLY valid JSON matching this schema — no prose, no markdown fences:\n{"verdict":"no-issues"|"needs-attention"|"no-ship","summary":"...","findings":[{"severity":"critical|high|medium|low","title":"...","body":"...","file":"...","line_start":N,"recommendation":"..."}],"next_steps":["..."]}`,
  );
  return parts.join("");
}

/**
 * Parse and validate Qwen review output. Fails closed on any validation failure.
 * @param {string} raw
 * @returns {object} Normalized review result
 */
export function parseReviewOutput(raw) {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    const e = new Error(`Review output is not valid JSON: ${err.message}`);
    // @ts-expect-error
    e.code = "REVIEW_PARSE_ERROR";
    // @ts-expect-error
    e.raw = raw;
    throw e;
  }

  const schema = JSON.parse(fs.readFileSync(REVIEW_SCHEMA_PATH, "utf8"));
  const validationError = validateAgainstSchema(parsed, schema);
  if (validationError) {
    const e = new Error(`Review output failed validation: ${validationError}`);
    // @ts-expect-error
    e.code = "REVIEW_VALIDATION_ERROR";
    // @ts-expect-error
    e.parsed = parsed;
    throw e;
  }

  return normalizeReviewResult(parsed);
}

function validateAgainstSchema(data, schema) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object.";
  }
  for (const field of schema.required ?? []) {
    if (!(field in data)) return `Missing required field: "${field}"`;
  }
  const verdictEnum = schema.properties?.verdict?.enum;
  if (verdictEnum && !verdictEnum.includes(data.verdict)) {
    return `Invalid verdict "${data.verdict}". Expected one of: ${verdictEnum.join(", ")}`;
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    return '"summary" must be a non-empty string.';
  }
  if (!Array.isArray(data.findings)) return '"findings" must be an array.';
  if (!Array.isArray(data.next_steps)) return '"next_steps" must be an array.';
  return null;
}

function normalizeReviewResult(data) {
  return {
    verdict: data.verdict.trim(),
    summary: data.summary.trim(),
    findings: data.findings.map((f, i) => ({
      severity: typeof f.severity === "string" ? f.severity : "low",
      title:
        typeof f.title === "string" && f.title.trim()
          ? f.title.trim()
          : `Finding ${i + 1}`,
      body: typeof f.body === "string" ? f.body.trim() : "",
      file: typeof f.file === "string" ? f.file.trim() : "unknown",
      line_start:
        Number.isInteger(f.line_start) && f.line_start > 0
          ? f.line_start
          : null,
      line_end:
        Number.isInteger(f.line_end) && f.line_end > 0 ? f.line_end : null,
      recommendation:
        typeof f.recommendation === "string" ? f.recommendation.trim() : "",
    })),
    next_steps: data.next_steps
      .filter((s) => typeof s === "string" && s.trim())
      .map((s) => s.trim()),
  };
}

/**
 * Cancel a running session by spawning a fresh short-lived ACP process.
 */
export async function interruptSession(sessionId, opts = {}) {
  const { cwd = process.cwd(), env = process.env } = opts;
  const client = await spawnAcpClient({ cwd, env });
  client.cancel(sessionId);
  // Give it a moment to deliver, then shut down
  await new Promise((r) => setTimeout(r, 200));
  await client.shutdown({ phase1Ms: 0, phase2Ms: 500 });
}
