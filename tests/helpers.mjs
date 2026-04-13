import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

export function makeTempDir(prefix = "qwen-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  // Use the absolute node executable path so tests that restrict PATH
  // (e.g. PATH=emptyDir to hide qwen) don't accidentally hide node too.
  const resolved = command === "node" ? process.execPath : command;
  return spawnSync(resolved, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    // On Windows, use shell only for non-absolute commands that aren't standard
    // Node.js/git binaries — those work fine without shell and shell: true breaks
    // paths containing spaces (args get split on the space boundary).
    shell: process.platform === "win32" && !path.isAbsolute(command) && command !== "node" && command !== "git",
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Qwen Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
