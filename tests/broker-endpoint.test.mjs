/**
 * ACP protocol smoke tests.
 *
 * The Qwen plugin does NOT use the Codex broker/pipe infrastructure.
 * This file replaces the old broker-endpoint.test.mjs with basic
 * sanity checks on the ACP client module that the Qwen plugin actually uses.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeTempDir, writeExecutable } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ACP_CLIENT_PATH = path.join(
  ROOT,
  "plugins",
  "qwen",
  "scripts",
  "lib",
  "acp-client.mjs"
);

// ---------------------------------------------------------------------------
// Import-level sanity: AcpClient and installDefaultHandlers are exported
// ---------------------------------------------------------------------------

test("AcpClient and installDefaultHandlers are exported from acp-client.mjs", async () => {
  const mod = await import(pathToFileURL(ACP_CLIENT_PATH).href);
  assert.equal(typeof mod.AcpClient, "function", "AcpClient should be a class/function");
  assert.equal(
    typeof mod.installDefaultHandlers,
    "function",
    "installDefaultHandlers should be a function"
  );
});

// ---------------------------------------------------------------------------
// AcpClient speaks JSON-RPC 2.0 over stdio
// ---------------------------------------------------------------------------

test("AcpClient sends initialize JSON-RPC request and resolves on response", async () => {
  const binDir = makeTempDir();

  // A minimal echo ACP server: replies to initialize with { serverInfo: "test" }
  const serverSrc = `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: { serverInfo: "test-acp-server", protocolVersion: 1 }
    }) + "\\n");
  }
});
`;

  const serverPath = path.join(binDir, "test-acp-server.js");
  writeExecutable(serverPath, serverSrc);

  const proc = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "inherit"]
  });

  const { AcpClient } = await import(pathToFileURL(ACP_CLIENT_PATH).href);
  const client = new AcpClient(proc);

  const result = await client.initialize();
  assert.equal(result.serverInfo, "test-acp-server");

  await client.shutdown({ phase1Ms: 0, phase2Ms: 200 });
});

test("AcpClient surfaces JSON-RPC error responses as rejected promises", async () => {
  const binDir = makeTempDir();

  const serverSrc = `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  // Always reply with an error
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id: msg.id,
    error: { code: -32601, message: "Method not found" }
  }) + "\\n");
});
`;

  const serverPath = path.join(binDir, "test-acp-error-server.js");
  writeExecutable(serverPath, serverSrc);

  const proc = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "inherit"]
  });

  const { AcpClient } = await import(pathToFileURL(ACP_CLIENT_PATH).href);
  const client = new AcpClient(proc);

  await assert.rejects(
    () => client.initialize(),
    (err) => {
      assert.match(err.message, /Method not found/);
      return true;
    }
  );

  await client.shutdown({ phase1Ms: 0, phase2Ms: 200 });
});

test("AcpClient delivers session/update notifications to onUpdate handlers", async () => {
  const binDir = makeTempDir();

  const serverSrc = `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    // Emit a session/update notification before replying
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "sess_test", update: { sessionUpdate: "agent_message_chunk", content: { text: "hello" } } }
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: { serverInfo: "notify-server", protocolVersion: 1 }
    }) + "\\n");
  }
});
`;

  const serverPath = path.join(binDir, "test-acp-notify-server.js");
  writeExecutable(serverPath, serverSrc);

  const proc = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "inherit"]
  });

  const { AcpClient } = await import(pathToFileURL(ACP_CLIENT_PATH).href);
  const client = new AcpClient(proc);

  const received = [];
  client.onUpdate((params) => {
    received.push(params);
  });

  await client.initialize();

  assert.ok(received.length >= 1, "Should have received at least one update");
  assert.equal(received[0].sessionId, "sess_test");
  assert.equal(received[0].update?.content?.text, "hello");

  await client.shutdown({ phase1Ms: 0, phase2Ms: 200 });
});
