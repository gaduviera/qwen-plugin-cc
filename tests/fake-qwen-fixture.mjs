import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

/**
 * Install a fake `qwen` binary in binDir.
 *
 * Supported behaviors:
 *   "review-ok"          – default; returns a clean review JSON
 *   "adversarial-ok"     – returns a review with one finding
 *   "adversarial-clean"  – returns a clean adversarial review JSON
 *   "auth-fails"         – qwen auth status exits 1; no DASHSCOPE fallback
 *   "rate-limited"       – prompt call returns a 429-style error
 *   "invalid-json"       – prompt returns non-JSON text
 *   "slow-task"          – prompt resolves after 400 ms
 *
 * The fake binary:
 *   • responds to `qwen --version` (exit 0, version string)
 *   • responds to `qwen auth status` (exit 0 or 1 per behavior)
 *   • when called with `--acp`, spawns an in-process ACP server
 *     that speaks JSON-RPC 2.0 over stdio (one JSON object per line).
 *
 * ACP methods implemented:
 *   initialize        → { serverInfo: "fake-qwen" }
 *   session/new       → { sessionId: "sess_1" }
 *   session/load      → {}
 *   session/set_mode  → {}
 *   session/set_model → {}
 *   session/list      → { sessions: [] }
 *   session/prompt    → emits session/update notifications, then returns { stopReason: "end_turn" }
 *   session/cancel    → (notification, no reply)
 */
export function installFakeQwen(binDir, behavior = "review-ok") {
  const statePath = path.join(binDir, "fake-qwen-state.json");

  // ---------- Node.js ACP server source (embedded string) ----------
  const acpServerSource = `#!/usr/bin/env node
const readline = require("node:readline");
const fs = require("node:fs");

const STATE_PATH = ${JSON.stringify(statePath)};
const BEHAVIOR = ${JSON.stringify(behavior)};

let nextSessionIdx = 1;
const sessions = {};

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { prompts: [], acpStarts: 0 };
  }
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); }
  catch { return { prompts: [], acpStarts: 0 }; }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}

function sendNotification(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function sendReply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function buildReviewJson(adversarial) {
  if (BEHAVIOR === "adversarial-clean" || (!adversarial && BEHAVIOR === "review-ok")) {
    return JSON.stringify({
      verdict: "approve",
      summary: "No material issues found.",
      findings: [],
      next_steps: []
    });
  }
  // adversarial with a finding
  return JSON.stringify({
    verdict: "needs-attention",
    summary: "One adversarial concern surfaced.",
    findings: [
      {
        severity: "high",
        title: "Missing empty-state guard",
        body: "The change assumes data is always present.",
        file: "src/app.js",
        line_start: 4,
        line_end: 6,
        confidence: 0.87,
        recommendation: "Handle empty collections before indexing."
      }
    ],
    next_steps: ["Add an empty-state test."]
  });
}

function isReviewPrompt(prompt) {
  // Detect review prompts by the JSON schema contract appended by qwen.mjs buildReviewPrompt
  return prompt.includes('"verdict"') && prompt.includes('"findings"') && prompt.includes('"next_steps"');
}

function buildTaskOutput(prompt) {
  if (prompt.includes("adversarial software review")) {
    return buildReviewJson(true);
  }
  if (isReviewPrompt(prompt)) {
    return buildReviewJson(false);
  }
  if (BEHAVIOR === "rate-limited") {
    throw Object.assign(new Error("429 RESOURCE_EXHAUSTED capacity exceeded"), { code: 429 });
  }
  if (BEHAVIOR === "invalid-json") {
    return "not valid json output";
  }
  return "Handled the requested task.\\nTask prompt accepted.";
}

function emitChunksAndReply(id, sessionId, text, delayMs) {
  const doEmit = () => {
    // emit a session/update notification with the full text chunk
    sendNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { text }
      }
    });
    sendReply(id, { stopReason: "end_turn" });
  };
  if (delayMs > 0) {
    setTimeout(doEmit, delayMs);
  } else {
    doEmit();
  }
}

const state = loadState();
state.acpStarts = (state.acpStarts || 0) + 1;
saveState(state);

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // notifications (no id) – e.g. session/cancel
  if (msg.id === undefined) return;

  const state2 = loadState();

  try {
    switch (msg.method) {
      case "initialize":
        sendReply(msg.id, { serverInfo: "fake-qwen-acp", protocolVersion: 1 });
        break;

      case "session/new": {
        const sessionId = "sess_" + nextSessionIdx++;
        sessions[sessionId] = { cwd: msg.params?.cwd ?? process.cwd() };
        sendReply(msg.id, { sessionId });
        break;
      }

      case "session/load":
        sendReply(msg.id, {});
        break;

      case "session/set_mode":
        sendReply(msg.id, {});
        break;

      case "session/set_model":
        sendReply(msg.id, {});
        break;

      case "session/list":
        sendReply(msg.id, { sessions: [] });
        break;

      case "session/prompt": {
        const sessionId = msg.params?.sessionId;
        const parts = msg.params?.prompt ?? [];
        const prompt = parts.filter(p => p.type === "text").map(p => p.text).join("\\n");

        state2.prompts = state2.prompts || [];
        state2.lastPrompt = { sessionId, prompt };
        state2.prompts.push({ sessionId, prompt });
        saveState(state2);

        if (BEHAVIOR === "rate-limited") {
          sendError(msg.id, -32000, "429 RESOURCE_EXHAUSTED capacity exceeded");
          break;
        }

        let output;
        try {
          output = buildTaskOutput(prompt);
        } catch (err) {
          sendError(msg.id, -32000, err.message);
          break;
        }

        const delay = BEHAVIOR === "slow-task" ? 400 : 0;
        emitChunksAndReply(msg.id, sessionId, output, delay);
        break;
      }

      default:
        sendError(msg.id, -32601, "Method not found: " + msg.method);
    }
  } catch (err) {
    sendError(msg.id, -32000, err.message);
  }
});
`;

  // ---------- wrapper shell script (Unix) ----------
  const shellScript = `#!/usr/bin/env node
const { spawnSync, spawn } = require("node:child_process");
const process = require("node:process");
const path = require("node:path");
const fs = require("node:fs");

const args = process.argv.slice(2);
const BEHAVIOR = ${JSON.stringify(behavior)};

// Write the ACP server script on demand
const serverScript = path.join(${JSON.stringify(binDir)}, "_qwen_acp_server.js");
if (!fs.existsSync(serverScript)) {
  fs.writeFileSync(serverScript, ${JSON.stringify(acpServerSource)}, "utf8");
}

if (args[0] === "--version") {
  process.stdout.write("fake-qwen 0.14.0\\n");
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "status") {
  if (BEHAVIOR === "auth-fails") {
    process.stderr.write("not authenticated\\n");
    process.exit(1);
  }
  process.stdout.write("logged in\\n");
  process.exit(0);
}

if (args[0] === "auth") {
  process.exit(0);
}

if (args[0] === "--acp") {
  // Spawn the ACP server as a child inheriting our stdio
  const child = spawn(process.execPath, [serverScript], {
    stdio: "inherit"
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  return;
}

process.stderr.write("Unknown qwen command: " + args.join(" ") + "\\n");
process.exit(1);
`;

  writeExecutable(path.join(binDir, "qwen"), shellScript);

  // On Windows, create a .cmd wrapper so the binary is found via PATH with shell:true
  if (process.platform === "win32") {
    const cmdWrapper = `@echo off\r\nnode "%~dp0qwen" %*\r\n`;
    fs.writeFileSync(path.join(binDir, "qwen.cmd"), cmdWrapper, { encoding: "utf8" });
  }

  // Pre-write the ACP server script so it is ready immediately
  fs.writeFileSync(path.join(binDir, "_qwen_acp_server.js"), acpServerSource, { encoding: "utf8" });
}

/** Build a PATH-prepended env for a child process. */
export function buildEnv(binDir) {
  const sep = process.platform === "win32" ? ";" : ":";
  return {
    ...process.env,
    PATH: `${binDir}${sep}${process.env.PATH}`
  };
}
