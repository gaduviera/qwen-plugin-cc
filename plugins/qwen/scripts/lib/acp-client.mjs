// plugins/qwen/scripts/lib/acp-client.mjs
import readline from "node:readline";

let nextId = 1;

export class AcpClient {
  #proc;
  #rl;
  #pending = new Map(); // id â†’ { resolve, reject }
  #updateHandlers = new Set();
  #serverRequestHandlers = new Map();
  #closed = false;

  constructor(proc) {
    this.#proc = proc;
    this.#rl = readline.createInterface({
      input: proc.stdout,
      crlfDelay: Infinity,
    });
    this.#rl.on("line", (line) => this.#onLine(line));
    proc.on("exit", (code) => this.#onExit(code));
  }

  onUpdate(handler) {
    this.#updateHandlers.add(handler);
    return () => this.#updateHandlers.delete(handler);
  }

  onServerRequest(method, handler) {
    this.#serverRequestHandlers.set(method, handler);
  }

  #onLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    // Notification (no id, has method)
    if (msg.method !== undefined && msg.id === undefined) {
      if (msg.method === "session/update") {
        for (const h of this.#updateHandlers) {
          try {
            h(msg.params);
          } catch {}
        }
      }
      return;
    }

    // Server â†’ client request (has id AND method)
    if (msg.method !== undefined && msg.id !== undefined) {
      const handler = this.#serverRequestHandlers.get(msg.method);
      if (handler) {
        Promise.resolve()
          .then(() => handler(msg.params))
          .then((result) => this.#send({ jsonrpc: "2.0", id: msg.id, result }))
          .catch((err) =>
            this.#send({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32000, message: String(err?.message ?? err) },
            }),
          );
      } else {
        this.#send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: "Method not found" },
        });
      }
      return;
    }

    // Response (has id, no method)
    if (msg.id !== undefined) {
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(msg.error.message);
        // @ts-expect-error
        err.code = msg.error.code;
        // @ts-expect-error
        err.data = msg.error.data;
        pending.reject(err);
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  #onExit(code) {
    if (this.#closed) return;
    this.#closed = true;
    const err = new Error(`ACP process exited unexpectedly (code ${code})`);
    // @ts-expect-error
    err.code = "ACP_PROCESS_EXIT";
    // @ts-expect-error
    err.exitCode = code;
    for (const { reject } of this.#pending.values()) {
      reject(err);
    }
    this.#pending.clear();
  }

  #send(msg) {
    if (this.#closed) return;
    try {
      this.#proc.stdin.write(`${JSON.stringify(msg)}\n`);
    } catch {}
  }

  #request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  #notify(method, params) {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  async initialize() {
    return this.#request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "qwen-companion", version: "1.0.0" },
      clientCapabilities: {},
    });
  }

  async newSession(cwd, mcpServers = []) {
    return this.#request("session/new", { cwd, mcpServers });
  }

  async loadSession(sessionId, cwd) {
    return this.#request("session/load", { sessionId, cwd });
  }

  async prompt(sessionId, parts) {
    return this.#request("session/prompt", {
      sessionId,
      prompt: parts.map((p) => ({ type: "text", text: p.text })),
    });
  }

  cancel(sessionId) {
    this.#notify("session/cancel", { sessionId });
  }

  async setMode(sessionId, modeId) {
    return this.#request("session/set_mode", { sessionId, modeId });
  }

  async setModel(sessionId, modelId) {
    return this.#request("session/set_model", { sessionId, modelId });
  }

  async listSessions(cwd) {
    return this.#request("session/list", { cwd });
  }

  async shutdown(opts = {}) {
    const { phase1Ms = 100, phase2Ms = 1500 } = opts;
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#rl.close();
    } catch {}
    try {
      this.#proc.stdin.end();
    } catch {}
    await new Promise((resolve) => {
      const finish = () => {
        try {
          this.#proc.stdout.destroy();
        } catch {}
        resolve();
      };
      const t1 = setTimeout(() => {
        try {
          this.#proc.kill("SIGTERM");
        } catch {}
        const t2 = setTimeout(() => {
          try {
            this.#proc.kill("SIGKILL");
          } catch {}
          finish();
        }, phase2Ms);
        this.#proc.once("exit", () => {
          clearTimeout(t2);
          finish();
        });
      }, phase1Ms);
      this.#proc.once("exit", () => {
        clearTimeout(t1);
        finish();
      });
    });
  }

  get pid() {
    return this.#proc.pid;
  }
  get exited() {
    return this.#closed;
  }
}

export function installDefaultHandlers(client) {
  client.onServerRequest("fs/read_text_file", async ({ path: filePath }) => {
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(filePath, "utf8");
    return { content };
  });

  client.onServerRequest(
    "fs/write_text_file",
    async ({ path: filePath, content }) => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(filePath, content, "utf8");
      return {};
    },
  );

  client.onServerRequest("session/request_permission", async (_params) => {
    return { approved: false };
  });
}
