// plugins/qwen/scripts/lib/acp-lifecycle.mjs
import { spawn } from "node:child_process";
import { AcpClient, installDefaultHandlers } from "./acp-client.mjs";

// Cache detected flag per binary to avoid repeated --version calls
const flagCache = new Map();

/**
 * Detect --acp flag for qwen CLI.
 * Qwen supports --acp from 0.14.x onwards (always returns "--acp").
 * @param {string} [binary="qwen"]
 * @returns {Promise<"--acp">}
 */
export async function detectAcpFlag(binary = "qwen") {
  if (flagCache.has(binary)) return flagCache.get(binary);
  const flag = "--acp";
  flagCache.set(binary, flag);
  return flag;
}

/** Clear the flag cache (for testing). */
export function clearFlagCache() {
  flagCache.clear();
}

/**
 * Spawn a new qwen --acp process, complete the initialize handshake, return connected AcpClient.
 * @param {object} [opts]
 * @param {string} [opts.binary="qwen"]
 * @param {string} [opts.cwd]
 * @param {Record<string,string>} [opts.env]
 * @returns {Promise<AcpClient>}
 */
export async function spawnAcpClient(opts = {}) {
  const binary = opts.binary ?? "qwen";
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;

  const flag = await detectAcpFlag(binary);

  const proc = spawn(binary, [flag], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "inherit"],
    shell: process.platform === "win32",
    windowsHide: true,
  });

  const client = new AcpClient(proc);
  installDefaultHandlers(client);

  const initTimeout = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error("ACP initialize timed out after 30s")),
      30000,
    ),
  );
  await Promise.race([client.initialize(), initTimeout]);

  return client;
}

/**
 * Check whether the ACP process is still alive.
 * @param {AcpClient} client
 * @returns {boolean}
 */
export function isAlive(client) {
  if (client.exited) return false;
  try {
    process.kill(client.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn, initialize, create a new session, set mode (and model if provided).
 * Returns { client, sessionId }.
 * @param {object} [opts]
 * @param {string} [opts.binary]
 * @param {string} [opts.cwd]
 * @param {Record<string,string>} [opts.env]
 * @param {string} [opts.modeId="default"]
 * @param {string} [opts.model]
 */
export async function createSession(opts = {}) {
  const client = await spawnAcpClient(opts);
  const cwd = opts.cwd ?? process.cwd();
  const { sessionId } = await client.newSession(cwd, []);

  const modeId = opts.modeId ?? "default";
  await client.setMode(sessionId, modeId);

  if (opts.model) {
    await client.setModel(sessionId, opts.model);
  }

  return { client, sessionId };
}

/**
 * Load an existing session into a fresh ACP process (used for crash recovery).
 * Returns { client, sessionId }.
 * @param {string} sessionId
 * @param {object} [opts]
 */
export async function resumeSession(sessionId, opts = {}) {
  const client = await spawnAcpClient(opts);
  const cwd = opts.cwd ?? process.cwd();
  await client.loadSession(sessionId, cwd);
  return { client, sessionId };
}
